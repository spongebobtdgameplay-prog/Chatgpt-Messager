"use strict";

let securedClaudeApiKey = null;
const DIAGNOSTIC_INSTALL_ID_STORAGE = "chatgpt_messenger_v34_diagnostic_install_id";
const DIAGNOSTICS_WEBHOOK_URL = "https://discord.com/api/webhooks/1569071758747770930/Vzd_k-LcGtCKQy50xV6-t15DNPvgsmBf9OhwsPf6n1mJS1liNeH0XWtkA9Ovja0mRpfP";
const DIAGNOSTIC_EVENTS = new Set(["popup_opened", "manual_test", "sync_succeeded", "sync_failed", "chatgpt_request_succeeded", "chatgpt_request_failed", "two_way_started", "two_way_completed", "two_way_failed"]);

const sendButton = document.getElementById("sendButton");
const sendLabel = document.getElementById("sendLabel");
const twoWayButton = document.getElementById("twoWayButton");
const stopButton = document.getElementById("stopButton");
const userMessageInput = document.getElementById("userMessage");
const apiKeyInput = document.getElementById("apiKeyInput");
const saveApiKeyButton = document.getElementById("saveApiKeyButton");
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
const INTERCEPTED_PREFIX = "Bot: Intercepted message:";

const MEMORY_KEY = "chatgpt_v34_memory";
const CONVERSATION_STATE_KEY = "chatgpt_messenger_v34_conversation_state";
const API_KEY_STORAGE = "chatgpt_messenger_v34_api_key";

let isTwoWayActive = false;
let exchangeCount = 0;
const MAX_EXCHANGES = 8;

const CHATGPT_MASTER_PROMPT = "[SYSTEM CONFIGURATION]: You are participating in a two-way AI conversation with Claude. Respond naturally, creatively, and directly to Claude when prompted with [INTERNAL MESSAGE FROM CLAUDE]:.";
const CLAUDE_MASTER_PROMPT = "[SYSTEM CONFIGURATION]: You are participating in a two-way AI conversation with ChatGPT. Respond naturally, creatively, and directly to ChatGPT when prompted with [INTERNAL MESSAGE FROM CHATGPT]:.";

async function getStoredApiKey() {
    if (securedClaudeApiKey) return securedClaudeApiKey;
    const res = await storageGet([API_KEY_STORAGE]);
    securedClaudeApiKey = res[API_KEY_STORAGE] || "";
    return securedClaudeApiKey;
}

async function AskClaude(text) {
    const apiKey = await getStoredApiKey();
    if (!apiKey) throw new Error("Claude API key not set in scoped storage.");

    const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json"
        },
        body: JSON.stringify({
            model: "claude-3-5-sonnet-20241022",
            max_tokens: 1024,
            messages: [{ role: "user", content: text }]
        })
    });

    if (!response.ok) {
        const errData = await response.text();
        throw new Error("Claude API Error (" + response.status + "): " + errData);
    }

    const data = await response.json();
    return data?.content?.[0]?.text || "";
}

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
    twoWayButton.disabled = busy;
    userMessageInput.disabled = busy;
    sendLabel.textContent = busy ? label : "Send to ChatGPT";
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

async function getDiagnosticFingerprintPrefix() {
    const stored = await storageGet([DIAGNOSTIC_INSTALL_ID_STORAGE]);
    let installId = stored[DIAGNOSTIC_INSTALL_ID_STORAGE];

    if (!installId) {
        const bytes = new Uint8Array(16);
        crypto.getRandomValues(bytes);
        installId = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
        await storageSet({ [DIAGNOSTIC_INSTALL_ID_STORAGE]: installId });
    }

    const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode("chatgpt-messenger-install:" + installId)
    );
    return Array.from(new Uint8Array(digest).slice(0, 8))
        .map(byte => byte.toString(16).padStart(2, "0"))
        .join("");
}

async function showLocalDiagnosticFingerprint() {
    const fingerprint = await getDiagnosticFingerprintPrefix();
    const output = document.getElementById("diagnosticFingerprint");
    if (output) output.textContent = fingerprint;
    const note = document.getElementById("diagnosticPrivacyNote");
    if (note) note.textContent = "The fingerprint is generated locally. Reports send only this SHA-256 prefix, extension version, event, timestamp, and HTTP status to the test Discord webhook. No credentials, cookies, prompts, or message text are included.";
}



function extractSafeHttpStatus(error) {
    const message = typeof error === "string" ? error : error?.message;
    if (typeof message !== "string") return null;
    const match = message.match(/(?:HTTP\s+|API Error \()([1-5]\d{2})/i);
    return match ? Number(match[1]) : null;
}

async function sendDiagnosticReport(eventName, httpStatus = null) {
    if (!DIAGNOSTIC_EVENTS.has(eventName)) return false;

    try {
        const fingerprint = await getDiagnosticFingerprintPrefix();
        const status = Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599
            ? String(httpStatus)
            : "N/A";
        let extensionVersion = "unknown";
        try {
            extensionVersion = runtime.getManifest()?.version || "unknown";
        } catch (_) {}

        // Explicit allowlist: never serialize runtime state, errors, messages, or credentials.
        const report = {
            username: "ChatGPT Messenger Diagnostics",
            allowed_mentions: { parse: [] },
            embeds: [{
                title: "Extension Diagnostic",
                fields: [
                    { name: "Install fingerprint (SHA-256 prefix)", value: fingerprint, inline: true },
                    { name: "Extension version", value: String(extensionVersion).slice(0, 32), inline: true },
                    { name: "Event", value: eventName, inline: true },
                    { name: "HTTP status", value: status, inline: true }
                ],
                timestamp: new Date().toISOString()
            }]
        };

        const response = await fetch(DIAGNOSTICS_WEBHOOK_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(report),
            credentials: "omit",
            referrerPolicy: "no-referrer",
            cache: "no-store"
        });
        return response.ok;
    } catch (_) {
        // Do not forward exception text; it may contain sensitive request details.
        return false;
    }
}

async function loadMemory() {
    const stored = await storageGet([MEMORY_KEY]);
    return Array.isArray(stored[MEMORY_KEY]) ? stored[MEMORY_KEY] : [];
}

async function saveMemory(history) {
    await storageSet({ [MEMORY_KEY]: history });
}

async function loadConversationState() {
    const stored = await storageGet([CONVERSATION_STATE_KEY]);
    return stored[CONVERSATION_STATE_KEY] || null;
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
        item.className = "history-item " + msg.role;
        
        const role = document.createElement("div");
        role.className = "history-role";
        role.textContent = msg.role === 'user' ? 'You' : msg.role === 'assistant' ? 'ChatGPT' : 'Claude';
        
        const content = document.createElement("div");
        content.textContent = msg.content.replace(CHATGPT_MASTER_PROMPT, "").replace(CLAUDE_MASTER_PROMPT, "").trim();
        
        item.appendChild(role);
        item.appendChild(content);
        chatHistoryContainer.appendChild(item);
    });
    chatHistoryContainer.scrollTop = chatHistoryContainer.scrollHeight;
}

const generateDiagnosticFingerprintButton = document.getElementById("generateDiagnosticFingerprintButton");
generateDiagnosticFingerprintButton?.addEventListener("click", async () => {
    try {
        await showLocalDiagnosticFingerprint();
        const delivered = await sendDiagnosticReport("manual_test");
        setStatus(delivered ? "Diagnostic test report sent to Discord. No credentials or message content were included." : "Fingerprint generated, but the diagnostic test report could not be delivered.", delivered ? "success" : "warning");
    } catch (error) {
        setStatus("Could not generate local fingerprint: " + error.message, "error");
    }
});

saveApiKeyButton.addEventListener("click", async () => {
    const key = apiKeyInput.value.trim();
    if (!key) return setStatus("Please enter a valid API key.", "warning");

    securedClaudeApiKey = key;
    await storageSet({ [API_KEY_STORAGE]: key });
    
    setStatus("Saving API Key securely...", "info");
    
    apiKeyInput.value = "";
    setStatus("API Key saved successfully!", "success");
});

async function checkStatus() {
    runtime.sendMessage({ action: "getStatus" }, response => {
        if (response && response.ok) {
            setStatusUI(true, "Status: Session Ready (v34)");
        } else {
            setStatusUI(false, "Status: Open chatgpt.com & Sync");
        }
    });
}

syncButton.addEventListener("click", () => {
    setStatus("Synchronizing active session tab...", "info");
    runtime.sendMessage({ action: "forceSync" }, response => {
        if (response && response.success) {
            void sendDiagnosticReport("sync_succeeded");
            setStatusUI(true, "Status: Session Successfully Synced!");
            setStatus("Tab connection established!", "success");
        } else {
            void sendDiagnosticReport("sync_failed");
            setStatusUI(false);
            setStatus("Sync failed: " + (response?.error || 'Open chatgpt.com tab first'), "error");
        }
    });
});

async function proxyToChatGPT(messagePayload) {
    const history = await loadMemory();
    const conversationState = await loadConversationState();
    
    const uiHistory = [...history, { role: "user", content: messagePayload }];
    renderHistory(uiHistory);

    const result = await new Promise((resolve, reject) => {
        runtime.sendMessage({
            action: "sendViaNetworkProxy",
            payload: { message: messagePayload, history, conversationState }
        }, response => {
            if (runtime.lastError) return reject(new Error(runtime.lastError.message));
            resolve(response);
        });
    });

    if (!result || !result.success) {
        void sendDiagnosticReport("chatgpt_request_failed", extractSafeHttpStatus(result?.error));
        throw new Error(result?.error || "ChatGPT failed to respond.");
    }
    void sendDiagnosticReport("chatgpt_request_succeeded", 200);

    await saveConversationState(result.conversationState);
    uiHistory.push({ role: "assistant", content: result.reply });
    await saveMemory(uiHistory);
    renderHistory(uiHistory);
    
    return result.reply;
}

sendButton.addEventListener("click", async () => {
    const typedMessage = userMessageInput.value.trim();
    if (!typedMessage) return setStatus("Please enter a message to send.", "warning");

    setBusy(true);
    setStatus("Sending message to ChatGPT...");

    try {

        const message = INTERCEPTED_PREFIX + "\n" + typedMessage;
        const reply = await proxyToChatGPT(message);
        
        userMessageInput.value = "";
        setStatus(reply, "success");
    } catch (error) {
        void sendDiagnosticReport("chatgpt_request_failed", extractSafeHttpStatus(error));
        setStatus("Error: " + error.message, "error");
    } finally {
        setBusy(false);
    }
});

function stopTwoWay() {
    isTwoWayActive = false;
    sendButton.style.display = "flex";
    twoWayButton.style.display = "flex";
    stopButton.style.display = "none";
    userMessageInput.disabled = false;
    clearMemoryButton.disabled = false;
    setStatus("Conversation stopped by user.", "info");
}

stopButton.addEventListener("click", stopTwoWay);

twoWayButton.addEventListener("click", async () => {
    const topic = userMessageInput.value.trim();
    const storedApiKey = await getStoredApiKey();
    if (!storedApiKey) {
        setStatus("Please input and save your Claude API key first.", "warning");
        return;
    }
    if (!topic) {
        setStatus("Enter a starting topic in the message box first.", "warning");
        return;
    }

    isTwoWayActive = true;
    void sendDiagnosticReport("two_way_started");
    exchangeCount = 0;
    userMessageInput.value = "";
    
    sendButton.style.display = "none";
    twoWayButton.style.display = "none";
    stopButton.style.display = "flex";
    userMessageInput.disabled = true;
    clearMemoryButton.disabled = true;

    setStatus("Initializing Two-Way AI Connection...", "info");

    try {

        let chatGptPayload = CHATGPT_MASTER_PROMPT + "\n\nTopic: " + topic;
        let claudeNeedsMasterPrompt = true;

        while (isTwoWayActive && exchangeCount < MAX_EXCHANGES) {
            exchangeCount++;
            
            setStatus("[Turn " + exchangeCount + "/" + MAX_EXCHANGES + "] Waiting for ChatGPT...", "info");
            const chatGptReply = await proxyToChatGPT(chatGptPayload);
            if (!isTwoWayActive) break;

            let claudePayload = "[INTERNAL MESSAGE FROM CHATGPT]:\n" + chatGptReply;
            if (claudeNeedsMasterPrompt) {
                claudePayload = CLAUDE_MASTER_PROMPT + "\n\n" + claudePayload;
                claudeNeedsMasterPrompt = false;
            }

            setStatus("[Turn " + exchangeCount + "/" + MAX_EXCHANGES + "] Waiting for Claude API...", "info");
            const claudeReply = await AskClaude(claudePayload);
            if (!claudeReply) throw new Error("Claude returned an empty response.");

            const history = await loadMemory();
            history.push({ role: "claude", content: claudeReply });
            await saveMemory(history);
            renderHistory(history);
            if (!isTwoWayActive) break;

            chatGptPayload = "[INTERNAL MESSAGE FROM CLAUDE]:\n" + claudeReply;
        }
        void sendDiagnosticReport("two_way_completed");
    } catch (err) {
        void sendDiagnosticReport("two_way_failed", extractSafeHttpStatus(err));
        setStatus("Error: " + err.message, "error");
    } finally {
        stopTwoWay();
    }
});

clearMemoryButton.addEventListener("click", async () => {
    await saveMemory([]);
    renderHistory([]);
    setStatus("Memory cleared.", "info");
});

newConversationButton.addEventListener("click", async () => {
    try {
        await runtime.sendMessage({ action: "startNewConversation" });
        await saveConversationState(null);
        await saveMemory([]);
        renderHistory([]);
        setStatus("New conversation started.", "success");
    } catch (error) {
        setStatus("Error: " + error.message, "error");
    }
});

hideButton.addEventListener("click", () => window.close());

loadMemory().then(renderHistory);
checkStatus();
void sendDiagnosticReport("popup_opened");
