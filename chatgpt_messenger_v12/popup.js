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

const isFirefoxApi = typeof browser !== "undefined";
const api = isFirefoxApi ? browser : chrome;
const storage = api.storage.local;
const runtime = api.runtime;
const MEMORY_KEY = "chatgpt_v12_memory";
const MAX_HISTORY_ITEMS = 100;

function setStatus(message, type = "info") {
    statusPanel.className = "status";
    if (["success", "error", "warning"].includes(type)) {
        statusPanel.classList.add(type);
    }
    statusText.textContent = message;
}

function setStatusUI(connected, message) {
    authDot.className = connected ? "status-dot green" : "status-dot red";
    authStatusText.textContent = message || (
        connected ? "Status: ChatGPT tab found" : "Status: Open ChatGPT & Sync"
    );
}

function setBusy(busy) {
    sendButton.disabled = busy;
    userMessageInput.disabled = busy;
    syncButton.disabled = busy;
    sendLabel.textContent = busy ? "Sending..." : "Send to ChatGPT";
}

async function loadMemory() {
    let result;
    if (isFirefoxApi) {
        result = await storage.get([MEMORY_KEY]);
    } else {
        result = await new Promise((resolve, reject) => {
            storage.get([MEMORY_KEY], value => {
                const error = runtime.lastError;
                if (error) reject(new Error(error.message));
                else resolve(value);
            });
        });
    }

    const history = result && Array.isArray(result[MEMORY_KEY])
        ? result[MEMORY_KEY]
        : [];
    return history;
}

async function saveMemory(history) {
    const value = { [MEMORY_KEY]: history.slice(-MAX_HISTORY_ITEMS) };
    if (isFirefoxApi) {
        await storage.set(value);
        return;
    }

    await new Promise((resolve, reject) => {
        storage.set(value, () => {
            const error = runtime.lastError;
            if (error) reject(new Error(error.message));
            else resolve();
        });
    });
}

async function sendRuntimeMessage(message) {
    if (isFirefoxApi) {
        return runtime.sendMessage(message);
    }

    return new Promise((resolve, reject) => {
        runtime.sendMessage(message, response => {
            const error = runtime.lastError;
            if (error) reject(new Error(error.message));
            else resolve(response);
        });
    });
}

function renderHistory(history) {
    chatHistoryContainer.replaceChildren();

    if (!history.length) {
        const empty = document.createElement("div");
        empty.className = "empty-history";
        empty.textContent = "No messages saved yet.";
        chatHistoryContainer.appendChild(empty);
        return;
    }

    history.forEach(message => {
        const item = document.createElement("div");
        item.className = `history-item ${message.role === "assistant" ? "assistant" : "user"}`;

        const role = document.createElement("div");
        role.className = "history-role";
        role.textContent = message.role === "assistant" ? "ChatGPT" : "You";

        const content = document.createElement("div");
        content.className = "history-content";
        content.textContent = typeof message.content === "string" ? message.content : "";

        item.append(role, content);
        chatHistoryContainer.appendChild(item);
    });

    chatHistoryContainer.scrollTop = chatHistoryContainer.scrollHeight;
}

async function checkStatus() {
    try {
        const response = await sendRuntimeMessage({ action: "getStatus" });
        if (response && response.ok) {
            setStatusUI(true, "Status: ChatGPT tab found");
        } else {
            setStatusUI(false, "Status: Open ChatGPT & Sync");
        }
    } catch (error) {
        setStatusUI(false, "Status: Extension connection unavailable");
    }
}

syncButton.addEventListener("click", async () => {
    syncButton.disabled = true;
    setStatus("Opening or focusing your ChatGPT tab...", "info");

    try {
        const response = await sendRuntimeMessage({ action: "forceSync" });
        if (!response || !response.success) {
            throw new Error(response?.error || "Could not connect to the ChatGPT tab.");
        }
        setStatusUI(true, "Status: ChatGPT tab found");
        setStatus("ChatGPT is open. Sign in there if prompted, then send your message.", "success");
    } catch (error) {
        setStatusUI(false);
        setStatus(`Sync failed: ${error.message}`, "error");
    } finally {
        syncButton.disabled = false;
    }
});

sendButton.addEventListener("click", async () => {
    const message = userMessageInput.value.trim();
    if (!message) {
        setStatus("Enter a message first.", "warning");
        userMessageInput.focus();
        return;
    }

    setBusy(true);
    setStatus("Sending through the ChatGPT page...", "info");

    try {
        const response = await sendRuntimeMessage({
            action: "sendToChatGPT",
            payload: { message }
        });

        if (!response || !response.success) {
            throw new Error(response?.error || "The message could not be sent.");
        }

        const history = await loadMemory();
        const updatedHistory = [...history, { role: "user", content: message }];

        if (response.received && response.reply) {
            updatedHistory.push({ role: "assistant", content: response.reply });
        }

        const trimmedHistory = updatedHistory.slice(-MAX_HISTORY_ITEMS);
        await saveMemory(trimmedHistory);
        renderHistory(trimmedHistory);
        userMessageInput.value = "";
        setStatusUI(true, "Status: ChatGPT tab connected");

        if (response.received && response.reply) {
            setStatus(response.reply, "success");
        } else {
            setStatus(
                response.note || "The message was submitted. Check the ChatGPT tab for its response.",
                "warning"
            );
        }
    } catch (error) {
        setStatus(`Error: ${error.message}`, "error");
        await checkStatus();
    } finally {
        setBusy(false);
    }
});

userMessageInput.addEventListener("keydown", event => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        if (!sendButton.disabled) sendButton.click();
    }
});

clearMemoryButton.addEventListener("click", async () => {
    try {
        await saveMemory([]);
        renderHistory([]);
        setStatus("Local message history cleared.", "info");
    } catch (error) {
        setStatus(`Could not clear local history: ${error.message}`, "error");
    }
});

loadMemory().then(renderHistory).catch(error => {
    renderHistory([]);
    setStatus(`Could not load local history: ${error.message}`, "error");
});
checkStatus();
