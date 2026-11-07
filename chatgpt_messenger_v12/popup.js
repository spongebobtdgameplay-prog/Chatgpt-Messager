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

const storage = (typeof browser !== 'undefined') ? browser.storage.local : chrome.storage.local;
const runtime = (typeof browser !== 'undefined') ? browser.runtime : chrome.runtime;

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
    sendLabel.textContent = busy ? label : "Send via Network Proxy";
}

async function loadMemory() {
    return new Promise((resolve) => {
        storage.get(["chatgpt_v12_memory"], (result) => {
            resolve(result.chatgpt_v12_memory || []);
        });
    });
}

async function saveMemory(history) {
    return new Promise((resolve) => {
        storage.set({ "chatgpt_v12_memory": history }, resolve);
    });
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
        role.textContent = msg.role === 'user' ? 'You' : 'ChatGPT';
        
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
            setStatusUI(true, "Status: Session Ready (v12)");
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
    const message = userMessageInput.value.trim();
    if (!message) {
        setStatus("Please enter a message to send.", "warning");
        return;
    }

    setBusy(true);
    setStatus("Executing network-level proxy pipeline...");

    try {
        const history = await loadMemory();
        const currentHistory = [...history, { role: "user", content: message }];
        renderHistory(currentHistory);
        userMessageInput.value = ""; 

        const result = await new Promise((resolve, reject) => {
            runtime.sendMessage({
                action: "sendViaNetworkProxy",
                payload: {
                    message: message,
                    history: history
                }
            }, response => {
                if (runtime.lastError) {
                    return reject(new Error(runtime.lastError.message));
                }
                resolve(response);
            });
        });


        if (!result || !result.success) {
            throw new Error(result?.error || "Execution failed.");
        }

        currentHistory.push({ role: "assistant", content: result.reply });
        await saveMemory(currentHistory);
        renderHistory(currentHistory);
        
        setStatus(result.reply, "success");
        setStatusUI(true);

    } catch (error) {
        setStatus(`Error: ${error.message}`, "error");
        setStatusUI(false);
    } finally {
        setBusy(false);
    }
});

clearMemoryButton.addEventListener("click", async () => {
    await saveMemory([]);
    renderHistory([]);
    setStatus("Memory cleared successfully.", "info");
});

loadMemory().then(renderHistory);
checkStatus();