# poke-browser Testing Guide

## Prerequisites

- Chrome with the extension loaded (chrome://extensions → Load unpacked → select poke-browser/)
- MCP server running: `cd mcp-server && npm run build && node dist/index.js`
- Chrome DevTools open on any tab (F12)

## 1. Verify the WebSocket connection

In Chrome DevTools → Console on the extension's background page
(chrome://extensions → poke-browser → "Service Worker" link):

```js
// You should see log lines similar to:
// [poke-browser ext] Attempting WebSocket connection to ws://127.0.0.1:9009 | reconnect cycles completed: ...
// [poke-browser ext] WebSocket OPENED ws://127.0.0.1:9009
// [poke-browser ext] Message from MCP (first 200 chars): ...
```

After the server sends a `welcome` message, the extension must reply with `hello` including the auth token (set in the popup as **Auth token**, stored as `wsAuthToken`, or match `POKE_BROWSER_TOKEN` on the server).

## 2. Test via MCP Inspector

Run the MCP inspector:

```bash
npx @modelcontextprotocol/inspector node /path/to/poke-browser/mcp-server/dist/index.js
```

Open http://localhost:5173 in your browser.

## 3. Sample tool payloads

Tool names match `mcp-server/src/tools.ts` (MCP tool → extension `command` in `transport.ts`).

### navigate_to

```json
{
  "url": "https://medium.com",
  "waitForLoad": true
}
```

Expected (shape): `{ "success": true, "finalUrl": "...", "title": "..." }`

### manage_tabs (list)

```json
{ "action": "list" }
```

### capture_screenshot

```json
{ "format": "png" }
```

Expected: MCP image content block with base64 PNG data.

### get_dom_snapshot

```json
{ "maxDepth": 4, "includeHidden": false }
```

### find_element

```json
{ "query": "Sign In", "strategy": "text" }
```

### click_element

```json
{ "selector": "button.sign-in" }
```

### type_text

```json
{ "selector": "input[type=email]", "text": "test@example.com", "clearFirst": true }
```

### fill_form

```json
{
  "fields": [
    { "selector": "input[name=email]", "value": "test@example.com" },
    { "selector": "input[name=password]", "value": "password123" }
  ],
  "submitAfter": false
}
```

### scroll_window

```json
{ "deltaY": 500, "behavior": "smooth" }
```

### execute_script

```json
{ "script": "return document.title" }
```

### evaluate_js

```json
{ "code": "document.title" }
```

### get_accessibility_tree

```json
{ "interactiveOnly": true }
```

### read_page

```json
{ "format": "markdown" }
```

### script_inject

```json
{ "script": "console.log('poke')", "persistent": false }
```

### cookie_manager (get all)

```json
{ "action": "get_all", "url": "https://medium.com" }
```

### get_storage / set_storage

```json
{ "type": "local", "key": "myKey" }
```

```json
{ "type": "local", "key": "myKey", "value": "myValue" }
```

### wait_for_selector

```json
{ "selector": "h1", "timeout": 5000, "visible": true }
```

### get_console_logs

```json
{ "level": "error", "limit": 20 }
```

### get_network_logs

```json
{ "limit": 10, "filter": "api" }
```

### start_network_capture / stop_network_capture

```json
{}
```

### hover_element

```json
{ "selector": "nav a:first-child" }
```

### error_reporter

```json
{ "limit": 20 }
```

### get_performance_metrics

```json
{}
```

### full_page_capture

```json
{ "format": "png" }
```

### pdf_export

```json
{ "landscape": false, "scale": 1 }
```

### device_emulate

```json
{ "device": "mobile" }
```

## 4. Manual WebSocket test (no MCP client needed)

Commands use `type: "command"` with `requestId`, `command`, and `payload`. You must authenticate first: after `welcome`, send `hello` with the same token the server printed (or `POKE_BROWSER_TOKEN`).

```bash
node -e "
const WebSocket = require('ws');
const TOKEN = process.env.POKE_BROWSER_TOKEN || 'paste-token-from-server-stderr';
const ws = new WebSocket('ws://127.0.0.1:9009');
ws.on('open', () => console.log('TCP open'));
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  console.log('←', msg);
  if (msg.type === 'welcome') {
    ws.send(JSON.stringify({ type: 'hello', token: TOKEN, client: 'node-test' }));
  }
  if (msg.type === 'auth_ok') {
    ws.send(JSON.stringify({
      requestId: 'test-1',
      type: 'command',
      command: 'navigate_to',
      payload: { url: 'https://medium.com', waitForLoad: true }
    }));
  }
  if (msg.type === 'response' && msg.requestId === 'test-1') {
    console.log('navigate result:', msg);
    ws.close();
  }
});
ws.on('error', e => console.error('Error:', e.message));
"
```

## 5. Troubleshooting

| Symptom | Likely cause | Fix |
|--------|----------------|-----|
| ERR_CONNECTION_REFUSED | MCP server not running | Run `node dist/index.js` in mcp-server/ |
| Rapid connect/disconnect loop | Server crashes on start | Check for port conflict: `lsof -i :9009` |
| `zsh: terminated` | Process exits due to stdin closing | Server uses `process.stdin.resume()` + PassThrough for MCP stdio |
| Extension not connecting | Wrong port | Match **WS port** in the extension popup with `POKE_BROWSER_WS_PORT` |
| auth_error / 4401 | Token mismatch | Copy server token into popup **Auth token** or set `POKE_BROWSER_TOKEN` before starting the server |
| Tool returns error | Extension not loaded | Reload extension at chrome://extensions |
| Origin rejected (4403) | Non-extension client with forbidden Origin | Use a client with no `Origin` header, or `chrome-extension://…` |
