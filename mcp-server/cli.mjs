#!/usr/bin/env node
/**
 * Launcher for poke-browser MCP (same Poke auth + tunnel pattern as @leokok/poke-apple-music).
 * Auth: `npx poke@latest whoami` / `poke login` — not POKE_API_KEY.
 * Tunnel: `npx poke@latest tunnel <local /mcp URL> -n "<label>"` (stdio inherit).
 *
 * Mode selection (first match wins):
 *   1. stdin is a pipe (not TTY)  → stdio MCP mode (Cursor, Claude Desktop, etc.)
 *   2. --http or --stdio flag     → explicit HTTP / stdio mode
 *   3. everything else            → poke-tunnel mode (interactive terminal)
 */
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stdin as input, stderr as output } from "node:process";

async function findAvailablePort(startPort) {
  const net = await import("node:net");
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(startPort, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on("error", () => resolve(findAvailablePort(startPort + 1)));
  });
}

// Handle setup command
if (process.argv.includes("setup") || process.argv.includes("--install")) {
  const { cp, mkdir } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  const __dir = dirname(fileURLToPath(import.meta.url));
  const srcExt = resolve(__dir, "..", "extension");
  const destExt = resolve(process.cwd(), "poke-browser-extension");
  try {
    await mkdir(destExt, { recursive: true });
    await cp(srcExt, destExt, { recursive: true, force: true });
    console.log("\n  poke-browser setup complete!\n");
    console.log("  Extension copied to: " + destExt + "\n");
    console.log("  Next: open chrome://extensions, enable Developer Mode,");
    console.log('  click "Load unpacked" and select: ' + destExt + "\n");
  } catch (e) {
    console.error("  Setup failed:", e.message);
  }
  process.exit(0);
}

const require = createRequire(import.meta.url);
const pkg = require("./package.json");
const VERSION = pkg.version;

const root = dirname(fileURLToPath(import.meta.url));
const entry = join(root, "dist", "index.js");

const rawArgs = process.argv.slice(2);
const verboseCli =
  rawArgs.includes("--debug") || rawArgs.includes("--verbose");
const autoYes = rawArgs.includes("-y") || rawArgs.includes("--yes");

/** Same shape as @leokok/poke-agents `argAfter` (used there for `--mcp-name`). */
function argAfter(flag) {
  const i = process.argv.indexOf(flag);
  if (i === -1) return null;
  const v = process.argv[i + 1];
  if (v == null || String(v).startsWith("-")) return null;
  return String(v);
}

function slugifyMcpServerName(s) {
  const t = String(s)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (t.length === 0) return "poke-browser-mcp";
  return t.length > 64 ? t.slice(0, 64) : t;
}

/** Custom Poke tunnel `-n` label + MCP `initialize` server name. */
const customMcpName = argAfter("--name") ?? argAfter("-n");

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
  const inPkg = join(root, "extension");
  if (existsSync(inPkg)) return inPkg;
  return join(root, "..", "extension");
}

function printQuietStartupBanner({
  mcpPort,
  wsPort,
  mcpDesiredStart,
  wsDesiredStart,
  showMcpLine,
}) {
  const extPath = extensionFolderPath();
  const mcpAuto = mcpPort !== mcpDesiredStart ? " (auto-selected)" : "";
  const wsAuto = wsPort !== wsDesiredStart ? " (auto-selected)" : "";
  console.error("");
  console.error(
    customMcpName
      ? `  Poke 🌴 / Browser v${VERSION} (as "${customMcpName}")`
      : `  Poke 🌴 / Browser v${VERSION}`,
  );
  console.error(`  ${color.dim("Quick start:")} keep this running, then use your MCP client.`);
  console.error(`  ${color.dim("Guide: https://github.com/leoakok/poke-browser")}`);
  console.error(`  ${color.dim("Load extension folder:")} ${extPath}`);
  console.error("");
  if (showMcpLine) {
    console.error(
      `  Local MCP:  http://127.0.0.1:${mcpPort}/mcp${mcpAuto}`,
    );
  }
  console.error(`  Local WS:   ws://127.0.0.1:${wsPort}${wsAuto}`);
  console.error("");
}

function childEnv() {
  const env = { ...process.env };
  if (verboseCli) env.POKE_BROWSER_VERBOSE = "1";
  if (customMcpName) {
    env.POKE_BROWSER_TUNNEL_NAME = customMcpName;
    env.POKE_BROWSER_MCP_SERVER_NAME = slugifyMcpServerName(customMcpName);
  }
  return env;
}

if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
  console.error(`Poke 🌴 / Browser

Usage:
  poke-browser [--stdio|--http PORT|--tunnel PORT] [-n NAME] [-y]

Options:
  -h, --help          show help
  -v, --version       show version
  -y, --yes           compatibility no-op
  -n, --name NAME     tunnel label + MCP server name
  --stdio             force stdio MCP mode
  --http [port]       local HTTP MCP mode
  --tunnel [port]     HTTP MCP + poke tunnel
  --debug             verbose logs

Guide:
  https://github.com/leoakok/poke-browser
`);
  process.exit(0);
}

if (rawArgs.includes("--version") || rawArgs.includes("-v")) {
  console.error(pkg.version ?? "0.0.0");
  process.exit(0);
}

if (autoYes) {
  // Kept intentionally as a no-op to align launcher interfaces across poke CLIs.
  process.env.POKE_BROWSER_YES = "1";
}

const wantBuild = rawArgs.includes("--build");

/**
 * Tunnel mode is active when ANY of:
 *   1. npm run start:tunnel lifecycle
 *   2. explicit --poke-tunnel flag
 *   3. --name flag (custom label implies tunnel intent)
 *   4. stdin is an interactive TTY AND no explicit --http / --stdio / pipe mode
 *
 * stdio mode (for Cursor / Claude Desktop) is used when:
 *   - stdin is NOT a TTY (process is spawned with a pipe), OR
 *   - --stdio flag is explicitly passed, OR
 *   - --http flag is explicitly passed
 */
const wantStdioMode =
  !input.isTTY ||
  rawArgs.includes("--stdio") ||
  rawArgs.includes("--http");

const wantPokeTunnelFlow =
  !wantStdioMode ||
  process.env.npm_lifecycle_event === "start:tunnel" ||
  rawArgs.includes("--poke-tunnel") ||
  !!customMcpName;

const childArgs = rawArgs.filter((a, i, arr) => {
  if (
    a === "--build" ||
    a === "--poke-tunnel" ||
    a === "--stdio" ||
    a === "--debug" ||
    a === "--verbose" ||
    a === "--name" ||
    a === "-n" ||
    a === "--yes" ||
    a === "-y"
  ) {
    return false;
  }
  if (i > 0 && (arr[i - 1] === "--name" || arr[i - 1] === "-n")) return false;
  return true;
});

function readMcpDesiredStartFromCliArgs(args) {
  const i = args.indexOf("--http");
  if (i === -1) return null;
  const next = args[i + 1];
  if (next != null && /^\d+$/.test(String(next))) return Math.trunc(Number(next));
  return null;
}

function readMcpDesiredStart(args) {
  const fromCli = readMcpDesiredStartFromCliArgs(args);
  if (fromCli !== null) return fromCli;
  const raw =
    process.env.POKE_BROWSER_MCP_PORT ??
    process.env.POKE_BROWSER_PORT ??
    "8755";
  const httpPort = Number(raw);
  return Number.isFinite(httpPort) && httpPort > 0 && httpPort <= 65535
    ? Math.trunc(httpPort)
    : 8755;
}

function readWsDesiredStart() {
  const raw = process.env.POKE_BROWSER_WS_PORT ?? "9009";
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n <= 65535 ? Math.trunc(n) : 9009;
}

function cloneArgsWithResolvedMcpPort(args, mcpPort) {
  const out = [...args];
  const i = out.indexOf("--http");
  if (i !== -1 && out[i + 1] != null && /^\d+$/.test(String(out[i + 1]))) {
    out[i + 1] = String(mcpPort);
  }
  return out;
}

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

(async () => {
  const mcpDesiredStart = readMcpDesiredStart(childArgs);
  const wsDesiredStart = readWsDesiredStart();
  const mcpPort = await findAvailablePort(mcpDesiredStart);
  const wsPort = await findAvailablePort(wsDesiredStart);
  const showMcpLine =
    wantPokeTunnelFlow || childArgs.includes("--http");
  const envWithPorts = {
    ...childEnv(),
    POKE_BROWSER_MCP_PORT: String(mcpPort),
    POKE_BROWSER_WS_PORT: String(wsPort),
  };

  printQuietStartupBanner({
    mcpPort,
    wsPort,
    mcpDesiredStart,
    wsDesiredStart,
    showMcpLine,
  });

  // Check for newer version (non-blocking)
  (async () => {
    try {
      const https = await import("node:https");
      const latest = await new Promise((resolve, reject) => {
        const req = https.get(
          "https://registry.npmjs.org/poke-browser/latest",
          { timeout: 3000 },
          (res) => {
            let data = "";
            res.on("data", (d) => (data += d));
            res.on("end", () => {
              try {
                resolve(JSON.parse(data).version);
              } catch {
                reject();
              }
            });
          },
        );
        req.on("error", reject);
        req.on("timeout", () => {
          req.destroy();
          reject();
        });
      });
      const current = pkg.version;
      if (latest && latest !== current) {
        console.error(`  ${color.red("New version available:")} poke-browser@${latest}`);
        console.error(`  ${color.dim("Run: npx poke-browser@latest")}`);
        console.error("");
      }
    } catch {}
  })();

  const resolvedChildArgs = cloneArgsWithResolvedMcpPort(childArgs, mcpPort);

  if (wantPokeTunnelFlow) {
    if (!ensurePokeLoginForTunnel()) {
      process.exit(1);
    }
    console.error(color.green("  Signed in to Poke \u2014 starting HTTP MCP and tunnel."));
    console.error(
      color.dim("  Poke can use poke-browser while this window stays open."),
    );
    console.error("");
    const r = spawnSync(
      process.execPath,
      [
        entry,
        "--http",
        String(mcpPort),
        "--tunnel",
        ...(customMcpName ? ["--name", customMcpName] : []),
        ...resolvedChildArgs,
      ],
      { stdio: "inherit", env: envWithPorts },
    );
    process.exit(r.status ?? 1);
  }

  // stdio mode: Cursor / Claude Desktop (stdin is a pipe)
  const r = spawnSync(process.execPath, [entry, ...resolvedChildArgs], {
    stdio: "inherit",
    env: envWithPorts,
  });
  process.exit(r.status ?? 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
