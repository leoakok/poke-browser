import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import type { Request, Response } from "express";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import type { WebSocketServer } from "ws";
import {
  bridge,
  extensionWebSocketServer,
  readOptionalWebSocketAuthToken,
  readPort,
  startExtensionWebSocketServer,
} from "./transport.js";
import { log } from "./logger.js";
import { createPokeBrowserMcpServer } from "./server.js";

const DEFAULT_MCP_HTTP_PORT = 8755;

/** Prevents a second StdioServerTransport / mcp.connect in the same process (guards against accidental double-bind). */
let stdioMcpConnected = false;

/** Active stdio MCP transport (stdio mode only); closed on graceful shutdown. */
let mcpTransport: StdioServerTransport | null = null;

let tunnelChild: ChildProcess | null = null;

let processGuardsInstalled = false;

function installProcessGuards(): void {
  if (processGuardsInstalled) return;
  processGuardsInstalled = true;
  process.on("uncaughtException", (err) => {
    console.error("[poke-browser-mcp] uncaughtException:", err);
  });
  process.on("unhandledRejection", (reason) => {
    console.error("[poke-browser-mcp] unhandledRejection:", reason);
  });
}

let shutdownHandlersInstalled = false;

// Graceful shutdown - releases extension WebSocket port cleanly on SIGINT/SIGTERM
async function shutdown(signal: string): Promise<void> {
  log(`[poke-browser] Received ${signal}, shutting down...`);

  const wss = extensionWebSocketServer;
  if (wss) {
    for (const client of wss.clients) {
      try {
        client.terminate();
      } catch {
        /* ignore */
      }
    }

    await new Promise<void>((resolve) => {
      wss.close((err) => {
        if (err) log("[poke-browser] wss.close error:", err);
        else log("[poke-browser] WebSocket server closed, port released");
        resolve();
      });
    });
  }

  if (mcpTransport) {
    try {
      await mcpTransport.close();
    } catch {
      /* ignore */
    }
    mcpTransport = null;
  }

  if (tunnelChild && !tunnelChild.killed) {
    try {
      tunnelChild.kill("SIGINT");
    } catch {
      /* ignore */
    }
    tunnelChild = null;
  }

  log("[poke-browser] Shutdown complete");
  process.exit(0);
}

function shutdownWithTimeout(signal: string): void {
  const timer = setTimeout(() => {
    log("[poke-browser] Forced exit after 3s timeout");
    process.exit(1);
  }, 3000);
  timer.unref();
  void shutdown(signal).catch(() => process.exit(1));
}

function installShutdownHandlers(): void {
  if (shutdownHandlersInstalled) return;
  shutdownHandlersInstalled = true;
  process.on("SIGINT", () => shutdownWithTimeout("SIGINT"));
  process.on("SIGTERM", () => shutdownWithTimeout("SIGTERM"));
}

export type RunMode = "stdio" | "http" | "http-tunnel";

function readMcpHttpPortFromEnv(): number {
  const raw =
    process.env.POKE_BROWSER_MCP_PORT ??
    process.env.POKE_BROWSER_PORT ??
    process.env.POKE_TUNNEL_LOCAL_PORT;
  if (raw === undefined || raw === "") return DEFAULT_MCP_HTTP_PORT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 65535) {
    console.error(
      `[poke-browser-mcp] Invalid POKE_BROWSER_MCP_PORT="${raw}", using ${DEFAULT_MCP_HTTP_PORT}`,
    );
    return DEFAULT_MCP_HTTP_PORT;
  }
  return Math.trunc(n);
}

export function parseArgs(argv: string[]): {
  mode: RunMode;
  mcpHttpPort: number;
} {
  const tunnelIdx = argv.findIndex(
    (a) => a === "--poke-tunnel" || a === "--tunnel",
  );
  const httpIdx = argv.indexOf("--http");

  if (tunnelIdx !== -1) {
    const next = argv[tunnelIdx + 1];
    const port =
      next && /^\d+$/.test(next) ? Number(next) : readMcpHttpPortFromEnv();
    return { mode: "http-tunnel", mcpHttpPort: port };
  }

  if (httpIdx !== -1) {
    const next = argv[httpIdx + 1];
    const port =
      next && /^\d+$/.test(next) ? Number(next) : readMcpHttpPortFromEnv();
    return { mode: "http", mcpHttpPort: port };
  }

  return { mode: "stdio", mcpHttpPort: readMcpHttpPortFromEnv() };
}

function logAndStartExtensionWebSocket(port: number): Promise<WebSocketServer> {
  const authToken = readOptionalWebSocketAuthToken();
  if (authToken !== undefined) {
    console.error(`[poke-browser-mcp] WebSocket auth enabled (POKE_BROWSER_TOKEN): ${authToken}`);
    console.error(
      "[poke-browser-mcp] Set the extension popup Auth token (storage key wsAuthToken) to the same value.",
    );
  } else {
    log(
      `[poke-browser] WebSocket Server active on port ${port} (Mode: Development/Open)`,
    );
  }
  return startExtensionWebSocketServer(port, bridge, { authToken });
}

async function runStdio(): Promise<void> {
  const WS_PORT = readPort();
  try {
    await logAndStartExtensionWebSocket(WS_PORT);
  } catch (err) {
    console.error(
      "[poke-browser-mcp] WebSocket server failed to bind (is another poke-browser or process using the port?):",
      err,
    );
    process.exit(1);
  }

  /**
   * When stdin is a TTY or an MCP client pipe, data flows into MCP.
   * When stdin hits EOF (e.g. `node dist/index.js &` with closed stdin), piping with `end: false`
   * keeps the PassThrough readable open so StdioServerTransport is not torn down and the process
   * stays alive for the WebSocket server + Chrome extension.
   */
  process.stdin.resume();
  const mcpStdin = new PassThrough();
  process.stdin.pipe(mcpStdin, { end: false });
  process.stdin.on("error", (e: NodeJS.ErrnoException) => {
    console.error("[poke-browser-mcp] stdin error (WebSocket bridge keeps running):", e.message);
  });

  if (stdioMcpConnected) {
    console.error(
      "[poke-browser-mcp] Ignoring duplicate stdio MCP connect (already bound; WebSocket server still running)",
    );
    return;
  }

  const mcp = createPokeBrowserMcpServer();
  mcpTransport = new StdioServerTransport(mcpStdin, process.stdout);
  await mcp.connect(mcpTransport);
  stdioMcpConnected = true;
  installShutdownHandlers();
  console.error(
    "[poke-browser-mcp] MCP stdio transport connected (ready for MCP clients)",
  );
}

async function runHttp(opts: {
  port: number;
  spawnTunnel: boolean;
}): Promise<void> {
  const WS_PORT = readPort();
  try {
    await logAndStartExtensionWebSocket(WS_PORT);
  } catch (err) {
    console.error("[poke-browser-mcp] WebSocket server failed to bind:", err);
    process.exit(1);
  }

  const app = createMcpExpressApp();

  app.post("/mcp", async (req: Request, res: Response) => {
    const mcp = createPokeBrowserMcpServer();
    try {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on("close", () => {
        void transport.close();
        void mcp.close();
      });
    } catch (e) {
      console.error(e);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  app.get("/mcp", (_req: Request, res: Response) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    });
  });

  const { port } = opts;

  await new Promise<void>((resolve, reject) => {
    app.listen(port, "127.0.0.1", (err?: Error) => {
      if (err) reject(err);
      else resolve();
    });
  });

  installShutdownHandlers();

  const url = `http://127.0.0.1:${port}/mcp`;
  console.error(`[poke-browser-mcp] MCP (HTTP) → ${url}`);
  console.error(
    `[poke-browser-mcp] Extension WebSocket → ws://127.0.0.1:${WS_PORT}`,
  );
  console.error(
    `[poke-browser-mcp] Poke: npx --yes poke@latest tunnel ${url} -n "poke-browser"`,
  );

  if (opts.spawnTunnel) {
    console.error("[poke-browser-mcp] Tunnel output from Poke follows.");
    console.error("");

    const tunnel = spawn(
      "npx",
      ["--yes", "poke@latest", "tunnel", url, "-n", "poke-browser"],
      { stdio: "inherit", env: process.env },
    );

    tunnel.on("error", (err: NodeJS.ErrnoException) => {
      console.error(
        `[poke-browser-mcp] Could not start the Poke tunnel: ${err.message}`,
      );
      if (err.code === "ENOENT") {
        console.error(
          "[poke-browser-mcp] Ensure Node.js is installed (https://nodejs.org/)",
        );
      }
      process.exit(1);
    });

    tunnel.on("exit", (code) => {
      process.exit(code ?? 0);
    });

    tunnelChild = tunnel;
  }
}

export async function main(): Promise<void> {
  installProcessGuards();
  const { mode, mcpHttpPort } = parseArgs(process.argv.slice(2));

  if (mode === "stdio") {
    await runStdio();
    return;
  }

  await runHttp({
    port: mcpHttpPort,
    spawnTunnel: mode === "http-tunnel",
  });
}
