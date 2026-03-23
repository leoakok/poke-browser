#!/usr/bin/env node
/**
 * Launcher for poke-browser MCP (same Poke auth + tunnel pattern as @leokok/poke-apple-music).
 * Auth: `npx poke@latest whoami` / `poke login` — not POKE_API_KEY.
 * Tunnel: `npx poke@latest tunnel <local /mcp URL> -n "<label>"` (stdio inherit).
 */
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stdin as input, stderr as output } from "node:process";

const require = createRequire(import.meta.url);
const pkg = require("./package.json");
const VERSION = pkg.version;

const root = dirname(fileURLToPath(import.meta.url));
const entry = join(root, "dist", "index.js");

const rawArgs = process.argv.slice(2);
const verboseCli =
  rawArgs.includes("--debug") || rawArgs.includes("--verbose");

const color =
  output.isTTY && !process.env.NO_COLOR
    ? {
        dim: (s) => `\x1b[2m${s}\x1b[0m`,
        bold: (s) => `\x1b[1m${s}\x1b[0m`,
        green: (s) => `\x1b[32m${s}\x1b[0m`,
        red: (s) => `\x1b[31m${s}\x1b[0m`,
        grey: (s) => `\x1b[90m${s}\x1b[0m`,
      }
    : {
        dim: (s) => s,
        bold: (s) => s,
        green: (s) => s,
        red: (s) => s,
        grey: (s) => s,
      };

/** Same check as poke-apple-music `checkPokeLogin`. */
function checkPokeLogin() {
  const r = spawnSync("npx", ["--yes", "poke@latest", "whoami"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  return r.status === 0;
}

/**
 * Same flow as poke-apple-music preflight: `poke whoami`, then `poke login` if needed.
 * Set POKE_BROWSER_SKIP_POKE_LOGIN=1 to skip (e.g. CI).
 */
function ensurePokeLoginForTunnel() {
  if (process.env.POKE_BROWSER_SKIP_POKE_LOGIN === "1") {
    return true;
  }
  if (checkPokeLogin()) {
    return true;
  }
  console.error(
    color.dim("  Not signed in to Poke (`npx poke@latest whoami` failed)."),
  );
  if (!input.isTTY) {
    console.error(
      color.red(
        "  Run `npx poke@latest login` in a terminal, or set POKE_BROWSER_SKIP_POKE_LOGIN=1.",
      ),
    );
    return false;
  }
  console.error(
    color.dim(
      "  Starting Poke login in your browser (complete the flow, then return here).",
    ),
  );
  const login = spawnSync("npx", ["--yes", "poke@latest", "login"], {
    stdio: "inherit",
    env: process.env,
  });
  if (login.status !== 0) {
    console.error(color.red("  `poke login` did not finish successfully."));
    return false;
  }
  if (!checkPokeLogin()) {
    console.error(color.red("  Still not signed in after login."));
    return false;
  }
  return true;
}

function extensionFolderPath() {
  return join(root, "..", "extension");
}

function printQuietStartupBanner() {
  const extPath = extensionFolderPath();
  console.error("");
  console.error(`  poke-browser v${VERSION}`);
  console.error("");
  console.error("  Load the Chrome extension:");
  console.error("");
  console.error("  1. Open chrome://extensions");
  console.error("");
  console.error("  2. Enable Developer Mode");
  console.error("");
  console.error("  3. Click Load unpacked → select the /extension folder");
  console.error(
    color.grey(
      "     (NOT the root — open poke-browser/extension specifically)",
    ),
  );
  console.error(color.dim(`     ${extPath}`));
  console.error("");
  console.error("  4. Extension auto-connects to this server");
  console.error("");
  console.error("  ★ Star us: https://github.com/leoakok/poke-browser");
  console.error("");
  console.error("  ─────────────────────────────────────");
  console.error("");
}

function childEnv() {
  const env = { ...process.env };
  if (verboseCli) env.POKE_BROWSER_VERBOSE = "1";
  return env;
}

if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
  console.error(`@leokok/poke-browser — MCP server for the poke-browser Chrome extension

Usage:
  poke-browser                    MCP over stdio (default; Cursor, Claude Desktop, etc.)
  poke-browser --poke-tunnel      HTTP MCP + Poke tunnel (same auth/tunnel pattern as poke-apple-music)
  poke-browser --http [port]      Streamable HTTP MCP on 127.0.0.1 (default: env POKE_BROWSER_MCP_PORT or 8755)
  poke-browser --tunnel [port]    Same as --http, then: npx poke@latest tunnel …/mcp
  poke-browser --debug            Verbose stderr ([poke-browser], WebSocket port, MCP debug)
  poke-browser --verbose          Same as --debug

Poke auth (tunnel flows):
  Uses the global Poke CLI — same as @leokok/poke-apple-music:
    npx poke@latest whoami    # must succeed before tunnel
    npx poke@latest login     # browser login if needed
  Optional: POKE_BROWSER_SKIP_POKE_LOGIN=1 to skip the whoami/login gate.

Environment:
  POKE_BROWSER_WS_PORT          WebSocket port for the extension (default 9009)
  POKE_BROWSER_MCP_PORT       HTTP MCP listen port for --http / tunnel (default 8755)
  POKE_BROWSER_PORT             Alias for HTTP MCP port (same as run.ts)
  POKE_BROWSER_TUNNEL_NAME      poke tunnel -n label (default: poke-browser)

Build once (or pass --build):
  npm run build
`);
  process.exit(0);
}

if (rawArgs.includes("--version") || rawArgs.includes("-v")) {
  console.error(pkg.version ?? "0.0.0");
  process.exit(0);
}

const wantBuild = rawArgs.includes("--build");
const wantPokeTunnelFlow =
  process.env.npm_lifecycle_event === "start:tunnel" ||
  rawArgs.includes("--poke-tunnel");
const childArgs = rawArgs.filter(
  (a) =>
    a !== "--build" &&
    a !== "--poke-tunnel" &&
    a !== "--debug" &&
    a !== "--verbose",
);

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

printQuietStartupBanner();

if (wantPokeTunnelFlow) {
  if (!ensurePokeLoginForTunnel()) {
    process.exit(1);
  }
  console.error(color.green("  Signed in to Poke — starting HTTP MCP and tunnel."));
  console.error(
    color.dim("  Poke can use poke-browser while this window stays open."),
  );
  console.error("");
  const rawHttp =
    process.env.POKE_BROWSER_MCP_PORT ??
    process.env.POKE_BROWSER_PORT ??
    "8755";
  const httpPort = Number(rawHttp);
  const portArg =
    Number.isFinite(httpPort) && httpPort > 0 && httpPort <= 65535
      ? String(Math.trunc(httpPort))
      : "8755";
  const r = spawnSync(
    process.execPath,
    [entry, "--http", portArg, "--tunnel", ...childArgs],
    { stdio: "inherit", env: childEnv() },
  );
  process.exit(r.status ?? 1);
}

const r = spawnSync(process.execPath, [entry, ...childArgs], {
  stdio: "inherit",
  env: childEnv(),
});
process.exit(r.status ?? 1);
