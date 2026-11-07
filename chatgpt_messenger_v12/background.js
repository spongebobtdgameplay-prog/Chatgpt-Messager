"use strict";

const TARGET_CONVERSATION_URL = "https://chatgpt.com/";

const runtime = (typeof browser !== 'undefined') ? browser.runtime : chrome.runtime;
const tabs = (typeof browser !== 'undefined') ? browser.tabs : chrome.tabs;
const scripting = (typeof browser !== 'undefined') ? browser.scripting : chrome.scripting;

runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "getStatus") {
        findActiveChatGPTTab().then(tab => {
            sendResponse({ ok: !!tab });
        }).catch(() => {
            sendResponse({ ok: false });
        });
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
        }).catch(err => {
            sendResponse({ success: false, error: err.message });
        });
        return true;
    }

    if (request.action === "sendViaNetworkProxy") {
        handleNetworkProxyExecution(request.payload)
            .then(reply => sendResponse({ success: true, reply: reply }))
            .catch(error => sendResponse({ success: false, error: error.message }));
        return true;
    }
});

async function findActiveChatGPTTab() {
    const allTabs = await tabs.query({ url: "https://chatgpt.com/*" });
    if (allTabs.length > 0) {
        return allTabs[0];
    }
    return null;
}

async function handleNetworkProxyExecution(payload) {
    let tab = await findActiveChatGPTTab();
    if (!tab) {
        tab = await new Promise((resolve) => {
            tabs.create({ url: TARGET_CONVERSATION_URL, active: false }, newTab => {
                setTimeout(() => resolve(newTab), 4000); 
            });
        });
    }

    if (!tab || !tab.id) {
        throw new Error("Could not find or open chatgpt.com tab. Click 'Sync & Connect'.");
    }

    const injectionResults = await scripting.executeScript({
        target: { tabId: tab.id },
        func: async (chatPayload) => {
            try {
                // Step 1: Fetch chat requirements with realistic browser headers to satisfy WAF & Sentinel
                let chatReqToken = "";
                try {
                    const reqRes = await fetch("https://chatgpt.com/backend-api/sentinel/chat-requirements", {
                        method: "POST",
                        credentials: "include",
                        headers: {
                            "Content-Type": "application/json",
                            "Accept": "application/json",
                            "Origin": "https://chatgpt.com",
                            "Referer": "https://chatgpt.com/",
                            "Sec-Fetch-Dest": "empty",
                            "Sec-Fetch-Mode": "cors",
                            "Sec-Fetch-Site": "same-origin",
                            "User-Agent": navigator.userAgent
                        },
                        body: JSON.stringify({})
                    });
                    if (reqRes.ok) {
                        const reqData = await reqRes.json();
                        chatReqToken = reqData.token || "";
                    }
                } catch (e) {}

                const messages = [];
                if (chatPayload.history && chatPayload.history.length > 0) {
                    chatPayload.history.forEach(msg => {
                        messages.push({
                            author: { role: msg.role },
                            content: { content_type: "text", parts: [msg.content] },
                            create_time: Date.now() / 1000,
                            status: "finished_successfully"
                        });
                    });
                }

                messages.push({
                    author: { role: "user" },
                    content: { content_type: "text", parts: [chatPayload.message] },
                    create_time: Date.now() / 1000,
                    status: "finished_successfully"
                });

                const headers = {
                    "Content-Type": "application/json",
                    "Accept": "text/event-stream",
                    "Origin": "https://chatgpt.com",
                    "Referer": "https://chatgpt.com/",
                    "Sec-Fetch-Dest": "empty",
                    "Sec-Fetch-Mode": "cors",
                    "Sec-Fetch-Site": "same-origin",
                    "User-Agent": navigator.userAgent
                };

                if (chatReqToken) {
                    headers["openai-sentinel-chat-requirements-token"] = chatReqToken;
                }

                const response = await fetch("https://chatgpt.com/backend-api/conversation", {
                    method: "POST",
                    credentials: "include",
                    headers: headers,
                    body: JSON.stringify({
                        action: "next",
                        messages: messages,
                        model: "auto",
                        timezone_offset_min: new Date().getTimezoneOffset(),
                        history_and_training_disabled: false,
                        supports_buffering: true
                    })
                });

                if (!response.ok) {
                    const errText = await response.text();
                    return { success: false, error: `HTTP ${response.status}: ${errText.slice(0, 300)}` };
                }

                const reader = response.body.getReader();
                const decoder = new TextDecoder("utf-8");
                let lastAssistantMessage = "";
                let buffer = "";

                while (true) {
                    const { value, done } = await reader.read();
                    if (done) break;

                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split("\n");
                    buffer = lines.pop();

                    for (const line of lines) {
                        if (line.startsWith("data: ")) {
                            const jsonStr = line.slice(6).trim();
                            if (jsonStr === "[DONE]") continue;
                            try {
                                const parsed = JSON.parse(jsonStr);
                                if (parsed && parsed.message && parsed.message.author && parsed.message.author.role === "assistant") {
                                    const parts = parsed.message.content?.parts;
                                    if (parts && parts.length > 0) {
                                        lastAssistantMessage = parts[0];
                                    }
                                }
                            } catch (e) {}
                        }
                    }
                }

                return { 
                    success: true, 
                    reply: lastAssistantMessage || "[Success] Response received successfully!" 
                };

            } catch (err) {
                return { success: false, error: err.toString() };
            }
        },
        args: [payload]
    });

    if (!injectionResults || !injectionResults[0] || !injectionResults[0].result) {
        throw new Error("Script injection returned no result.");
    }

    const res = injectionResults[0].result;
    if (!res.success) {
        throw new Error(res.error || "Unknown execution error.");
    }

    return res.reply;
}