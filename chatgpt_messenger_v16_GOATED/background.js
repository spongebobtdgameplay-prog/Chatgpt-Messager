"use strict";

const TARGET_CONVERSATION_URL = "https://chatgpt.com/";
const runtime = (typeof browser !== "undefined") ? browser.runtime : chrome.runtime;
const tabs = (typeof browser !== "undefined") ? browser.tabs : chrome.tabs;
const scripting = (typeof browser !== "undefined") ? browser.scripting : chrome.scripting;
const storage = (typeof browser !== "undefined") ? browser.storage.local : chrome.storage.local;
const windowsApi = (typeof browser !== "undefined") ? browser.windows : chrome.windows;
const actionApi = (typeof browser !== "undefined")
    ? (browser.action || browser.browserAction)
    : (chrome.action || chrome.browserAction);

const CONVERSATION_STATE_KEY = "chatgpt_messenger_v16_conversation_state";
const LEGACY_CONVERSATION_STATE_KEY = "chatgpt_messenger_v15_conversation_state";
const TARGET_TAB_KEY = "chatgpt_messenger_v16_target_tab_id";
const LEGACY_TARGET_TAB_KEY = "chatgpt_messenger_v15_target_tab_id";
const MESSENGER_WINDOW_URL = runtime.getURL("popup.html");

function apiCall(api, method, ...args) {
    if (typeof browser !== "undefined") {
        try {
            return Promise.resolve(api[method](...args));
        } catch (error) {
            return Promise.reject(error);
        }
    }

    return new Promise((resolve, reject) => {
        try {
            api[method](...args, result => {
                const error = runtime.lastError;
                if (error) reject(new Error(error.message));
                else resolve(result);
            });
        } catch (error) {
            reject(error);
        }
    });
}

function getRouteConversationId(url) {
    try {
        const path = new URL(url).pathname;
        const match = path.match(/\/c\/([^/]+)/);
        return match ? decodeURIComponent(match[1]) : null;
    } catch (_) {
        return null;
    }
}

if (actionApi?.onClicked) {
    actionApi.onClicked.addListener(async tab => {
        try {
            if (tab?.id != null && (tab.url || "").startsWith("https://chatgpt.com/")) {
                await apiCall(storage, "set", { [TARGET_TAB_KEY]: tab.id });
            }

            const existingWindows = await apiCall(windowsApi, "getAll", { populate: true });
            const existing = existingWindows.find(win =>
                (win.tabs || []).some(item => item.url === MESSENGER_WINDOW_URL)
            );

            if (existing) {
                await apiCall(windowsApi, "update", existing.id, { focused: true });
            } else {
                await apiCall(windowsApi, "create", {
                    url: MESSENGER_WINDOW_URL,
                    type: "popup",
                    width: 440,
                    height: 820,
                    focused: true
                });
            }
        } catch (error) {
            console.error("ChatGPT Messenger window error:", error);
        }
    });
}

tabs.onActivated.addListener(({ tabId }) => {
    apiCall(tabs, "get", tabId).then(tab => {
        if ((tab.url || "").startsWith("https://chatgpt.com/")) {
            return apiCall(storage, "set", { [TARGET_TAB_KEY]: tabId });
        }
    }).catch(() => {});
});

tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (!changeInfo.url || !changeInfo.url.startsWith("https://chatgpt.com/")) return;
    apiCall(storage, "set", { [TARGET_TAB_KEY]: tabId }).catch(() => {});
    if (!getRouteConversationId(changeInfo.url)) {
        apiCall(storage, "get", CONVERSATION_STATE_KEY).then(saved => {
            const state = saved?.[CONVERSATION_STATE_KEY];
            if (state?.tabId === tabId) {
                return apiCall(storage, "set", { [CONVERSATION_STATE_KEY]: null });
            }
        }).catch(() => {});
    }
});

runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "getStatus") {
        findActiveChatGPTTab().then(tab => sendResponse({ ok: !!tab }))
            .catch(() => sendResponse({ ok: false }));
        return true;
    }

    if (request.action === "forceSync" || request.action === "openTab") {
        findActiveChatGPTTab().then(async tab => {
            if (tab) {
                await apiCall(tabs, "update", tab.id, { active: true });
            } else {
                tab = await apiCall(tabs, "create", { url: TARGET_CONVERSATION_URL, active: true });
            }
            await apiCall(storage, "set", { [TARGET_TAB_KEY]: tab.id });
            sendResponse({ success: true, tabId: tab.id });
        }).catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }

    if (request.action === "startNewConversation") {
        startNewConversation()
            .then(result => sendResponse({ success: true, ...result }))
            .catch(error => sendResponse({ success: false, error: error.message }));
        return true;
    }

    if (request.action === "sendViaNetworkProxy") {
        handleNetworkProxyExecution(request.payload)
            .then(result => sendResponse({ success: true, ...result }))
            .catch(error => sendResponse({ success: false, error: error.message }));
        return true;
    }
});

async function getChatGPTTabById(tabId) {
    if (tabId == null) return null;
    try {
        const tab = await apiCall(tabs, "get", tabId);
        return (tab?.url || "").startsWith("https://chatgpt.com/") ? tab : null;
    } catch (_) {
        return null;
    }
}

async function findActiveChatGPTTab(preferredTabId = null) {
    // Prefer the tab already associated with this conversation: no broad tab scan.
    const conversationTab = await getChatGPTTabById(preferredTabId);
    if (conversationTab) return conversationTab;

    const stored = await apiCall(storage, "get", [TARGET_TAB_KEY, LEGACY_TARGET_TAB_KEY]);
    const storedId = stored?.[TARGET_TAB_KEY] ?? stored?.[LEGACY_TARGET_TAB_KEY];
    const storedTab = await getChatGPTTabById(storedId);
    if (storedTab) {
        if (stored?.[TARGET_TAB_KEY] !== storedTab.id) {
            await apiCall(storage, "set", { [TARGET_TAB_KEY]: storedTab.id });
        }
        return storedTab;
    }

    const allTabs = await apiCall(tabs, "query", { url: "https://chatgpt.com/*" });
    return allTabs.find(tab => tab.active) || allTabs[0] || null;
}

function waitForTabReady(tabId, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
        let settled = false;
        let timeoutId = null;

        const cleanup = () => {
            tabs.onUpdated.removeListener(onUpdated);
            if (timeoutId !== null) clearTimeout(timeoutId);
        };
        const finish = error => {
            if (settled) return;
            settled = true;
            cleanup();
            if (error) reject(error);
            else resolve();
        };
        const onUpdated = (updatedTabId, changeInfo, updatedTab) => {
            if (updatedTabId === tabId &&
                (changeInfo.status === "complete" || updatedTab?.status === "complete")) {
                finish();
            }
        };

        tabs.onUpdated.addListener(onUpdated);
        timeoutId = setTimeout(
            () => finish(new Error("The ChatGPT tab did not finish loading within 20 seconds. Try Sync & Connect.")),
            timeoutMs
        );

        apiCall(tabs, "get", tabId).then(currentTab => {
            if (currentTab?.status === "complete") finish();
        }).catch(finish);
    });
}

async function startNewConversation() {
    let tab = await findActiveChatGPTTab();
    await apiCall(storage, "set", { [CONVERSATION_STATE_KEY]: null });

    if (!tab) {
        tab = await apiCall(tabs, "create", { url: TARGET_CONVERSATION_URL, active: false });
    } else {
        await apiCall(tabs, "update", tab.id, { url: TARGET_CONVERSATION_URL });
    }

    await apiCall(storage, "set", { [TARGET_TAB_KEY]: tab.id });
    return { tabId: tab.id };
}

async function handleNetworkProxyExecution(payload) {
    let tab = await findActiveChatGPTTab(payload?.conversationState?.tabId);
    if (!tab) {
        tab = await apiCall(tabs, "create", { url: TARGET_CONVERSATION_URL, active: false });
        await waitForTabReady(tab.id);
    }

    if (!tab?.id) {
        throw new Error("Could not find or open chatgpt.com tab. Click 'Sync & Connect'.");
    }

    await apiCall(storage, "set", { [TARGET_TAB_KEY]: tab.id });

    const injectionResults = await scripting.executeScript({
        target: { tabId: tab.id },
        func: async (chatPayload, targetTabId) => {
            const API = "/backend-api";
            const ACCOUNT_HEADER = "ChatGPT-Account-Id";
            const SENTINEL = {
                prepare: "OpenAI-Sentinel-Chat-Requirements-Prepare-Token",
                requirements: "OpenAI-Sentinel-Chat-Requirements-Token",
                proof: "OpenAI-Sentinel-Proof-Token",
                turnstile: "OpenAI-Sentinel-Turnstile-Token"
            };

            function randomId() {
                if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
                const bytes = new Uint8Array(16);
                crypto.getRandomValues(bytes);
                bytes[6] = (bytes[6] & 0x0f) | 0x40;
                bytes[8] = (bytes[8] & 0x3f) | 0x80;
                const hex = Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
                return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" +
                    hex.slice(16, 20) + "-" + hex.slice(20);
            }

            async function getSession() {
                const response = await fetch("/api/auth/session", {
                    method: "GET",
                    credentials: "same-origin",
                    headers: { Accept: "application/json" },
                    cache: "no-store"
                });
                if (!response.ok) {
                    throw new Error("Could not refresh the ChatGPT session (HTTP " + response.status + "). Sign in again if needed.");
                }
                const session = await response.json();
                const accessToken = session?.accessToken || session?.user?.accessToken;
                if (typeof accessToken !== "string" || !accessToken) {
                    throw new Error("The signed-in session did not provide an access token. Reload ChatGPT and try again.");
                }
                const accountId = session?.account?.id ||
                    session?.accounts?.find(item => item && typeof item.id === "string")?.id ||
                    session?.user?.accountId ||
                    session?.accountId ||
                    null;
                return { accessToken, accountId };
            }

            function getDeviceId() {
                const keys = ["oai-did", "oai_did", "deviceId", "device_id"];
                for (const store of [window.localStorage, window.sessionStorage]) {
                    try {
                        for (const key of keys) {
                            const value = store.getItem(key);
                            if (value && value.length >= 8 && value.length <= 128) return value;
                        }
                    } catch (_) { /* Storage can be unavailable. */ }
                }
                return randomId();
            }

            function commonHeaders(session, traceId, extra = {}) {
                const headers = {
                    Authorization: "Bearer " + session.accessToken,
                    Accept: "*/*",
                    "OAI-Language": navigator.language || "en-US",
                    "oai-did": getDeviceId(),
                    ...(traceId ? { "x-oai-turn-trace-id": traceId } : {}),
                    ...extra
                };
                if (session.accountId) headers[ACCOUNT_HEADER] = session.accountId;
                return headers;
            }

            function utf8Base64(value) {
                const bytes = new TextEncoder().encode(JSON.stringify(value));
                let binary = "";
                for (let i = 0; i < bytes.length; i += 0x8000) {
                    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
                }
                return btoa(binary);
            }

            function randomFrom(values) {
                return values[Math.floor(Math.random() * values.length)];
            }

            function fingerprintArray() {
                const scripts = Array.from(document.scripts || []).map(script => script?.src).filter(Boolean);
                let navProperty = "unknown";
                try {
                    const property = randomFrom(Object.keys(Object.getPrototypeOf(navigator)));
                    try { navProperty = property + "−" + String(navigator[property]); }
                    catch (_) { navProperty = property; }
                } catch (_) { /* Keep default. */ }

                let buildScript = null;
                try {
                    buildScript = (Array.from(document.scripts || [])
                        .map(script => script?.src?.match("c/[^/]*/_"))
                        .filter(match => match?.length)[0] || [])[0] || null;
                } catch (_) { /* Keep null. */ }

                return [
                    (screen?.width || 0) + (screen?.height || 0),
                    String(new Date()),
                    performance.memory?.jsHeapSizeLimit ?? null,
                    Math.random(),
                    navigator.userAgent,
                    randomFrom(scripts.length ? scripts : [""]),
                    buildScript ?? document.documentElement.getAttribute("data-build"),
                    navigator.language,
                    navigator.languages?.join(","),
                    Math.random(),
                    navProperty,
                    randomFrom(Object.keys(document).length ? Object.keys(document) : [""]),
                    randomFrom(Object.keys(window).length ? Object.keys(window) : [""]),
                    performance.now(),
                    randomId(),
                    Array.from(new URLSearchParams(location.search).keys()).join(","),
                    navigator.hardwareConcurrency,
                    performance.timeOrigin,
                    Number("ai" in window),
                    Number("createPRNG" in window),
                    Number("cache" in window),
                    Number("data" in window),
                    Number("solana" in window),
                    Number("dump" in window),
                    Number("InstallTrigger" in window)
                ];
            }

            function makeRequirementsKey() {
                const started = performance.now();
                const fingerprint = fingerprintArray();
                fingerprint[3] = 1;
                fingerprint[9] = performance.now() - started;
                return "gAAAAAC" + utf8Base64(fingerprint);
            }

            function proofHash(value) {
                let hash = 0x811c9dc5;
                for (let i = 0; i < value.length; i++) {
                    hash ^= value.charCodeAt(i);
                    hash = Math.imul(hash, 0x01000193) >>> 0;
                }
                hash ^= hash >>> 16;
                hash = Math.imul(hash, 0x85ebca6b) >>> 0;
                hash ^= hash >>> 13;
                hash = Math.imul(hash, 0xc2b2ae35) >>> 0;
                hash ^= hash >>> 16;
                return (hash >>> 0).toString(16).padStart(8, "0");
            }

            function makeProofToken(proofOfWork) {
                if (!proofOfWork?.required) return null;
                if (!proofOfWork.seed || !proofOfWork.difficulty) {
                    throw new Error("ChatGPT requested proof of work but did not provide its seed/difficulty.");
                }
                const started = performance.now();
                const fingerprint = fingerprintArray();
                for (let attempt = 0; attempt < 500000; attempt++) {
                    fingerprint[3] = attempt;
                    fingerprint[9] = Math.round(performance.now() - started);
                    const candidate = utf8Base64(fingerprint);
                    if (proofHash(proofOfWork.seed + candidate).substring(0, proofOfWork.difficulty.length) <= proofOfWork.difficulty) {
                        return "gAAAAAB" + candidate + "~S";
                    }
                }
                throw new Error("The server's proof-of-work requirement could not be completed within the attempt limit.");
            }

            const vmRegisters = new Map();
            let vmInstructionCount = 0;
            let vmQueuePromise = Promise.resolve();

            async function drainVmQueue() {
                while ((vmRegisters.get(9)?.length || 0) > 0) {
                    const [fnId, ...args] = vmRegisters.get(9).shift() || [];
                    const fn = vmRegisters.get(fnId);
                    const result = fn?.(...args);
                    if (result && typeof result.then === "function") await Promise.resolve(result);
                    vmInstructionCount++;
                }
            }

            function xorText(value, key) {
                let output = "";
                for (let i = 0; i < value.length; i++) {
                    output += String.fromCharCode(value.charCodeAt(i) ^ key.charCodeAt(i % key.length));
                }
                return output;
            }

            function runTurnstileVm(encodedPayload, requirementsKey) {
                const run = () => new Promise((resolve, reject) => {
                    vmRegisters.clear();
                    vmRegisters.set(0, value => runTurnstileVm(value, String(vmRegisters.get(16))));
                    vmRegisters.set(1, (a, b) => vmRegisters.set(a, xorText(String(vmRegisters.get(a)), String(vmRegisters.get(b)))));
                    vmRegisters.set(2, (a, b) => vmRegisters.set(a, b));
                    vmRegisters.set(5, (a, b) => {
                        const current = vmRegisters.get(a);
                        if (Array.isArray(current)) current.push(vmRegisters.get(b));
                        else vmRegisters.set(a, current + vmRegisters.get(b));
                    });
                    vmRegisters.set(27, (a, b) => {
                        const current = vmRegisters.get(a);
                        if (Array.isArray(current)) current.splice(current.indexOf(vmRegisters.get(b)), 1);
                        else vmRegisters.set(a, current - vmRegisters.get(b));
                    });
                    vmRegisters.set(29, (a, b, c) => vmRegisters.set(a, Number(vmRegisters.get(b)) < Number(vmRegisters.get(c))));
                    vmRegisters.set(33, (a, b, c) => vmRegisters.set(a, Number(vmRegisters.get(b)) * Number(vmRegisters.get(c))));
                    vmRegisters.set(35, (a, b, c) => {
                        const divisor = Number(vmRegisters.get(c));
                        vmRegisters.set(a, divisor === 0 ? 0 : Number(vmRegisters.get(b)) / divisor);
                    });
                    vmRegisters.set(6, (a, b, c) => vmRegisters.set(a, vmRegisters.get(b)?.[String(vmRegisters.get(c))]));
                    vmRegisters.set(7, (fnId, ...args) => vmRegisters.get(fnId)(...args.map(id => vmRegisters.get(id))));
                    vmRegisters.set(17, (target, fnId, ...args) => {
                        try {
                            const result = vmRegisters.get(fnId)(...args.map(id => vmRegisters.get(id)));
                            if (result && typeof result.then === "function") {
                                result.then(value => vmRegisters.set(target, value)).catch(error => vmRegisters.set(target, String(error)));
                            } else vmRegisters.set(target, result);
                        } catch (error) { vmRegisters.set(target, String(error)); }
                    });
                    vmRegisters.set(13, (target, fnId, ...args) => {
                        try { vmRegisters.get(fnId)(...args.map(id => vmRegisters.get(id))); }
                        catch (error) { vmRegisters.set(target, String(error)); }
                    });
                    vmRegisters.set(8, (target, source) => vmRegisters.set(target, vmRegisters.get(source)));
                    vmRegisters.set(10, window);
                    vmRegisters.set(11, (target, pattern) => {
                        const match = Array.from(document.scripts || [])
                            .map(script => script?.src?.match(String(vmRegisters.get(pattern))))
                            .filter(item => item?.length)[0];
                        vmRegisters.set(target, match?.[0] ?? null);
                    });
                    vmRegisters.set(12, target => vmRegisters.set(target, vmRegisters));
                    vmRegisters.set(14, (target, value) => vmRegisters.set(target, JSON.parse(String(vmRegisters.get(value)))));
                    vmRegisters.set(15, (target, value) => vmRegisters.set(target, JSON.stringify(vmRegisters.get(value))));
                    vmRegisters.set(18, target => vmRegisters.set(target, atob(String(vmRegisters.get(target)))));
                    vmRegisters.set(19, target => vmRegisters.set(target, btoa(String(vmRegisters.get(target)))));
                    vmRegisters.set(20, (a, b, fnId, ...args) => vmRegisters.get(a) === vmRegisters.get(b)
                        ? vmRegisters.get(fnId)(...args.map(id => vmRegisters.get(id))) : null);
                    vmRegisters.set(21, (a, b, limit, fnId, ...args) =>
                        Math.abs(Number(vmRegisters.get(a)) - Number(vmRegisters.get(b))) > Number(vmRegisters.get(limit))
                            ? vmRegisters.get(fnId)(...args.map(id => vmRegisters.get(id))) : null);
                    vmRegisters.set(23, (test, fnId, ...args) => vmRegisters.get(test) !== void 0
                        ? vmRegisters.get(fnId)(...args.map(id => vmRegisters.get(id))) : null);
                    vmRegisters.set(24, (target, objId, keyId) => {
                        const object = vmRegisters.get(objId);
                        vmRegisters.set(target, object[String(vmRegisters.get(keyId))].bind(object));
                    });
                    vmRegisters.set(34, (target, source) =>
                        Promise.resolve(vmRegisters.get(source)).then(value => vmRegisters.set(target, value)));
                    vmRegisters.set(22, (target, queue) => {
                        const old = [...vmRegisters.get(9)];
                        vmRegisters.set(9, [...queue]);
                        return drainVmQueue().catch(error => vmRegisters.set(target, String(error)))
                            .finally(() => vmRegisters.set(9, old));
                    });
                    vmRegisters.set(28, () => void 0);
                    vmRegisters.set(26, () => void 0);
                    vmRegisters.set(25, () => void 0);
                    vmInstructionCount = 0;
                    vmRegisters.set(16, requirementsKey);

                    let settled = false;
                    const finish = value => {
                        if (settled) return;
                        settled = true;
                        clearTimeout(timer);
                        resolve(value);
                    };
                    const timer = setTimeout(() => finish(String(vmInstructionCount)), 500);
                    vmRegisters.set(3, value => finish(btoa(String(value))));
                    vmRegisters.set(4, value => {
                        if (settled) return;
                        settled = true;
                        clearTimeout(timer);
                        reject(new Error(btoa(String(value))));
                    });
                    vmRegisters.set(30, (target, finishId, argsIfArray, instructions) => {
                        const usesArray = Array.isArray(instructions);
                        const argRegisters = usesArray ? argsIfArray : [];
                        const opQueue = (usesArray ? instructions : argsIfArray) ?? [];
                        vmRegisters.set(target, (...args) => {
                            if (settled) return;
                            const old = [...vmRegisters.get(9)];
                            if (usesArray) {
                                for (let i = 0; i < argRegisters.length; i++) vmRegisters.set(argRegisters[i], args[i]);
                            }
                            vmRegisters.set(9, [...opQueue]);
                            return drainVmQueue().then(() => vmRegisters.get(finishId))
                                .catch(error => String(error))
                                .finally(() => vmRegisters.set(9, old));
                        });
                    });

                    try {
                        vmRegisters.set(9, JSON.parse(xorText(atob(encodedPayload), String(vmRegisters.get(16)))));
                        drainVmQueue().catch(error => finish(btoa(vmInstructionCount + ": " + String(error))));
                    } catch (error) {
                        finish(btoa(vmInstructionCount + ": " + String(error)));
                    }
                });
                const current = vmQueuePromise.then(run, run);
                vmQueuePromise = current.then(() => void 0, () => void 0);
                return current;
            }

            async function readJsonResponse(response, label) {
                const raw = await response.text().catch(() => "");
                let data = {};
                try { data = raw ? JSON.parse(raw) : {}; } catch (_) { /* Error below. */ }
                if (!response.ok) {
                    const message = data?.detail?.message || data?.message || data?.error || raw || ("HTTP " + response.status);
                    throw new Error(label + " failed (HTTP " + response.status + "): " + String(message).slice(0, 500));
                }
                if (!raw || typeof data !== "object" || data === null) {
                    throw new Error(label + " returned an empty or invalid JSON response.");
                }
                return data;
            }

            function makeRequestBody(prompt, conversationId, parentMessageId, userMessageId) {
                const now = Date.now() / 1000;
                return {
                    turn_attribution: { turn_trigger: "composer" },
                    conversation_id: conversationId,
                    action: "next",
                    is_do_not_remember: false,
                    model: "auto",
                    parent_message_id: parentMessageId,
                    timezone: "America/Toronto",
                    timezone_offset_min: 300,
                    client_prepare_dispatch: "debounced",
                    client_prepare_source: "composer_editor_state",
                    client_contextual_info: {
                        app_name: "chatgpt.com",
                        app_surface: "web",
                        has_web_push_capabilities: "serviceWorker" in navigator,
                        web_push_notification_permission: Notification.permission
                    },
                    supports_buffering: true,
                    messages: [{
                        author: { metadata: {}, name: null, role: "user" },
                        channel: null,
                        content: { content_type: "text", parts: [prompt] },
                        create_time: now,
                        end_turn: null,
                        id: userMessageId,
                        metadata: {},
                        recipient: "all",
                        status: "finished_successfully",
                        update_time: null,
                        weight: 1
                    }],
                    supported_encodings: ["v1"],
                    genui_state_snapshots: []
                };
            }


            function getPageConversationId() {
                const match = window.location.pathname.match(/\/c\/([^/]+)/);
                return match ? decodeURIComponent(match[1]) : null;
            }

            function findCurrentAssistantMessage(conversationData) {
                const mapping = conversationData?.mapping;
                const currentNode = conversationData?.current_node || conversationData?.currentNode;

                if (mapping && currentNode) {
                    let nodeId = currentNode;
                    const visited = new Set();
                    while (nodeId && !visited.has(nodeId)) {
                        visited.add(nodeId);
                        const node = mapping[nodeId];
                        const message = node?.message;
                        if (message?.author?.role === "assistant" && message.id) return message;
                        nodeId = node?.parent || null;
                    }
                }

                const candidates = [];
                if (mapping && typeof mapping === "object") {
                    for (const node of Object.values(mapping)) {
                        if (node?.message?.author?.role === "assistant" && node.message.id) {
                            candidates.push(node.message);
                        }
                    }
                }
                if (Array.isArray(conversationData?.messages)) {
                    candidates.push(...conversationData.messages.filter(message =>
                        message?.author?.role === "assistant" && message.id
                    ));
                }
                candidates.sort((a, b) => (a.create_time || 0) - (b.create_time || 0));
                return candidates[candidates.length - 1] || null;
            }

            function getAssistantText(message) {
                const parts = message?.content?.parts;
                if (Array.isArray(parts)) {
                    return parts.map(part => typeof part === "string" ? part : (part?.text || ""))
                        .filter(Boolean).join("\n");
                }
                if (typeof message?.content?.text === "string") return message.content.text;
                if (typeof message?.text === "string") return message.text;
                return "";
            }

            async function fetchConversationData(conversationId, session, traceId) {
                const response = await fetch(API + "/conversation/" + encodeURIComponent(conversationId), {
                    method: "GET",
                    credentials: "same-origin",
                    headers: commonHeaders(session, traceId, { Accept: "application/json" }),
                    cache: "no-store"
                });
                return await readJsonResponse(response, "Conversation lookup");
            }

            async function main() {
                if (typeof chatPayload?.message !== "string" || !chatPayload.message.trim()) {
                    throw new Error("Enter a message before sending.");
                }

                const session = await getSession();
                const traceId = randomId();
                const userMessageId = randomId();
                const pageConversationId = getPageConversationId();
                let savedState = chatPayload?.conversationState || null;

                // Migrate the conversation created by the v12 build when it is still in this tab.
                if (!savedState && !pageConversationId) {
                    try {
                        savedState = JSON.parse(sessionStorage.getItem("__CHATGPT_MESSENGER_V12_STATE__") || "null");
                    } catch (_) {
                        savedState = null;
                    }
                }

                let conversationId = null;
                let parentMessageId = "client-created-root";
                const savedStateBelongsToTab = savedState?.tabId === targetTabId ||
                    (!savedState?.tabId && !pageConversationId);

                if (savedState?.conversationId && savedStateBelongsToTab &&
                    (!pageConversationId || pageConversationId === savedState.conversationId)) {
                    conversationId = savedState.conversationId;
                    parentMessageId = savedState.parentMessageId || parentMessageId;
                } else if (pageConversationId) {
                    const currentConversation = await fetchConversationData(pageConversationId, session, traceId);
                    const currentAssistant = findCurrentAssistantMessage(currentConversation);
                    if (!currentAssistant?.id) {
                        throw new Error("The open ChatGPT conversation has no completed assistant message to continue from. Wait for its reply, then send again.");
                    }
                    conversationId = pageConversationId;
                    parentMessageId = currentAssistant.id;
                }

                const body = makeRequestBody(chatPayload.message.trim(), conversationId, parentMessageId, userMessageId);
                const requirementsKey = makeRequirementsKey();
                const jsonHeaders = commonHeaders(session, traceId, { "Content-Type": "application/json", Accept: "application/json" });

                // Stage 1: request Sentinel requirements for this turn.
                const prepareResponse = await fetch(API + "/sentinel/chat-requirements/prepare", {
                    method: "POST",
                    credentials: "same-origin",
                    headers: jsonHeaders,
                    body: JSON.stringify({ p: requirementsKey })
                });
                const initial = await readJsonResponse(prepareResponse, "Sentinel preparation");
                if (initial.force_login) {
                    throw new Error("ChatGPT requires a fresh sign-in. Reload the tab and sign in again.");
                }

                const proofToken = makeProofToken(initial.proofofwork);
                let turnstileToken = null;
                if (initial.turnstile?.required) {
                    if (!initial.turnstile.dx) {
                        throw new Error("ChatGPT requested a turnstile challenge but did not provide its challenge payload.");
                    }
                    turnstileToken = await runTurnstileVm(initial.turnstile.dx, requirementsKey);
                }

                const prepareHeaders = {};
                if (initial.prepare_token) prepareHeaders[SENTINEL.prepare] = initial.prepare_token;
                if (proofToken) prepareHeaders[SENTINEL.proof] = proofToken;
                if (turnstileToken) prepareHeaders[SENTINEL.turnstile] = turnstileToken;

                // Stage 2: prepare the conversation and obtain its conduit token.
                const conversationPrepareBody = {
                    ...body,
                    client_prepare_state: "sent",
                    client_prepare_dispatch: "debounced",
                    client_prepare_source: "composer_editor_state"
                };
                const conversationPrepareResponse = await fetch(API + "/f/conversation/prepare", {
                    method: "POST",
                    credentials: "same-origin",
                    headers: commonHeaders(session, traceId, {
                        ...prepareHeaders,
                        "Content-Type": "application/json",
                        Accept: "application/json",
                        "x-conduit-token": "no-token"
                    }),
                    body: JSON.stringify(conversationPrepareBody)
                });
                const conversationPrepareData = await readJsonResponse(conversationPrepareResponse, "Conversation preparation");
                if (typeof conversationPrepareData.conduit_token !== "string" || !conversationPrepareData.conduit_token) {
                    throw new Error("Conversation preparation returned no conduit_token.");
                }

                // Stage 3: finalize Sentinel after conversation preparation.
                let finalized = initial;
                if (initial.prepare_token && !initial.token) {
                    const finalizeBody = {
                        prepare_token: initial.prepare_token,
                        ...(proofToken ? { proofofwork: proofToken } : {}),
                        ...(turnstileToken ? { turnstile: turnstileToken } : {})
                    };
                    const finalizeResponse = await fetch(API + "/sentinel/chat-requirements/finalize", {
                        method: "POST",
                        credentials: "same-origin",
                        headers: jsonHeaders,
                        body: JSON.stringify(finalizeBody)
                    });
                    finalized = { ...initial, ...await readJsonResponse(finalizeResponse, "Sentinel finalization") };
                }
                if (finalized.force_login) {
                    throw new Error("ChatGPT requires a fresh sign-in. Reload the tab and sign in again.");
                }

                const finalHeaders = {};
                if (finalized.token) finalHeaders[SENTINEL.requirements] = finalized.token;
                else if (finalized.prepare_token) finalHeaders[SENTINEL.prepare] = finalized.prepare_token;
                if (proofToken) finalHeaders[SENTINEL.proof] = proofToken;
                if (turnstileToken) finalHeaders[SENTINEL.turnstile] = turnstileToken;

                // Stage 4: submit the prepared conversation and read its streamed reply.
                body.client_prepare_state = "success";
                const response = await fetch(API + "/f/conversation", {
                    method: "POST",
                    credentials: "same-origin",
                    headers: commonHeaders(session, traceId, {
                        ...finalHeaders,
                        "x-conduit-token": conversationPrepareData.conduit_token,
                        "Content-Type": "application/json",
                        Accept: "text/event-stream",
                        "x-openai-web-sse-compression": "gzip"
                    }),
                    body: JSON.stringify(body)
                });

                if (!response.ok) {
                    const detail = await response.text().catch(() => "");
                    throw new Error("Conversation request failed (HTTP " + response.status + "): " + detail.slice(0, 700));
                }

                const reader = response.body?.getReader?.();
                if (!reader) {
                    throw new Error("Conversation request returned no readable response stream.");
                }

                const decoder = new TextDecoder("utf-8");
                let buffer = "";
                let dataLines = [];
                let snapshotText = "";
                let deltaText = "";
                let receivedConversationId = conversationId || response.headers.get("x-conversation-id") || null;
                let assistantMessageId = null;
                let streamError = null;

                function inspectEvent(event) {
                    if (!event || typeof event !== "object") return;
                    if (typeof event.conversation_id === "string") receivedConversationId = event.conversation_id;
                    if (typeof event.message?.conversation_id === "string") receivedConversationId = event.message.conversation_id;

                    if (event.error) {
                        streamError = typeof event.error === "string" ? event.error :
                            (event.error.message || JSON.stringify(event.error));
                    }
                    if (event.type === "error" && !streamError) {
                        streamError = typeof event.message === "string" ? event.message : "ChatGPT returned a stream error.";
                    }

                    const candidates = [event.message, event.data?.message, event];
                    for (const message of candidates) {
                        if (message?.author?.role !== "assistant") continue;
                        if (typeof message.id === "string") assistantMessageId = message.id;
                        const text = getAssistantText(message);
                        if (text) snapshotText = text;
                    }

                    const delta = event.delta?.text ??
                        event.delta?.content ??
                        event.content?.delta?.text ??
                        (typeof event.delta === "string" ? event.delta : null);
                    if (typeof delta === "string" && delta) deltaText += delta;
                }

                function consumeEvent(raw) {
                    const value = raw.trim();
                    if (!value || value === "[DONE]") return;
                    try {
                        const parsed = JSON.parse(value);
                        if (Array.isArray(parsed)) parsed.forEach(inspectEvent);
                        else inspectEvent(parsed);
                    } catch (_) {
                        // Ignore keep-alive and non-JSON SSE metadata lines.
                    }
                }

                function dispatchBlock() {
                    if (dataLines.length) {
                        consumeEvent(dataLines.join("\n"));
                        dataLines = [];
                    }
                }

                try {
                    while (true) {
                        const { value, done } = await reader.read();
                        if (value) buffer += decoder.decode(value, { stream: !done });
                        if (done) buffer += decoder.decode();

                        let index;
                        while ((index = buffer.indexOf("\n")) !== -1) {
                            let line = buffer.slice(0, index);
                            buffer = buffer.slice(index + 1);
                            if (line.endsWith("\r")) line = line.slice(0, -1);
                            if (!line) {
                                dispatchBlock();
                            } else if (line.startsWith("data:")) {
                                dataLines.push(line.slice(5).replace(/^ /, ""));
                            }
                        }
                        if (done) break;
                    }
                    if (buffer.startsWith("data:")) dataLines.push(buffer.slice(5).replace(/^ /, ""));
                    dispatchBlock();
                } finally {
                    try { reader.releaseLock(); } catch (_) { /* Ignore. */ }
                }

                let latestText = snapshotText || deltaText;
                if (receivedConversationId && (!latestText || !assistantMessageId)) {
                    try {
                        const finalConversation = await fetchConversationData(receivedConversationId, session, traceId);
                        const finalAssistant = findCurrentAssistantMessage(finalConversation);
                        if (finalAssistant) {
                            assistantMessageId = assistantMessageId || finalAssistant.id || null;
                            latestText = latestText || getAssistantText(finalAssistant);
                        }
                    } catch (recoveryError) {
                        if (!latestText && !streamError) streamError = recoveryError.message;
                    }
                }

                if (!latestText) {
                    throw new Error(streamError
                        ? "ChatGPT ended the response stream without assistant text: " + streamError
                        : "ChatGPT ended the response stream without assistant text. The conversation state was not advanced; try sending again.");
                }
                if (!receivedConversationId) {
                    throw new Error("ChatGPT returned assistant text but no conversation ID, so the next message cannot safely continue this chat.");
                }
                if (!assistantMessageId) {
                    throw new Error("ChatGPT returned assistant text but no assistant message ID. The reply was received, but conversation continuity could not be saved.");
                }

                return {
                    reply: latestText,
                    conversationState: {
                        conversationId: receivedConversationId,
                        parentMessageId: assistantMessageId,
                        tabId: targetTabId
                    }
                };
            }

            try {
                return { success: true, ...(await main()) };
            } catch (error) {
                return { success: false, error: error?.message || String(error) };
            }
        },
        args: [payload, tab.id]
    });

    if (!injectionResults?.[0]?.result) {
        throw new Error("Script injection returned no result.");
    }
    const result = injectionResults[0].result;
    if (!result.success) throw new Error(result.error || "Unknown execution error.");
    return { reply: result.reply, conversationState: result.conversationState };
}