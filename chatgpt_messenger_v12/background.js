 "use strict";

const TARGET_CONVERSATION_URL = "https://chatgpt.com/";
const runtime = (typeof browser !== "undefined") ? browser.runtime : chrome.runtime;
const tabs = (typeof browser !== "undefined") ? browser.tabs : chrome.tabs;
const scripting = (typeof browser !== "undefined") ? browser.scripting : chrome.scripting;

runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "getStatus") {
        findActiveChatGPTTab().then(tab => sendResponse({ ok: !!tab }))
            .catch(() => sendResponse({ ok: false }));
        return true;
    }

    if (request.action === "forceSync" || request.action === "openTab") {
        findActiveChatGPTTab().then(tab => {
            if (tab) {
                tabs.update(tab.id, { active: true }, () => {
                    sendResponse({ success: true, tabId: tab.id });
                });
            } else {
                tabs.create({ url: TARGET_CONVERSATION_URL, active: true }, newTab => {
                    sendResponse({ success: true, tabId: newTab.id });
                });
            }
        }).catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }

    if (request.action === "sendViaNetworkProxy") {
        handleNetworkProxyExecution(request.payload)
            .then(reply => sendResponse({ success: true, reply }))
            .catch(error => sendResponse({ success: false, error: error.message }));
        return true;
    }
});

async function findActiveChatGPTTab() {
    const allTabs = await tabs.query({ url: "https://chatgpt.com/*" });
    return allTabs.length ? allTabs[0] : null;
}

async function handleNetworkProxyExecution(payload) {
    let tab = await findActiveChatGPTTab();
    if (!tab) {
        tab = await new Promise((resolve, reject) => {
            tabs.create({ url: TARGET_CONVERSATION_URL, active: false }, newTab => {
                if (runtime.lastError) return reject(new Error(runtime.lastError.message));
                setTimeout(() => resolve(newTab), 4000);
            });
        });
    }

    if (!tab?.id) {
        throw new Error("Could not find or open chatgpt.com tab. Click 'Sync & Connect'.");
    }

    const injectionResults = await scripting.executeScript({
        target: { tabId: tab.id },
        func: async (chatPayload) => {
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

            async function main() {
                if (typeof chatPayload?.message !== "string" || !chatPayload.message.trim()) {
                    throw new Error("Enter a message before sending.");
                }

                const session = await getSession();
                const traceId = randomId();
                const userMessageId = randomId();
                const savedStateKey = "__CHATGPT_MESSENGER_V12_STATE__";
                let savedState = null;
                try { savedState = JSON.parse(sessionStorage.getItem(savedStateKey) || "null"); }
                catch (_) { savedState = null; }

                const conversationId = savedState?.conversationId || null;
                const parentMessageId = savedState?.parentMessageId || "client-created-root";
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
                let latestText = "";
                let receivedConversationId = conversationId;
                let assistantMessageId = null;

                function consumeEvent(raw) {
                    if (!raw || raw.trim() === "[DONE]") return;
                    try {
                        const event = JSON.parse(raw);
                        if (typeof event.conversation_id === "string") receivedConversationId = event.conversation_id;
                        const message = event.message || event;
                        if (message?.author?.role === "assistant") {
                            if (typeof message.id === "string") assistantMessageId = message.id;
                            const parts = message.content?.parts;
                            if (Array.isArray(parts)) {
                                latestText = parts.map(part => typeof part === "string" ? part : (part?.text || ""))
                                    .filter(Boolean).join("\n");
                            }
                        }
                    } catch (_) { /* Ignore non-JSON SSE metadata. */ }
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
                    if (buffer.trim().startsWith("data:")) dataLines.push(buffer.trim().slice(5).replace(/^ /, ""));
                    dispatchBlock();
                } finally {
                    try { reader.releaseLock(); } catch (_) { /* Ignore. */ }
                }

                if (!latestText) {
                    throw new Error("The conversation stream ended without an assistant text response.");
                }
                if (receivedConversationId && assistantMessageId) {
                    sessionStorage.setItem(savedStateKey, JSON.stringify({
                        conversationId: receivedConversationId,
                        parentMessageId: assistantMessageId
                    }));
                }
                return latestText;
            }

            try {
                return { success: true, reply: await main() };
            } catch (error) {
                return { success: false, error: error?.message || String(error) };
            }
        },
        args: [payload]
    });

    if (!injectionResults?.[0]?.result) {
        throw new Error("Script injection returned no result.");
    }
    const result = injectionResults[0].result;
    if (!result.success) throw new Error(result.error || "Unknown execution error.");
    return result.reply;
}