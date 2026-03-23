# poke-browser — Chrome Browser MCP

**A Chrome extension + MCP server for natural-language browser automation**

Built by [Poke](https://interaction.co) — the AI assistant from interaction.co — together with [Leo Kök](https://github.com/leoakok).

[poke-browser on GitHub](https://github.com/leoakok/poke-browser)

## Key features (MCP tools)

- **`navigate_to`** — Open URLs and wait for load completion on the chosen tab.
- **`find_element`** — Locate elements by CSS, text, ARIA, or XPath; queries respect **open shadow roots** (and the same-document tree you’d expect for complex widgets and “portal-style” UI mounted in the page).
- **`click_element`** — Click by selector or viewport coordinates; **always hovers ~1s** before the click so hover menus and delayed affordances can appear.
- **`type_text`** — Type into inputs and contenteditable regions; optional **`clear`** (default true) wipes existing text before typing, or set `clear: false` to append.
- **`get_dom_snapshot`** — Compact DOM tree with tags, roles, labels, bounds, and interactivity hints.
- **`capture_and_upload_screenshot`** — Capture the visible tab and POST it to your upload endpoint (or fall back to inline base64 when upload isn’t configured).
- **`get_accessibility_tree`** — Semantic nodes in reading order for screen-reader–style reasoning.
- **`scroll_window`** — Scroll by position, delta, direction, or “scroll into view” for a selector.
- **`managetabs`** — List, open, close, and switch tabs in the connected Chrome profile.
- **`browser_guide`** — In-repo Markdown playbook: every tool, common flows, and troubleshooting.

## Snapshot-then-act

After every **`click_element`** call, **inspect the page again** with **`get_dom_snapshot`** (or related tools) before the next action. Clicks often open modals, slide-overs, or rerendered regions; a fresh snapshot keeps the model aligned with what the user actually sees.

## Installation

1. **MCP server (npm)**  
   Install the published package (scope **`@leokok/poke-browser`**):

   ```bash
   npm install @leokok/poke-browser
   ```

   Run it via your MCP client (e.g. `npx -y @leokok/poke-browser`) or from a local checkout under `mcp-server/` with `npm install`, `npm run build`, and `npm start`. See [TESTING.md](./TESTING.md) for ports, env vars, and the inspector.

2. **Chrome extension**  
   Open `chrome://extensions`, enable **Developer mode**, **Load unpacked**, and select **this repository’s root folder** — the directory that contains `manifest.json` (the extension assets live alongside the manifest, not in a separate `extension/` directory).

3. **Connect**  
   Start the MCP server, load the extension, and align **WebSocket port** (and optional **auth token**) between the popup and `POKE_BROWSER_WS_PORT` / `POKE_BROWSER_TOKEN`.

## License

MIT — see [`mcp-server/package.json`](./mcp-server/package.json).

## Documentation

- **[TESTING.md](./TESTING.md)** — inspector payloads, WebSocket examples, troubleshooting.  
- **[mcp-server/README.md](./mcp-server/README.md)** — MCP server specifics and dev commands.
