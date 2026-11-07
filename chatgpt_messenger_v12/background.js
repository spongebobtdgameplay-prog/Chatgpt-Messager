"use strict";

const api = (typeof browser !== "undefined") ? browser : chrome;
const runtime = api.runtime;
const tabs = api.tabs;
const scripting = api.scripting;
const CHATGPT_URL = "https://chatgpt.com/";
const CHATGPT_MATCH = "https://chatgpt.com/*";

runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (!request || typeof request.action !== "string") {
        return false;
    }

    let operation;
    if (request.action === "getStatus") {
        operation = getStatus();
    } else if (request.action === "forceSync" || request.action === "openTab") {
        operation = openOrFocusChatGPT();
    } else if (request.action === "sendToChatGPT") {
        operation = sendToChatGPT(request.payload);
    } else {
        return false;
    }

    operation.then(sendResponse).catch(error => {
        sendResponse({
            success: false,
            ok: false,
            error: error && error.message ? error.message : String(error)
        });
    });
    return true;
});

async function findChatGPTTab() {
    const matches = await tabs.query({ url: CHATGPT_MATCH });
    if (!matches.length) {
        return null;
    }

    return matches.find(tab => tab.active) || matches[0];
}

async function getStatus() {
    const tab = await findChatGPTTab();
    return {
        ok: !!tab,
        tabId: tab ? tab.id : null,
        status: tab ? (tab.status || "unknown") : "not-open"
    };
}

async function waitForTabComplete(tabId, timeoutMs = 30000) {
    const current = await tabs.get(tabId);
    if (current.status === "complete") {
        return;
    }

    await new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => finish(new Error(
            "ChatGPT did not finish loading. Check the open tab and try again."
        )), timeoutMs);

        function finish(error) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            tabs.onUpdated.removeListener(onUpdated);
            if (error) reject(error);
            else resolve();
        }

        function onUpdated(updatedTabId, changeInfo) {
            if (updatedTabId === tabId && changeInfo.status === "complete") {
                finish();
            }
        }

        tabs.onUpdated.addListener(onUpdated);
        tabs.get(tabId).then(tab => {
            if (tab.status === "complete") finish();
        }).catch(finish);
    });
}

async function openOrFocusChatGPT() {
    let tab = await findChatGPTTab();

    if (!tab) {
        tab = await tabs.create({ url: CHATGPT_URL, active: true });
    } else {
        await tabs.update(tab.id, { active: true });
    }

    if (tab && Number.isInteger(tab.id)) {
        await waitForTabComplete(tab.id);
    }

    return {
        success: true,
        ok: true,
        tabId: tab.id,
        message: "ChatGPT tab is ready. Sign in there if prompted."
    };
}

async function sendToChatGPT(payload) {
    const message = payload && typeof payload.message === "string"
        ? payload.message.trim()
        : "";

    if (!message) {
        throw new Error("Enter a message before sending.");
    }

    let tab = await findChatGPTTab();
    if (!tab) {
        tab = await tabs.create({ url: CHATGPT_URL, active: true });
    } else {
        await tabs.update(tab.id, { active: true });
    }

    if (!tab || !Number.isInteger(tab.id)) {
        throw new Error("Could not open a ChatGPT tab.");
    }

    await waitForTabComplete(tab.id);

    const results = await scripting.executeScript({
        target: { tabId: tab.id },
        func: async (userMessage) => {
            const pause = milliseconds =>
                new Promise(resolve => setTimeout(resolve, milliseconds));

            const composerSelectors = [
                "#prompt-textarea",
                "textarea[data-testid='prompt-textarea']",
                "[contenteditable='true'][data-testid='prompt-textarea']",
                "[contenteditable='true'][role='textbox']"
            ];

            const findComposer = () => {
                for (const selector of composerSelectors) {
                    const element = document.querySelector(selector);
                    if (element && !element.disabled && element.getAttribute("aria-disabled") !== "true") {
                        return element;
                    }
                }
                return null;
            };

            let composer = findComposer();
            const composerDeadline = Date.now() + 30000;
            while (!composer && Date.now() < composerDeadline) {
                await pause(300);
                composer = findComposer();
            }

            if (!composer) {
                const loginForm = document.querySelector("input[type='password']");
                if (loginForm || /\/auth\//i.test(location.pathname)) {
                    throw new Error("ChatGPT is asking you to sign in. Sign in in the open tab, then try again.");
                }
                throw new Error("Couldn't find ChatGPT's message box. Reload the ChatGPT tab and try again.");
            }

            const assistantSelector = "[data-message-author-role='assistant']";
            const beforeNodes = Array.from(document.querySelectorAll(assistantSelector));
            const beforeCount = beforeNodes.length;
            const beforeLastText = beforeNodes.length
                ? (beforeNodes[beforeNodes.length - 1].innerText || "").trim()
                : "";

            composer.focus();

            if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
                const prototype = composer instanceof HTMLTextAreaElement
                    ? HTMLTextAreaElement.prototype
                    : HTMLInputElement.prototype;
                const valueSetter = Object.getOwnPropertyDescriptor(prototype, "value").set;
                valueSetter.call(composer, userMessage);
                composer.dispatchEvent(new InputEvent("input", {
                    bubbles: true,
                    inputType: "insertText",
                    data: userMessage
                }));
                composer.dispatchEvent(new Event("change", { bubbles: true }));
            } else {
                document.execCommand("selectAll", false, null);
                const inserted = document.execCommand("insertText", false, userMessage);
                if (!inserted || (composer.innerText || "").trim() !== userMessage) {
                    composer.textContent = userMessage;
                    composer.dispatchEvent(new InputEvent("input", {
                        bubbles: true,
                        inputType: "insertText",
                        data: userMessage
                    }));
                }
            }

            const sendSelectors = [
                "button[data-testid='send-button']",
                "button[aria-label='Send prompt']",
                "button[aria-label='Send message']"
            ];

            let sendButton = null;
            const sendDeadline = Date.now() + 10000;
            while (!sendButton && Date.now() < sendDeadline) {
                for (const selector of sendSelectors) {
                    const candidate = document.querySelector(selector);
                    if (candidate && !candidate.disabled && candidate.getAttribute("aria-disabled") !== "true") {
                        sendButton = candidate;
                        break;
                    }
                }
                if (!sendButton) await pause(250);
            }

            if (!sendButton) {
                throw new Error("The ChatGPT send button did not become available. Check the message box and try again.");
            }

            sendButton.click();

            const responseDeadline = Date.now() + 120000;
            let previousText = "";
            let stableReads = 0;
            let sawNewAssistantMessage = false;

            while (Date.now() < responseDeadline) {
                const assistantNodes = Array.from(document.querySelectorAll(assistantSelector));
                const lastNode = assistantNodes.length
                    ? assistantNodes[assistantNodes.length - 1]
                    : null;
                const currentText = lastNode ? (lastNode.innerText || "").trim() : "";

                if (
                    assistantNodes.length > beforeCount ||
                    (currentText && currentText !== beforeLastText)
                ) {
                    sawNewAssistantMessage = true;
                    if (currentText && currentText === previousText) {
                        stableReads += 1;
                    } else {
                        previousText = currentText;
                        stableReads = 0;
                    }

                    const generating = !!document.querySelector(
                        "button[data-testid='stop-button'], button[aria-label*='Stop']"
                    );

                    if (currentText && !generating && stableReads >= 2) {
                        return { reply: currentText, received: true };
                    }
                }

                await pause(600);
            }

            if (sawNewAssistantMessage && previousText) {
                return {
                    reply: previousText,
                    received: true,
                    note: "The response may still be finishing in the ChatGPT tab."
                };
            }

            return {
                reply: "",
                received: false,
                note: "The message was submitted, but no assistant response was detected. Check the ChatGPT tab for sign-in, network, or service messages."
            };
        },
        args: [message]
    });

    const result = results && results[0] ? results[0].result : null;
    if (!result) {
        throw new Error("The ChatGPT page did not return a result.");
    }

    return {
        success: true,
        reply: result.reply || "",
        received: !!result.received,
        note: result.note || ""
    };
}
