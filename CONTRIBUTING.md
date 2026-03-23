# Contributing

Thanks for helping improve **poke-browser** (Chrome extension + MCP server). Small, focused changes are easiest to review.

## Local setup

```bash
cd mcp-server
npm install
npm run build
npm start
```

Load the extension from the repo root in `chrome://extensions` (Developer mode → **Load unpacked**). For end-to-end checks, env vars, and MCP Inspector examples, see [TESTING.md](./TESTING.md) and [mcp-server/README.md](./mcp-server/README.md).

## Pull requests

- Open a PR against **`main`** when you can so CI (if present) runs on the branch.
- Prefer [Conventional Commits](https://www.conventionalcommits.org/) in commit messages (`fix:`, `feat:`, `docs:`, `chore:`, …) so history stays readable.

## Scope

This repo is the extension assets at the root plus **`mcp-server/`**. Keep changes aligned with the existing WebSocket transport and tool surface documented in the README.
