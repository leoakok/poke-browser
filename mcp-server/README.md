# poke-browser-mcp

Node process that implements an **MCP server** (stdio) and a **WebSocket server** (localhost) used by the **poke-browser** Chrome extension.

## Role in the stack

1. **WebSocket (extension → this process)**  
   The extension connects to `ws://127.0.0.1:<port>`. This package listens on that port (default **9009**). When a new client connects, any previous client is closed so only one browser session is attached at a time.

2. **JSON commands**  
   The server sends messages shaped like:

   ```json
   { "type": "command", "id": "<uuid>", "command": "navigate", "payload": { "url": "https://example.com" } }
   ```

   The extension replies with:

   ```json
   { "type": "response", "id": "<uuid>", "ok": true, "result": { } }
   ```

   or `ok: false` and an `error` string.

   On connect, the extension may send `{ "type": "hello", "client": "poke-browser-extension", "version": "..." }` for logging only.

3. **MCP (AI client → this process)**  
   The official `@modelcontextprotocol/sdk` exposes tools (`list_tabs`, `get_active_tab`, `navigate`, `click`, `screenshot`, `evaluate_js`, `new_tab`, `close_tab`). Each tool forwards to the extension over the WebSocket and returns JSON text in the MCP result.

## Configuration

| Variable | Default | Meaning |
|----------|---------|---------|
| `POKE_BROWSER_WS_PORT` | `9009` | WebSocket listen port (`WS_PORT` is also read as a fallback) |

The Chrome extension stores its target port in `chrome.storage.local` (`wsPort`); keep it aligned with this value.

## Scripts

| Command | Description |
|---------|-------------|
| `npm start` | Run `index.ts` with `tsx` (stdio MCP + WebSocket) |
| `npm run build` | Emit JavaScript to `dist/` |
| `npm run serve` | Run `node dist/index.js` |

## Dependencies

- `@modelcontextprotocol/sdk` — MCP server over stdio  
- `ws` — WebSocket server for the extension  
- `zod` — tool input schemas (peer-style dependency of the SDK)

## Development

Typecheck:

```bash
npx tsc --noEmit
```

The server logs WebSocket lifecycle messages on **stderr** so stdio **stdout** stays clean for MCP JSON-RPC.
