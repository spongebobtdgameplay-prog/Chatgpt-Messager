ChatGPT Messenger v16 GOATED

Every outgoing message is prefixed by the extension with:
🤖: Bot: Intercepted message:

The marker is added to the actual message payload, not only the local UI.
It is also retained in the extension's recent-memory display.

Speed improvements:
- Reuses the conversation's known ChatGPT tab before scanning tabs.
- Waits for a newly opened ChatGPT tab to finish loading instead of sleeping for four seconds.
- Loads local message memory and conversation state concurrently.

Conversation state and recent memory migrate from v15 (and the older v12 memory key).
The server's normal response and validation flow is unchanged.