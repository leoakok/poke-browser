#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const entry = join(root, "dist", "index.js");

const rawArgs = process.argv.slice(2);

function pkgJson() {
  return JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
}

if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
  console.log(`@leokok/poke-browser — MCP server for the poke-browser Chrome extension

Usage:
  poke-browser                  MCP over stdio (default; Cursor, Claude Desktop, etc.)
  poke-browser --http [port]    Streamable HTTP MCP on 127.0.0.1 (default port: env POKE_BROWSER_MCP_PORT or 8755)
  poke-browser --tunnel [port]  Same as --http, then run: npx poke tunnel http://127.0.0.1:<port>/mcp

Environment:
  POKE_BROWSER_WS_PORT   WebSocket port for the extension (default 9009)
  POKE_BROWSER_MCP_PORT  HTTP MCP listen port when using --http / --tunnel

Build once (or pass --build):
  npm run build
`);
  process.exit(0);
}

if (rawArgs.includes("--version") || rawArgs.includes("-v")) {
  console.log(pkgJson().version ?? "0.0.0");
  process.exit(0);
}

const wantBuild = rawArgs.includes("--build");
const childArgs = rawArgs.filter((a) => a !== "--build");

function runBuild() {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const b = spawnSync(npm, ["run", "build"], {
    cwd: root,
    stdio: "inherit",
    env: process.env,
  });
  if (b.error) {
    console.error(b.error);
    process.exit(1);
  }
  if (b.status !== 0) {
    process.exit(b.status ?? 1);
  }
}

if (wantBuild) {
  runBuild();
}

if (!existsSync(entry)) {
  console.error(
    "poke-browser: missing dist/. Run `npm run build` in this package, or pass `--build` once.",
  );
  process.exit(1);
}

const { name, version } = pkgJson();
console.error(
  `[${name}] v${version} — starting (extension WS: env POKE_BROWSER_WS_PORT; HTTP MCP: --http / --tunnel)`,
);

const r = spawnSync(process.execPath, [entry, ...childArgs], {
  stdio: "inherit",
});
process.exit(r.status ?? 1);
