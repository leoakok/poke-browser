import { spawn } from "node:child_process";
import type { Request, Response } from "express";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { bridge, readPort, startExtensionWebSocketServer } from "./transport.js";
import { createPokeBrowserMcpServer } from "./server.js";

const DEFAULT_MCP_HTTP_PORT = 8755;

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

async function runStdio(): Promise<void> {
  const WS_PORT = readPort();
  await startExtensionWebSocketServer(WS_PORT, bridge);

  const mcp = createPokeBrowserMcpServer();
  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  console.error(
    "[poke-browser-mcp] MCP stdio transport connected (ready for MCP clients)",
  );
}

async function runHttp(opts: {
  port: number;
  spawnTunnel: boolean;
}): Promise<void> {
  const WS_PORT = readPort();
  await startExtensionWebSocketServer(WS_PORT, bridge);

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

    const stopTunnel = (): void => {
      if (!tunnel.killed) tunnel.kill("SIGINT");
    };
    process.on("SIGINT", stopTunnel);
    process.on("SIGTERM", stopTunnel);
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
