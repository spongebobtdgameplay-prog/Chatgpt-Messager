"use strict";

const sendButton = document.getElementById("sendButton");
const sendLabel = document.getElementById("sendLabel");
const userMessageInput = document.getElementById("userMessage");
const statusPanel = document.getElementById("status");
const statusText = document.getElementById("statusText");
const chatHistoryContainer = document.getElementById("chatHistory");
const clearMemoryButton = document.getElementById("clearMemoryButton");
const syncButton = document.getElementById("syncButton");
const authDot = document.getElementById("authDot");
const authStatusText = document.getElementById("authStatusText");
const newConversationButton = document.getElementById("newConversationButton");
const hideButton = document.getElementById("hideButton");

const storage = (typeof browser !== 'undefined') ? browser.storage.local : chrome.storage.local;
const runtime = (typeof browser !== 'undefined') ? browser.runtime : chrome.runtime;
const INTERCEPTED_PREFIX = "🤖: Bot: Intercepted message:";
const MEMORY_KEY = "chatgpt_v16_memory";
const LEGACY_MEMORY_KEYS = ["chatgpt_v15_memory", "chatgpt_v12_memory"];
const CONVERSATION_STATE_KEY = "chatgpt_messenger_v16_conversation_state";
const LEGACY_CONVERSATION_STATE_KEY = "chatgpt_messenger_v15_conversation_state";

function setStatus(message, type = "info") {
    statusPanel.className = "status"; 
    if (type === "success" || type === "error" || type === "warning") {
        statusPanel.classList.add(type);
    }
    statusText.textContent = message;
}

function setStatusUI(connected, text) {
    if (connected) {
        authDot.className = "status-dot green";
        authStatusText.textContent = text || "Status: Tab Synced & Ready";
    } else {
        authDot.className = "status-dot red";
        authStatusText.textContent = text || "Status: Open ChatGPT Tab";
    }
}

function setBusy(busy, label = "Sending...") {
    sendButton.disabled = busy;
    userMessageInput.disabled = busy;
    newConversationButton.disabled = busy;
    sendLabel.textContent = busy ? label : "Send via Network Proxy";
}

function storageGet(keys) {
    return new Promise((resolve, reject) => {
        storage.get(keys, result => {
            if (runtime.lastError) reject(new Error(runtime.lastError.message));
            else resolve(result || {});
        });
    });
}

function storageSet(values) {
    return new Promise((resolve, reject) => {
        storage.set(values, () => {
            if (runtime.lastError) reject(new Error(runtime.lastError.message));
            else resolve();
        });
    });
}

async function loadMemory() {
    const stored = await storageGet([MEMORY_KEY, ...LEGACY_MEMORY_KEYS]);
    if (Array.isArray(stored[MEMORY_KEY])) return stored[MEMORY_KEY];

    const legacy = LEGACY_MEMORY_KEYS
        .map(key => stored[key])
        .find(value => Array.isArray(value)) || [];
    if (legacy.length) await saveMemory(legacy);
    return legacy;
}

async function saveMemory(history) {
    await storageSet({ [MEMORY_KEY]: history });
}

async function loadConversationState() {
    const stored = await storageGet([CONVERSATION_STATE_KEY, LEGACY_CONVERSATION_STATE_KEY]);
    if (Object.prototype.hasOwnProperty.call(stored, CONVERSATION_STATE_KEY)) {
        return stored[CONVERSATION_STATE_KEY] || null;
    }

    const legacy = stored[LEGACY_CONVERSATION_STATE_KEY] || null;
    if (legacy) await saveConversationState(legacy);
    return legacy;
}

async function saveConversationState(state) {
    await storageSet({ [CONVERSATION_STATE_KEY]: state || null });
}

function renderHistory(history) {
    chatHistoryContainer.innerHTML = "";
    if (history.length === 0) {
        chatHistoryContainer.innerHTML = "<div style='color: #9ca3af; font-style: italic; padding: 4px;'>Memory is empty.</div>";
        return;
    }
    
    history.forEach(msg => {
        const item = document.createElement("div");
        item.className = `history-item ${msg.role}`;
        
        const role = document.createElement("div");
        role.className = "history-role";
        role.textContent = msg.role === 'user' ? '🤖 Bot · Intercepted' : 'ChatGPT';
        
        const content = document.createElement("div");
        content.textContent = msg.content;
        
        item.appendChild(role);
        item.appendChild(content);
        chatHistoryContainer.appendChild(item);
    });
    chatHistoryContainer.scrollTop = chatHistoryContainer.scrollHeight;
}

async function checkStatus() {
    runtime.sendMessage({ action: "getStatus" }, response => {
        if (response && response.ok) {
            setStatusUI(true, "Status: Session Ready (v16 GOATED)");
        } else {
            setStatusUI(false, "Status: Open chatgpt.com & Sync");
        }
    });
}

syncButton.addEventListener("click", () => {
    setStatus("Synchronizing active session tab...", "info");
    runtime.sendMessage({ action: "forceSync" }, response => {
        if (response && response.success) {
            setStatusUI(true, "Status: Session Successfully Synced!");
            setStatus("Tab connection established!", "success");
        } else {
            setStatusUI(false);
            setStatus(`Sync failed: ${response?.error || 'Open chatgpt.com tab first'}`, "error");
        }
    });
});

sendButton.addEventListener("click", async () => {
    const typedMessage = userMessageInput.value.trim();
    if (!typedMessage) {
        setStatus("Please enter a message to send.", "warning");
        return;
    }

    const message = INTERCEPTED_PREFIX + "\n" + typedMessage;

    setBusy(true);
    setStatus("Sending intercepted message to the current ChatGPT conversation...");

    try {
        const [history, conversationState] = await Promise.all([
            loadMemory(),
            loadConversationState()
        ]);
        const currentHistory = [...history, { role: "user", content: message }];
        renderHistory(currentHistory);

        const result = await new Promise((resolve, reject) => {
            runtime.sendMessage({
                action: "sendViaNetworkProxy",
                payload: { message, history, conversationState }
            }, response => {
                if (runtime.lastError) return reject(new Error(runtime.lastError.message));
                resolve(response);
            });
        });

        if (!result || !result.success) {
            throw new Error(result?.error || "The message could not be sent.");
        }

        await saveConversationState(result.conversationState);
        currentHistory.push({ role: "assistant", content: result.reply });
        await saveMemory(currentHistory);
        renderHistory(currentHistory);
        userMessageInput.value = "";
        setStatus(result.reply, "success");
        setStatusUI(true, "Status: Connected to current conversation (v16 GOATED)");
    } catch (error) {
        renderHistory(await loadMemory());
        userMessageInput.value = typedMessage;
        setStatus("Error: " + error.message, "error");
        setStatusUI(false, "Status: Message not sent");
    } finally {
        setBusy(false);
    }
});

clearMemoryButton.addEventListener("click", async () => {
    await saveMemory([]);
    renderHistory([]);
    setStatus("Recent memory cleared. The active ChatGPT conversation is unchanged.", "info");
});

newConversationButton.addEventListener("click", async () => {
    newConversationButton.disabled = true;
    setStatus("Starting a new ChatGPT conversation...", "info");
    try {
        const result = await new Promise((resolve, reject) => {
            runtime.sendMessage({ action: "startNewConversation" }, response => {
                if (runtime.lastError) return reject(new Error(runtime.lastError.message));
                resolve(response);
            });
        });
        if (!result?.success) throw new Error(result?.error || "Could not start a new conversation.");
        await saveConversationState(null);
        await saveMemory([]);
        renderHistory([]);
        userMessageInput.value = "";
        setStatus("New conversation ready. Your next message will start a separate ChatGPT chat.", "success");
    } catch (error) {
        setStatus("Could not start a new conversation: " + error.message, "error");
    } finally {
        newConversationButton.disabled = false;
    }
});

hideButton.addEventListener("click", () => {
    if (typeof browser !== "undefined") {
        browser.windows.getCurrent().then(currentWindow => {
            if (currentWindow?.id != null) return browser.windows.remove(currentWindow.id);
            window.close();
        }).catch(() => window.close());
        return;
    }

    chrome.windows.getCurrent(currentWindow => {
        if (currentWindow?.id != null) {
            chrome.windows.remove(currentWindow.id, () => {});
        } else {
            window.close();
        }
    });
});

loadMemory().then(renderHistory).catch(error => setStatus("Could not load memory: " + error.message, "error"));
checkStatus();