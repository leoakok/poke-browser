import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { PassThrough } from "node:stream";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { bridge, extensionWebSocketServer, readOptionalWebSocketAuthToken, readPort, startExtensionWebSocketServer, } from "./transport.js";
import { log, logError, logNotice } from "./logger.js";
import { createPokeBrowserMcpServer } from "./server.js";
const DEFAULT_MCP_HTTP_PORT = 8755;
/** Prevents a second StdioServerTransport / mcp.connect in the same process (guards against accidental double-bind). */
let stdioMcpConnected = false;
/** Active stdio MCP transport (stdio mode only); closed on graceful shutdown. */
let mcpTransport = null;
let tunnelChild = null;
let pokeProxyServerRunning = false;
let processGuardsInstalled = false;
function installProcessGuards() {
    if (processGuardsInstalled)
        return;
    processGuardsInstalled = true;
    process.on("uncaughtException", (err) => {
        logError("[poke-browser-mcp] uncaughtException:", err);
    });
    process.on("unhandledRejection", (reason) => {
        logError("[poke-browser-mcp] unhandledRejection:", reason);
    });
}
let shutdownHandlersInstalled = false;
// Graceful shutdown - releases extension WebSocket port cleanly on SIGINT/SIGTERM
async function shutdown(signal) {
    log(`[poke-browser] Received ${signal}, shutting down...`);
    const wss = extensionWebSocketServer;
    if (wss) {
        for (const client of wss.clients) {
            try {
                client.terminate();
            }
            catch {
                /* ignore */
            }
        }
        await new Promise((resolve) => {
            wss.close((err) => {
                if (err)
                    log("[poke-browser] wss.close error:", err);
                else
                    log("[poke-browser] WebSocket server closed, port released");
                resolve();
            });
        });
    }
    if (mcpTransport) {
        try {
            await mcpTransport.close();
        }
        catch {
            /* ignore */
        }
        mcpTransport = null;
    }
    if (tunnelChild && !tunnelChild.killed) {
        try {
            tunnelChild.kill("SIGINT");
        }
        catch {
            /* ignore */
        }
        tunnelChild = null;
    }
    log("[poke-browser] Shutdown complete");
    process.exit(0);
}
function shutdownWithTimeout(signal) {
    const timer = setTimeout(() => {
        log("[poke-browser] Forced exit after 3s timeout");
        process.exit(1);
    }, 3000);
    timer.unref();
    void shutdown(signal).catch(() => process.exit(1));
}
function installShutdownHandlers() {
    if (shutdownHandlersInstalled)
        return;
    shutdownHandlersInstalled = true;
    process.on("SIGINT", () => shutdownWithTimeout("SIGINT"));
    process.on("SIGTERM", () => shutdownWithTimeout("SIGTERM"));
}
function readRequestBody(req, limitBytes = 64 * 1024) {
    return new Promise((resolve, reject) => {
        let body = "";
        let size = 0;
        req.setEncoding("utf8");
        req.on("data", (chunk) => {
            size += Buffer.byteLength(chunk, "utf8");
            if (size > limitBytes) {
                reject(new Error("Request body too large"));
                req.destroy();
                return;
            }
            body += chunk;
        });
        req.on("end", () => resolve(body));
        req.on("error", reject);
    });
}
function writeJson(res, status, payload) {
    const body = JSON.stringify(payload);
    res.statusCode = status;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("content-length", String(Buffer.byteLength(body, "utf8")));
    // Allow extension clients (chrome-extension://...) to call localhost proxy.
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-methods", "POST, OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type");
    res.end(body);
}
async function startPokeLocalProxyServer(wsPort) {
    if (pokeProxyServerRunning)
        return;
    const proxyPort = wsPort + 1;
    const server = createServer(async (req, res) => {
        if (req.method === "OPTIONS") {
            res.statusCode = 204;
            res.setHeader("access-control-allow-origin", "*");
            res.setHeader("access-control-allow-methods", "POST, OPTIONS");
            res.setHeader("access-control-allow-headers", "content-type");
            res.end();
            return;
        }
        if (req.method !== "POST" || req.url !== "/poke/send-message") {
            writeJson(res, 404, { error: "Not found" });
            return;
        }
        try {
            const raw = await readRequestBody(req);
            let parsed;
            try {
                parsed = JSON.parse(raw);
            }
            catch {
                writeJson(res, 400, { error: "Invalid JSON body" });
                return;
            }
            const body = parsed && typeof parsed === "object" ? parsed : {};
            const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
            const message = typeof body.message === "string" ? body.message : "";
            if (!apiKey || !message.trim()) {
                writeJson(res, 400, { error: "apiKey and message are required" });
                return;
            }
            const upstream = await fetch("https://poke.com/api/v1/inbound/api-message", {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ message }),
            });
            const text = await upstream.text();
            let json = { error: { message: text || upstream.statusText, status: upstream.status } };
            try {
                json = JSON.parse(text);
            }
            catch {
                // keep fallback object
            }
            writeJson(res, upstream.status, json);
        }
        catch (err) {
            writeJson(res, 500, {
                error: {
                    message: err instanceof Error ? err.message : String(err),
                    status: 500,
                },
            });
        }
    });
    await new Promise((resolve, reject) => {
        server.listen(proxyPort, "127.0.0.1", (err) => {
            if (err)
                reject(err);
            else
                resolve();
        });
    });
    pokeProxyServerRunning = true;
    log(`[poke-browser-mcp] Local Poke proxy → http://127.0.0.1:${proxyPort}/poke/send-message`);
}
function readMcpHttpPortFromEnv() {
    const raw = process.env.POKE_BROWSER_MCP_PORT ??
        process.env.POKE_BROWSER_PORT ??
        process.env.POKE_TUNNEL_LOCAL_PORT;
    if (raw === undefined || raw === "")
        return DEFAULT_MCP_HTTP_PORT;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0 || n > 65535) {
        logError(`[poke-browser-mcp] Invalid POKE_BROWSER_MCP_PORT="${raw}", using ${DEFAULT_MCP_HTTP_PORT}`);
        return DEFAULT_MCP_HTTP_PORT;
    }
    return Math.trunc(n);
}
export function parseArgs(argv) {
    const tunnelIdx = argv.findIndex((a) => a === "--poke-tunnel" || a === "--tunnel");
    const httpIdx = argv.indexOf("--http");
    if (tunnelIdx !== -1) {
        const next = argv[tunnelIdx + 1];
        const port = next && /^\d+$/.test(next) ? Number(next) : readMcpHttpPortFromEnv();
        return { mode: "http-tunnel", mcpHttpPort: port };
    }
    if (httpIdx !== -1) {
        const next = argv[httpIdx + 1];
        const port = next && /^\d+$/.test(next) ? Number(next) : readMcpHttpPortFromEnv();
        return { mode: "http", mcpHttpPort: port };
    }
    return { mode: "stdio", mcpHttpPort: readMcpHttpPortFromEnv() };
}
/** Read-only: if something is already listening on `port`, warn (never kills). */
function maybeReportExistingListenerOnPort(port) {
    if (process.platform === "win32")
        return;
    try {
        const out = execFileSync("lsof", ["-i", `:${port}`, "-sTCP:LISTEN"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
            maxBuffer: 64_000,
        });
        if (out.trim().length > 0) {
            log(`[poke-browser] Port ${port} already has a TCP listener (run: lsof -i :${port}). This process will still try to bind; if it fails, set POKE_BROWSER_WS_PORT or stop the other process.`);
        }
    }
    catch {
        /* lsof unavailable or no matching listeners */
    }
}
function logAndStartExtensionWebSocket(port) {
    maybeReportExistingListenerOnPort(port);
    const authToken = readOptionalWebSocketAuthToken();
    if (authToken !== undefined) {
        log(`[poke-browser-mcp] WebSocket auth enabled (POKE_BROWSER_TOKEN): ${authToken}`);
        log("[poke-browser-mcp] Set the extension popup Auth token (storage key wsAuthToken) to the same value.");
    }
    else {
        log(`[poke-browser] WebSocket Server active on port ${port} (Mode: Development/Open)`);
    }
    return startExtensionWebSocketServer(port, bridge, { authToken });
}
async function runStdio() {
    const WS_PORT = readPort();
    try {
        await logAndStartExtensionWebSocket(WS_PORT);
        await startPokeLocalProxyServer(WS_PORT);
    }
    catch (err) {
        logError("[poke-browser-mcp] WebSocket server failed to bind (is another poke-browser or process using the port?):", err);
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
    process.stdin.on("error", (e) => {
        log("[poke-browser-mcp] stdin error (WebSocket bridge keeps running):", e.message);
    });
    if (stdioMcpConnected) {
        log("[poke-browser-mcp] Ignoring duplicate stdio MCP connect (already bound; WebSocket server still running)");
        return;
    }
    const mcp = createPokeBrowserMcpServer();
    mcpTransport = new StdioServerTransport(mcpStdin, process.stdout);
    await mcp.connect(mcpTransport);
    stdioMcpConnected = true;
    installShutdownHandlers();
    log("[poke-browser-mcp] MCP stdio transport connected (ready for MCP clients)");
    log("[poke-browser] MCP stdio transport ready");
    log("[poke-browser] Ready. Load the Chrome extension and connect your MCP client.");
}
async function runHttp(opts) {
    const WS_PORT = readPort();
    try {
        await logAndStartExtensionWebSocket(WS_PORT);
        await startPokeLocalProxyServer(WS_PORT);
    }
    catch (err) {
        logError("[poke-browser-mcp] WebSocket server failed to bind:", err);
        process.exit(1);
    }
    const app = createMcpExpressApp();
    app.post("/mcp", async (req, res) => {
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
        }
        catch (e) {
            logError(e);
            if (!res.headersSent) {
                res.status(500).json({
                    jsonrpc: "2.0",
                    error: { code: -32603, message: "Internal server error" },
                    id: null,
                });
            }
        }
    });
    app.get("/mcp", (_req, res) => {
        res.status(405).json({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Method not allowed." },
            id: null,
        });
    });
    const { port } = opts;
    await new Promise((resolve, reject) => {
        app.listen(port, "127.0.0.1", (err) => {
            if (err)
                reject(err);
            else
                resolve();
        });
    });
    installShutdownHandlers();
    const url = `http://127.0.0.1:${port}/mcp`;
    log(`[poke-browser-mcp] MCP (HTTP) → ${url}`);
    log(`[poke-browser-mcp] Extension WebSocket → ws://127.0.0.1:${WS_PORT}`);
    log(`[poke-browser] MCP HTTP transport ready at ${url}`);
    const pokeTunnelLabel = process.env.POKE_BROWSER_TUNNEL_NAME?.trim() || "poke-browser";
    if (opts.spawnTunnel) {
        log("[poke-browser-mcp] Tunnel output from Poke follows.");
        log("");
        const tunnel = spawn("npx", [
            "--yes",
            "poke@latest",
            "tunnel",
            url,
            "-n",
            pokeTunnelLabel,
        ], { stdio: "inherit", env: process.env });
        tunnel.on("error", (err) => {
            logError(`[poke-browser-mcp] Could not start the Poke tunnel: ${err.message}`);
            if (err.code === "ENOENT") {
                logError("[poke-browser-mcp] Ensure Node.js is installed (https://nodejs.org/)");
            }
            process.exit(1);
        });
        tunnel.on("exit", (code) => {
            process.exit(code ?? 0);
        });
        tunnelChild = tunnel;
        setTimeout(() => {
            logNotice(`  Local WS:  ws://127.0.0.1:${WS_PORT}`);
            log("[poke-browser] Ready. Load the Chrome extension and connect your MCP client.");
        }, 2500);
    }
    else {
        log(`[poke-browser-mcp] Poke: npx --yes poke@latest tunnel ${url} -n "${pokeTunnelLabel}"`);
        log("[poke-browser] Ready. Load the Chrome extension and connect your MCP client.");
    }
}
export async function main() {
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
//# sourceMappingURL=run.js.map