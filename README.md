# poke-browser

Chrome extension plus MCP (Model Context Protocol) server so an AI agent can drive the browser you already have open: list tabs, navigate, click, run page JavaScript, capture screenshots, and open or close tabs.

## Architecture

```text
Chrome (poke-browser extension)
        │  WebSocket client → ws://127.0.0.1:<port>
        ▼
Node (poke-browser-mcp)
        │  stdio (JSON-RPC MCP)
        ▼
MCP client (Cursor, Claude Desktop, etc.)
        ▲
   AI agent
```

1. **Extension** (`background.js`) maintains a WebSocket **client** connection to the MCP server process. The server runs a small **WebSocket server** on a fixed localhost port (default **9009**).
2. **MCP server** (`mcp-server/`) speaks MCP over **stdio** to your editor or host app, and forwards each tool call to the extension as a JSON **command** over the WebSocket. The extension runs the Chrome APIs and sends a JSON **response** back.
3. **Content script** (`content.js`) relays **click** and **evaluate_js** into the page (hit-testing and main-world `eval` via an injected script + `postMessage` bridge).

The WebSocket port is configurable on both sides:

- **Server:** environment variable `POKE_BROWSER_WS_PORT` (default `9009`).
- **Extension:** popup “WS port” (stored in `chrome.storage.local` as `wsPort`).

## Load the extension in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and choose the `poke-browser` directory (the folder that contains `manifest.json`).
4. Pin the extension if you want quick access to the popup. Open the popup and confirm the status shows **Connected** once the MCP server is running (see below).

Grant any permission prompts so tabs and scripting work on the sites you automate.

## Run the MCP server

From the `mcp-server` directory:

```bash
cd mcp-server
npm install
npm start
```

Optional: use a custom port:

```bash
POKE_BROWSER_WS_PORT=9010 npm start
```

Match the same port in the extension popup if you change it.

For a compiled run:

```bash
npm run build
npm run serve
```

(`serve` runs `node dist/index.js`; build output uses the same env vars.)

## Connect Cursor / Claude / any MCP client

MCP clients typically spawn your server as a subprocess and talk over **stdin/stdout**. Add a server entry that runs Node with this project’s entrypoint.

**Cursor** — in MCP settings, add something like:

```json
{
  "mcpServers": {
    "poke-browser": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/poke-labs/poke-browser/mcp-server/index.ts"],
      "env": {
        "POKE_BROWSER_WS_PORT": "9009"
      }
    }
  }
}
```

Adjust the path to match your machine. If you prefer the built output, use `"command": "node"` and `"args": ["/absolute/path/to/poke-browser/mcp-server/dist/index.js"]` after `npm run build`.

**Claude Desktop** — same idea under `claude_desktop_config.json` `mcpServers`, using `command` / `args` / `env`.

Requirements:

1. Chrome has **poke-browser** loaded and the popup shows **Connected**.
2. The MCP server process is running **or** your client starts it automatically via the config above.
3. `POKE_BROWSER_WS_PORT` (server) and the extension popup port stay in sync.

## Security note

This stack can navigate to arbitrary URLs, execute JavaScript in pages, and capture visible tabs. Only run it with profiles and MCP clients you trust, and avoid exposing the WebSocket port beyond localhost.

## Repository layout

| Path | Role |
|------|------|
| `manifest.json` | MV3 manifest |
| `background.js` | Service worker: WebSocket client + command dispatch |
| `content.js` | Click / `evaluate_js` relay |
| `popup.html` / `popup.js` | Connection status and activity log |
| `mcp-server/` | MCP + WebSocket bridge (see `mcp-server/README.md`) |
