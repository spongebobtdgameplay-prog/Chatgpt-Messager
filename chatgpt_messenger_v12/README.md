# ChatGPT Messenger v12

A small browser extension that sends a prompt through a ChatGPT tab you are already signed in to. It does not use an API key or an OpenAI SDK.

## How it works

1. The extension finds an open `https://chatgpt.com/` tab, or opens one.
2. When you press **Send to ChatGPT**, it fills ChatGPT's visible message composer and clicks the page's send button.
3. It reads the assistant reply from the rendered conversation and shows it in the popup.
4. Recent messages are stored in the browser's extension-local storage.

Because messages are sent through the actual ChatGPT page, the active ChatGPT conversation provides the conversation context. The popup's **Recent Messages (Local)** panel is only a local activity/history display; it is not separately replayed as ChatGPT context.

## Install

### Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Select **Load Temporary Add-on…**.
3. Choose the `manifest.json` file in this folder.

Temporary add-ons may need to be loaded again after Firefox restarts.

### Chrome / Chromium

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select this `chatgpt_messenger_v12` folder.

## Use

1. Open ChatGPT and sign in normally.
2. Navigate to the conversation where you want to send the prompt.
3. Open the extension popup. Use **Sync & Connect** if you need to open or focus the ChatGPT tab.
4. Enter a message and press **Send to ChatGPT**. You can also use Ctrl+Enter (Cmd+Enter on macOS).
5. Keep the ChatGPT tab available while the response is generated.

If the extension opens a new ChatGPT tab, sign in there before sending.

## Permissions

- `storage`: saves the popup's recent-message list locally in the browser.
- `tabs`: finds, opens, and focuses a ChatGPT tab.
- `scripting`: interacts with the visible ChatGPT composer and reads the rendered reply.
- `https://chatgpt.com/*`: limits page access to ChatGPT.

The extension does not request cookie access or `webRequest` access. It does not read, extract, store, or transmit bearer tokens, cookies, or other session credentials.

## Important notes

- This is a UI bridge, not an official OpenAI integration.
- It uses the ChatGPT account and browser session you signed in with. ChatGPT plan limits and account requirements still apply; this does not provide free API access.
- It does not call private ChatGPT backend endpoints, forge browser headers, reproduce Sentinel challenges, or bypass a server-side 403/anti-abuse response. If ChatGPT blocks or displays an error in its own page, the extension cannot override that decision.
- ChatGPT may change its page markup. If the composer or send button can no longer be found, reload ChatGPT and update the selectors in `background.js` for the current interface.
- Keep the correct ChatGPT conversation open before sending. The extension targets the active ChatGPT tab when one exists.

## Troubleshooting

**"Couldn't find ChatGPT's message box"**
- Reload the ChatGPT tab and try again.
- Confirm the page has finished loading and that you are signed in.
- If the ChatGPT interface has changed, inspect the current composer markup and update `composerSelectors` in `background.js`.

**"The ChatGPT send button did not become available"**
- Make sure the message box is visible and the page is not still loading.
- Check whether ChatGPT is showing a modal, sign-in prompt, or service error.

**The message was submitted but no reply appeared in the popup**
- Check the ChatGPT tab. The page may still be generating, may require sign-in, or may be showing a service message.
- Retry after the page has finished responding.

**The local history is empty**
- The history is stored in extension-local storage. Clearing it or removing the extension clears that local activity list; it does not delete conversations from ChatGPT.

## Project files

- `background.js`: finds the ChatGPT tab, injects the UI bridge, and waits for the rendered response.
- `popup.html`, `popup.css`, `popup.js`: extension popup, controls, status, and local message history.
- `manifest.json`: Manifest V3 configuration and minimal permissions.
