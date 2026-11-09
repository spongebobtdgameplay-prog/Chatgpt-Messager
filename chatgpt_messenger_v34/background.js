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

const CONVERSATION_STATE_KEY = "chatgpt_messenger_v34_conversation_state";
const TARGET_TAB_KEY = "chatgpt_messenger_v34_target_tab_id";
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
                    height: 860,
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
    const conversationTab = await getChatGPTTabById(preferredTabId);
    if (conversationTab) return conversationTab;

    const stored = await apiCall(storage, "get", [TARGET_TAB_KEY]);
    const storedTab = await getChatGPTTabById(stored?.[TARGET_TAB_KEY]);
    if (storedTab) return storedTab;

    const allTabs = await apiCall(tabs, "query", { url: "https://chatgpt.com/*" });
    if (allTabs && allTabs.length > 0) {
        return allTabs.find(t => t.active) || allTabs[0];
    }

    return null;
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
        timeoutId = setTimeout(() => finish(new Error("ChatGPT tab load timeout")), timeoutMs);

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
        throw new Error("Could not find or open chatgpt.com tab. Please keep chatgpt.com open in a tab.");
    }

    await apiCall(storage, "set", { [TARGET_TAB_KEY]: tab.id });
    await waitForTabReady(tab.id);

    const injectionResults = await scripting.executeScript({
        target: { tabId: tab.id },
        func: async (chatPayload, targetTabId) => {
            const API = "/backend-api";
            const ACCOUNT_HEADER = "ChatGPT-Account-Id";

            function randomId() {
                if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
                const bytes = new Uint8Array(16);
                crypto.getRandomValues(bytes);
                return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
            }

            async function getSession() {
                const response = await fetch("/api/auth/session", {
                    method: "GET",
                    credentials: "same-origin",
                    headers: { Accept: "application/json" }
                });
                if (!response.ok) throw new Error("Could not fetch session.");
                const session = await response.json();
                const accessToken = session?.accessToken || session?.user?.accessToken;
                const accountId = session?.account?.id || session?.accounts?.[0]?.id || null;
                if (!accessToken) throw new Error("No active session access token found. Please log into chatgpt.com.");
                return { accessToken, accountId };
            }

            function commonHeaders(session) {
                const headers = {
                    Authorization: "Bearer " + session.accessToken,
                    Accept: "*/*",
                    "OAI-Language": "en-US"
                };
                if (session.accountId) headers[ACCOUNT_HEADER] = session.accountId;
                return headers;
            }

            async function main() {
                const session = await getSession();
                const userMessageId = randomId();

                const body = {
                    conversation_id: chatPayload?.conversationState?.conversationId || null,
                    action: "next",
                    model: "auto",
                    parent_message_id: chatPayload?.conversationState?.parentMessageId || randomId(),
                    messages: [{
                        author: { role: "user" },
                        content: { content_type: "text", parts: [chatPayload.message] },
                        id: userMessageId,
                        status: "finished_successfully"
                    }]
                };

                const response = await fetch(API + "/conversation", {
                    method: "POST",
                    credentials: "same-origin",
                    headers: {
                        ...commonHeaders(session),
                        "Content-Type": "application/json",
                        Accept: "text/event-stream"
                    },
                    body: JSON.stringify(body)
                });

                if (!response.ok) {
                    if (response.status === 401) {
                        throw new Error("ChatGPT returned HTTP 401. Sign in again on chatgpt.com.");
                    }
                    if (response.status === 403) {
                        throw new Error("ChatGPT returned HTTP 403. Its bot/device-protection check rejected this automated request. Complete any verification on chatgpt.com and use the normal website; this extension cannot bypass that check.");
                    }
                    if (response.status === 429) {
                        throw new Error("ChatGPT returned HTTP 429. Requests are being rate-limited; wait before trying again.");
                    }
                    throw new Error("ChatGPT request failed with HTTP " + response.status + ".");
                }

                if (!response.body) {
                    return {
                        reply: "Response received successfully.",
                        conversationState: {
                            conversationId: body.conversation_id,
                            parentMessageId: userMessageId,
                            tabId: targetTabId
                        }
                    };
                }

                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = "";
                let latestText = "";
                let receivedConversationId = body.conversation_id;
                let assistantMessageId = null;

                try {
                    while (true) {
                        const { value, done } = await reader.read();
                        if (value) buffer += decoder.decode(value, { stream: !done });
                        if (done) break;

                        let index;
                        while ((index = buffer.indexOf("\n")) !== -1) {
                            let line = buffer.slice(0, index);
                            buffer = buffer.slice(index + 1);
                            if (line.startsWith("data:")) {
                                const dataStr = line.slice(5).trim();
                                if (dataStr === "[DONE]") continue;
                                try {
                                    const json = JSON.parse(dataStr);
                                    if (json.conversation_id) receivedConversationId = json.conversation_id;
                                    if (json.message?.author?.role === "assistant") {
                                        assistantMessageId = json.message.id;
                                        const parts = json.message?.content?.parts;
                                        if (parts) latestText = parts.join("\n");
                                    }
                                } catch (_) {}
                            }
                        }
                    }
                } catch (streamErr) {
                    console.error("Stream parsing error:", streamErr);
                }

                if (!latestText) {
                    throw new Error("No response content received from ChatGPT stream.");
                }

                return {
                    reply: latestText,
                    conversationState: {
                        conversationId: receivedConversationId,
                        parentMessageId: assistantMessageId || userMessageId,
                        tabId: targetTabId
                    }
                };
            }

            return { success: true, ...(await main()) };
        },
        args: [payload, tab.id]
    });

    return injectionResults?.[0]?.result || { success: false, error: "No response from tab script." };
}
