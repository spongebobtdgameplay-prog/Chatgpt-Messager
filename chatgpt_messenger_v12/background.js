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

    if (request.action === "sendViaChatGPT") {
        handleChatGPTSend(request.payload)
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

async function handleChatGPTSend(payload) {
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
            const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

            try {
                const findComposer = () =>
                    document.querySelector("#prompt-textarea") ||
                    document.querySelector('[data-testid="prompt-textarea"]') ||
                    document.querySelector('textarea[placeholder]') ||
                    document.querySelector('[contenteditable="true"]');

                let composer = null;
                const composerDeadline = Date.now() + 15000;

                while (!composer && Date.now() < composerDeadline) {
                    composer = findComposer();
                    if (!composer) await delay(250);
                }

                if (!composer) {
                    return {
                        success: false,
                        error: "ChatGPT's message box was not found. Make sure you're signed in and the page has loaded."
                    };
                }

                const history = Array.isArray(chatPayload.history)
                    ? chatPayload.history.slice(-16)
                    : [];
                const previousMessages = history
                    .filter(item => item && typeof item.content === "string")
                    .map(item => (item.role === "assistant" ? "ChatGPT: " : "You: ") + item.content)
                    .join("\n\n");

                const messageText = previousMessages
                    ? "Previous conversation from this messenger:\n" + previousMessages +
                      "\n\nNew message:\n" + chatPayload.message
                    : chatPayload.message;

                const beforeAssistant = Array.from(
                    document.querySelectorAll('[data-message-author-role="assistant"]')
                ).at(-1) || null;
                const beforeAssistantText = beforeAssistant?.innerText || "";

                composer.focus();

                if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
                    const prototype = composer instanceof HTMLTextAreaElement
                        ? HTMLTextAreaElement.prototype
                        : HTMLInputElement.prototype;
                    const valueSetter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
                    if (!valueSetter) {
                        throw new Error("Could not enter text into ChatGPT's message box.");
                    }
                    valueSetter.call(composer, messageText);
                    composer.dispatchEvent(new InputEvent("input", {
                        bubbles: true,
                        inputType: "insertText",
                        data: messageText
                    }));
                } else {
                    document.execCommand("selectAll", false, null);
                    const inserted = document.execCommand("insertText", false, messageText);
                    if (!inserted) {
                        composer.textContent = messageText;
                    }
                    composer.dispatchEvent(new InputEvent("input", {
                        bubbles: true,
                        inputType: "insertText",
                        data: messageText
                    }));
                }

                let sendButton = null;
                const buttonDeadline = Date.now() + 5000;

                while (Date.now() < buttonDeadline) {
                    sendButton =
                        document.querySelector('button[data-testid="send-button"]') ||
                        Array.from(document.querySelectorAll("button")).find(button => {
                            const label = (button.getAttribute("aria-label") || "") + " " + (button.title || "");
                            return /\bsend\b/i.test(label);
                        });

                    if (sendButton && !sendButton.disabled) break;
                    await delay(100);
                }

                if (!sendButton || sendButton.disabled) {
                    return {
                        success: false,
                        error: "ChatGPT did not enable its Send button after the message was entered."
                    };
                }

                sendButton.click();

                const responseDeadline = Date.now() + 120000;
                let lastText = "";
                let stableSince = 0;

                while (Date.now() < responseDeadline) {
                    const assistantNodes = document.querySelectorAll(
                        '[data-message-author-role="assistant"]'
                    );
                    const latestAssistant = assistantNodes[assistantNodes.length - 1] || null;
                    const latestText = latestAssistant?.innerText?.trim() || "";
                    const changed = latestAssistant &&
                        (latestAssistant !== beforeAssistant || latestText !== beforeAssistantText);
                    const stillGenerating =
                        !!document.querySelector('[data-testid="stop-button"]') ||
                        !!document.querySelector('button[aria-label*="Stop generating"]');

                    if (changed && latestText) {
                        if (latestText !== lastText) {
                            lastText = latestText;
                            stableSince = Date.now();
                        } else if (!stillGenerating && Date.now() - stableSince >= 1800) {
                            return { success: true, reply: latestText };
                        }
                    }

                    await delay(300);
                }

                return {
                    success: false,
                    error: "ChatGPT did not finish a response within two minutes. Check the open ChatGPT tab."
                };
            } catch (error) {
                return { success: false, error: error?.message || String(error) };
            }
        },
        args: [payload]
    });

    if (!injectionResults || !injectionResults[0] || !injectionResults[0].result) {
        throw new Error("Could not read the result from the ChatGPT tab.");
    }

    const result = injectionResults[0].result;
    if (!result.success) {
        throw new Error(result.error || "ChatGPT send failed.");
    }

    return result.reply;
}