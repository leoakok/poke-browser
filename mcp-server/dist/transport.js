import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { log } from "./logger.js";
const WS_PING_INTERVAL_MS = 20_000;
const WS_PONG_DEADLINE_MS = 30_000;
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 10_000;
/** Strong ref so the server is never GC'd; also useful for tests. */
export let extensionWebSocketServer = null;
export const DEFAULT_PORT = 9009;
export const PENDING_REQUEST_TIMEOUT_MS = 10_000;
export const EVALUATE_JS_TIMEOUT_MS = 60_000;
/**
 * When `POKE_BROWSER_TOKEN` is set to a non-empty value (after trim), the extension `hello` must
 * include the same token. When unset/empty, WebSocket auth is disabled (zero-config / dev mode).
 */
export function readOptionalWebSocketAuthToken() {
    const raw = process.env.POKE_BROWSER_TOKEN;
    if (raw === undefined || raw === "")
        return undefined;
    const t = raw.trim();
    return t === "" ? undefined : t;
}
export class RateLimitError extends Error {
    retryAfter = 10;
    constructor() {
        super("rate_limit_exceeded");
        this.name = "RateLimitError";
    }
}
/**
 * WebSocket listen port for the Chrome extension (default 9009).
 * Uses `POKE_BROWSER_WS_PORT` or `WS_PORT`. Note: `POKE_BROWSER_PORT` in `run.ts` is the MCP HTTP
 * port, not this value; the extension stores its target port in chrome.storage (`wsPort`).
 */
export function readPort() {
    const raw = process.env.POKE_BROWSER_WS_PORT ?? process.env.WS_PORT;
    if (raw === undefined || raw === "")
        return DEFAULT_PORT;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0 || n > 65535) {
        console.error(`Invalid POKE_BROWSER_WS_PORT="${raw}", falling back to ${DEFAULT_PORT}`);
        return DEFAULT_PORT;
    }
    return Math.trunc(n);
}
/** Shown when tools run but no extension has completed the WebSocket `hello` handshake yet. */
export function extensionBridgeDisconnectedMessage() {
    const port = readPort();
    return `No Chrome extension connected. Load the poke-browser extension in Chrome first; it auto-connects to ws://127.0.0.1:${port}. If you use a custom port, set POKE_BROWSER_WS_PORT when starting this server and set the same WS port in the extension popup.`;
}
export function isRecord(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}
export function isScreenshotResultPayload(v) {
    if (!isRecord(v))
        return false;
    return (v.type === "screenshot_result" &&
        typeof v.data === "string" &&
        typeof v.mimeType === "string");
}
export function jsonText(data) {
    try {
        return JSON.stringify(data, null, 2);
    }
    catch (e) {
        return JSON.stringify({ error: "Failed to serialize result", detail: String(e) });
    }
}
export class ExtensionBridge {
    socket = null;
    rateTimestamps = [];
    pending = new Map();
    attachSocket(ws) {
        this.socket = ws;
    }
    clearSocket(ws) {
        if (this.socket === ws)
            this.socket = null;
    }
    isReady() {
        return this.socket !== null && this.socket.readyState === 1;
    }
    rejectAllPending(reason) {
        for (const [requestId, entry] of this.pending) {
            clearTimeout(entry.timer);
            entry.reject(new Error(reason));
            this.pending.delete(requestId);
        }
    }
    handleMessage(raw) {
        let msg;
        try {
            msg = JSON.parse(raw);
        }
        catch {
            return;
        }
        if (!isRecord(msg))
            return;
        if (msg.type === "response" && typeof msg.requestId === "string") {
            const entry = this.pending.get(msg.requestId);
            if (!entry)
                return;
            this.pending.delete(msg.requestId);
            clearTimeout(entry.timer);
            if (msg.ok === true) {
                entry.resolve(msg.result);
            }
            else {
                entry.reject(new Error(typeof msg.error === "string" ? msg.error : "Extension reported failure"));
            }
        }
    }
    request(command, payload, timeoutMs) {
        const sock = this.socket;
        if (!sock || sock.readyState !== 1) {
            return Promise.reject(new Error(extensionBridgeDisconnectedMessage()));
        }
        const now = Date.now();
        this.rateTimestamps = this.rateTimestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
        if (this.rateTimestamps.length >= RATE_LIMIT_MAX) {
            return Promise.reject(new RateLimitError());
        }
        this.rateTimestamps.push(now);
        const requestId = randomUUID();
        const body = { type: "command", requestId, command, payload };
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                if (this.pending.has(requestId)) {
                    this.pending.delete(requestId);
                    reject(new Error(`Extension did not respond in time (${timeoutMs}ms) for ${command}`));
                }
            }, timeoutMs);
            this.pending.set(requestId, { resolve, reject, timer });
            try {
                sock.send(JSON.stringify(body));
            }
            catch (e) {
                clearTimeout(timer);
                this.pending.delete(requestId);
                reject(e instanceof Error ? e : new Error(String(e)));
            }
        });
    }
}
export const bridge = new ExtensionBridge();
function waitForWebSocketListening(wss) {
    return new Promise((resolve, reject) => {
        const onListen = () => {
            wss.off("error", onErr);
            resolve();
        };
        const onErr = (err) => {
            wss.off("listening", onListen);
            reject(err);
        };
        wss.once("listening", onListen);
        wss.once("error", onErr);
    });
}
function isWsOriginAllowed(origin) {
    if (origin === undefined || origin === "")
        return true;
    return origin.startsWith("chrome-extension://");
}
/**
 * Binds the extension WebSocket server and resolves only after the port is listening
 * (avoids ERR_CONNECTION_REFUSED races with early client connects).
 */
export async function startExtensionWebSocketServer(port, b, options = {}) {
    /** Same-process guard: do not register a second `connection` handler or bind the same port twice. */
    if (extensionWebSocketServer !== null) {
        const addr = extensionWebSocketServer.address();
        if (addr !== null && typeof addr === "object" && "port" in addr && addr.port === port) {
            log("[poke-browser-mcp] WebSocket server already listening on this port; skipping duplicate start");
            return extensionWebSocketServer;
        }
    }
    const expectedToken = typeof options.authToken === "string" && options.authToken.length > 0
        ? options.authToken
        : undefined;
    const authRequired = expectedToken !== undefined;
    const wss = new WebSocketServer({ port, host: "127.0.0.1" });
    const trackedClients = new Set();
    /** Sockets that completed `hello`; used to promote the MCP bridge when the active client drops. */
    const authenticatedClients = new Set();
    // Exactly one `connection` listener on this `WebSocketServer` instance; duplicate `startExtensionWebSocketServer` for the same port is a no-op above.
    wss.on("error", (err) => {
        if (err.code === "EADDRINUSE") {
            log(`[poke-browser] Port ${port} is already in use.`);
            log(`[poke-browser] To free it: lsof -ti :${port} | xargs kill -9`);
            log(`[poke-browser] Or set POKE_BROWSER_WS_PORT=<other-port> to use a different WebSocket port.`);
            process.exit(1);
        }
        console.error("[poke-browser-mcp] WebSocket server error:", err);
    });
    wss.on("connection", (ws, req) => {
        const origin = req.headers.origin;
        if (!isWsOriginAllowed(origin)) {
            console.error(`[poke-browser-mcp] Rejected WebSocket connection from disallowed Origin: ${origin ?? "(none)"}`);
            try {
                ws.close(4403, "origin not allowed");
            }
            catch {
                /* ignore */
            }
            return;
        }
        // Allow multiple extension connections; do not close existing clients with 4000 (reconnect loop).
        trackedClients.add(ws);
        let authenticated = false;
        let pingInterval = null;
        let pongDeadline = null;
        /** Require two consecutive missed pongs before terminate (avoids flaky clients / scheduling glitches). */
        let missedPongs = 0;
        const clearPongDeadline = () => {
            if (pongDeadline) {
                clearTimeout(pongDeadline);
                pongDeadline = null;
            }
        };
        const stopPing = () => {
            if (pingInterval) {
                clearInterval(pingInterval);
                pingInterval = null;
            }
            clearPongDeadline();
        };
        const startPing = () => {
            stopPing();
            missedPongs = 0;
            pingInterval = setInterval(() => {
                if (ws.readyState !== WebSocket.OPEN)
                    return;
                clearPongDeadline();
                pongDeadline = setTimeout(() => {
                    missedPongs += 1;
                    if (missedPongs >= 2) {
                        console.error("[poke-browser-mcp] WebSocket client missed pong deadline twice; terminating client");
                        stopPing();
                        try {
                            ws.terminate();
                        }
                        catch {
                            /* ignore */
                        }
                    }
                }, WS_PONG_DEADLINE_MS);
                try {
                    ws.ping();
                }
                catch {
                    /* ignore */
                }
            }, WS_PING_INTERVAL_MS);
            pingInterval.unref();
        };
        try {
            ws.send(JSON.stringify({ type: "welcome", server: "poke-browser-mcp", version: 1 }));
        }
        catch {
            /* ignore */
        }
        ws.on("pong", () => {
            missedPongs = 0;
            clearPongDeadline();
        });
        ws.on("message", (data) => {
            const raw = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
            if (!authenticated) {
                let msg;
                try {
                    msg = JSON.parse(raw);
                }
                catch {
                    try {
                        ws.close(1003, "invalid json");
                    }
                    catch {
                        /* ignore */
                    }
                    return;
                }
                if (isRecord(msg) && msg.type === "ping") {
                    try {
                        ws.send(JSON.stringify({ type: "pong" }));
                    }
                    catch {
                        /* ignore */
                    }
                    return;
                }
                if (!isRecord(msg) || msg.type !== "hello") {
                    try {
                        ws.close(1008, "hello required");
                    }
                    catch {
                        /* ignore */
                    }
                    return;
                }
                const token = typeof msg.token === "string" ? msg.token : "";
                if (authRequired && token !== expectedToken) {
                    console.warn("[poke-browser-mcp] WebSocket auth rejected: token mismatch");
                    try {
                        ws.send(JSON.stringify({ type: "auth_error", error: "invalid_token" }));
                    }
                    catch {
                        /* ignore */
                    }
                    try {
                        ws.close(4401, "unauthorized");
                    }
                    catch {
                        /* ignore */
                    }
                    return;
                }
                authenticated = true;
                authenticatedClients.add(ws);
                b.attachSocket(ws);
                try {
                    ws.send(JSON.stringify({ type: "auth_ok" }));
                }
                catch {
                    /* ignore */
                }
                startPing();
                console.error(authRequired
                    ? "[poke-browser-mcp] Extension WebSocket client authenticated"
                    : "[poke-browser-mcp] Extension WebSocket client connected (dev mode, no token check)");
                return;
            }
            let appPing;
            try {
                appPing = JSON.parse(raw);
            }
            catch {
                b.handleMessage(raw);
                return;
            }
            if (isRecord(appPing) && appPing.type === "ping") {
                try {
                    ws.send(JSON.stringify({ type: "pong" }));
                }
                catch {
                    /* ignore */
                }
                return;
            }
            b.handleMessage(raw);
        });
        ws.on("close", () => {
            stopPing();
            trackedClients.delete(ws);
            if (authenticated) {
                authenticatedClients.delete(ws);
                b.clearSocket(ws);
                if (!b.isReady()) {
                    for (const c of authenticatedClients) {
                        if (c.readyState === WebSocket.OPEN) {
                            b.attachSocket(c);
                            break;
                        }
                    }
                }
                if (!b.isReady()) {
                    b.rejectAllPending("Chrome extension WebSocket disconnected");
                }
            }
            console.error("[poke-browser-mcp] Extension WebSocket client disconnected");
        });
        ws.on("error", (err) => {
            console.error("[poke-browser-mcp] WebSocket socket error:", err.message);
            stopPing();
            trackedClients.delete(ws);
        });
    });
    await waitForWebSocketListening(wss);
    extensionWebSocketServer = wss;
    console.error(`[poke-browser-mcp] WebSocket listening on ws://127.0.0.1:${port}`);
    console.error("[poke-browser-mcp] Load the poke-browser extension and keep this process running.");
    return wss;
}
//# sourceMappingURL=transport.js.map