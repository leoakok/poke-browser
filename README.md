# poke-browser

Chrome extension plus MCP (Model Context Protocol) server so an AI agent can drive the browser you already have open: list tabs, navigate, click, run page JavaScript, capture screenshots, and open or close tabs.

## Architecture

```text
                    ┌─────────────────────────────┐
                    │  MCP client (Cursor, Claude) │
                    │         stdio or HTTP         │
                    └──────────────┬──────────────┘
                                   │ JSON-RPC (MCP)
                                   ▼
                    ┌─────────────────────────────┐
                    │   Node: poke-browser-mcp    │
                    │   tools → bridge.request()    │
                    └──────────────┬──────────────┘
                                   │ WebSocket server
                                   │ 127.0.0.1:POKE_BROWSER_WS_PORT
                                   ▼
┌──────────────────────────────────────────────────┐
│ Chrome: poke-browser extension (service worker)   │
│  hello+token → welcome/auth_ok → command/response │
└──────────────────────┬───────────────────────────┘
                       │ tabs, debugger, cookies, …
                       ▼
              Content script / page
```

1. **Extension** (`background.js`) opens a WebSocket **client** to the MCP process. The server sends `welcome`, then the extension must send `hello` with a **shared token** (`POKE_BROWSER_TOKEN` or a random value printed at startup). After `auth_ok`, the server forwards tool calls as JSON **command** messages; the extension replies with **response**.
2. **MCP server** (`mcp-server/`) speaks MCP over **stdio** (or HTTP with `--http`), rate-limits outbound commands (30 per 10s), and only accepts WebSocket connections whose `Origin` is missing (CLI clients) or starts with `chrome-extension://`.
3. **Content script** (`content.js`) relays DOM automation, console/error capture, and `evaluate_js` into the page.

Ports and env vars:

- **WebSocket:** `POKE_BROWSER_WS_PORT` (default **9009**) — match the extension popup **WS port** (`wsPort` in storage).
- **Optional shared secret:** `POKE_BROWSER_TOKEN` — match the extension popup **Auth token** (`wsAuthToken`). See [Security](#security).
- **HTTP MCP** (`--http` / `--tunnel`): **8755** or `POKE_BROWSER_MCP_PORT` (aliases: `POKE_BROWSER_PORT`, `POKE_TUNNEL_LOCAL_PORT`).

See **[TESTING.md](./TESTING.md)** for inspector payloads, manual WebSocket examples, and troubleshooting.

## Quick start (3 steps)

1. **Load the extension** in Chrome (`chrome://extensions` → Load unpacked → this repo folder). Open the popup and set **WS port** if you are not using the default `9009`.
2. **Run the MCP server** (from `mcp-server/` after `npm install && npm run build`): `npm start` or `node dist/index.js`. Copy the **WebSocket auth token** from stderr into the popup **Auth token** field and click **Save** (or set `POKE_BROWSER_TOKEN` before starting the server and use the same value in the popup).
3. **Point your MCP client** at the server (e.g. Cursor `mcpServers` with `command` + `args` to run this package, and `env` for `POKE_BROWSER_WS_PORT` / `POKE_BROWSER_TOKEN` as needed). Confirm the popup shows **Connected**.

## Load the extension in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and choose the `poke-browser` directory (the folder that contains `manifest.json`).
4. Pin the extension if you want quick access to the popup. Open the popup and confirm the status shows **Connected** once the MCP server is running (see below).

Grant any permission prompts so tabs and scripting work on the sites you automate.

## Run the MCP server

### Quick start via npx

After this package is published (or when testing a linked install):

```bash
npx @leokok/poke-browser
```

That runs the published `poke-browser` binary (stdio MCP by default). Match `POKE_BROWSER_WS_PORT` with the extension popup if you change the WebSocket port.

### From this repository

From the `mcp-server` directory:

```bash
cd mcp-server
npm install
npm run build
npm start
```

(`npm start` runs `node ./cli.mjs`, same entrypoint as npx.)

Optional: use a custom WebSocket port:

```bash
POKE_BROWSER_WS_PORT=9010 npm start
```

Match the same port in the extension popup if you change it.

**Poke tunnel (HTTP MCP + `poke tunnel`)** — same pattern as other Poke bridges: Streamable HTTP on localhost, then the Poke CLI tunnels it.

```bash
cd mcp-server
npm run build
node ./cli.mjs --http
# or: node ./cli.mjs --tunnel
```

Use `POKE_BROWSER_MCP_PORT` (default `8755`) if you need a specific HTTP listen port. `--tunnel` runs `npx --yes poke@latest tunnel http://127.0.0.1:<port>/mcp -n "poke-browser"` after the server is up.

For a direct run without the launcher script:

```bash
npm run serve
```

(`serve` runs `node dist/index.js`; build output uses the same env vars and flags.)

## Connect Cursor / Claude / any MCP client

MCP clients typically spawn your server as a subprocess and talk over **stdin/stdout**.

**Cursor** — in MCP settings:

```json
{
  "mcpServers": {
    "poke-browser": {
      "command": "npx",
      "args": ["-y", "@leokok/poke-browser"],
      "env": {
        "POKE_BROWSER_WS_PORT": "9009",
        "POKE_BROWSER_TOKEN": "use-a-long-random-secret"
      }
    }
  }
}
```

Use the same `POKE_BROWSER_TOKEN` value in the extension popup **Auth token** so the handshake succeeds after each server restart.

For a local checkout instead of npx, use `"command": "node"` and `"args": ["/absolute/path/to/poke-labs/poke-browser/mcp-server/cli.mjs"]` (run `npm run build` first).

**Claude Desktop** — same idea under `claude_desktop_config.json` `mcpServers`, using `command` / `args` / `env`.

Requirements:

1. Chrome has **poke-browser** loaded and the popup shows **Connected**.
2. The MCP server process is running **or** your client starts it automatically via the config above.
3. `POKE_BROWSER_WS_PORT` (server) and the extension popup port stay in sync.
4. `POKE_BROWSER_TOKEN` matches the extension **Auth token** when you use a fixed token (recommended for MCP-launched servers).

## Security

- **WebSocket token:** Only clients that send `hello` with the correct token (from `POKE_BROWSER_TOKEN` or the random value logged at startup) stay connected; others receive `auth_error` and the socket is closed.
- **Origin:** The WebSocket server allows connections with no `Origin` header (Node tooling) or `Origin: chrome-extension://…` (the extension). Other origins get HTTP 4403.
- **Rate limit:** Up to **30** extension commands per **10 seconds**; further calls return `{ "error": "rate_limit_exceeded", "retryAfter": 10 }` without dropping the socket.
- **Trust model:** This stack can drive the browser like a user: arbitrary URLs, injected scripts, screenshots, cookies. Use a dedicated Chrome profile, keep the WebSocket on localhost, and only connect MCP clients you trust. Copy `.env.example` to guide local env vars; do not commit real secrets.

## Repository layout

| Path | Role |
|------|------|
| `manifest.json` | MV3 manifest |
| `background.js` | Service worker: WebSocket client + command dispatch |
| `content.js` | Click / `evaluate_js` relay |
| `popup.html` / `popup.js` | Connection status and activity log |
| `mcp-server/` | MCP + WebSocket bridge (see `mcp-server/README.md`) |
