# ChatGPT Messenger v12

A browser extension prototype that sends a prompt using a request initiated from an already signed-in ChatGPT tab. It does not use an OpenAI API key or SDK.

## Request flow

1. The extension finds an open ChatGPT tab, or opens one.
2. The background script injects a request function into that tab so the request is made from the ChatGPT page origin.
3. The function requests the site's chat-requirements response, then posts the conversation payload to the site's conversation endpoint.
4. It reads the server-sent event stream and displays the latest assistant text.
5. Recent prompts and replies are stored in the extension's local storage.

The extension uses internal ChatGPT web-app endpoints. Those endpoints are undocumented and can change without notice. They are not a supported public API.

## Install

### Firefox
1. Open `about:debugging#/runtime/this-firefox`.
2. Select **Load Temporary Add-on…**.
3. Choose `chatgpt_messenger_v12/manifest.json`.

### Chrome / Chromium
1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Select **Load unpacked** and choose the `chatgpt_messenger_v12` folder.

## Use

1. Open ChatGPT and sign in normally.
2. Keep a ChatGPT tab open.
3. Open the Messenger popup, enter a prompt, and select **Send via Network Proxy**.
4. The popup shows the returned text and stores the local message history.

## Limits

- Requests rely on the current browser session and the web app's current request format.
- A server-side 401, 403, rate limit, or challenge rejection is authoritative. The extension does not override those decisions.
- The internal endpoint paths, required request fields, and response stream format may change at any time.
- The popup's recent history is stored locally; it is not a server-side ChatGPT conversation history.
- This prototype has not been runtime-verified against the current ChatGPT web app.

## Files

- `background.js`: selects the ChatGPT tab, executes the same-origin request, and reads the response stream.
- `popup.html`, `popup.css`, `popup.js`: popup interface and local history.
- `manifest.json`: extension metadata, permissions, and page access.
