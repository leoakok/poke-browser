import { randomBytes, randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
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
 * Shared secret for the extension `hello` handshake. Set `POKE_BROWSER_TOKEN` to pin a value;
 * otherwise a random token is generated each process start (printed to stderr).
 */
export function readWebSocketAuthToken() {
    const raw = process.env.POKE_BROWSER_TOKEN;
    if (raw !== undefined && raw !== "")
        return raw;
    return randomBytes(24).toString("hex");
}
export class RateLimitError extends Error {
    retryAfter = 10;
    constructor() {
        super("rate_limit_exceeded");
        this.name = "RateLimitError";
    }
}
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
            return Promise.reject(new Error("Chrome extension is not connected to the MCP WebSocket server"));
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
export async function startExtensionWebSocketServer(port, b, options) {
    const { authToken } = options;
    const wss = new WebSocketServer({ port, host: "127.0.0.1" });
    const trackedClients = new Set();
    wss.on("error", (err) => {
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
        for (const client of wss.clients) {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
                try {
                    client.close(4000, "replaced by new poke-browser connection");
                }
                catch {
                    /* ignore */
                }
            }
        }
        trackedClients.add(ws);
        let authenticated = false;
        let pingInterval = null;
        let pongDeadline = null;
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
            pingInterval = setInterval(() => {
                if (ws.readyState !== WebSocket.OPEN)
                    return;
                clearPongDeadline();
                pongDeadline = setTimeout(() => {
                    console.error("[poke-browser-mcp] WebSocket client missed pong deadline; terminating client");
                    try {
                        ws.terminate();
                    }
                    catch {
                        /* ignore */
                    }
                }, WS_PONG_DEADLINE_MS);
                try {
                    ws.ping();
                }
                catch {
                    /* ignore */
                }
            }, WS_PING_INTERVAL_MS);
        };
        try {
            ws.send(JSON.stringify({ type: "welcome", server: "poke-browser-mcp", version: 1 }));
        }
        catch {
            /* ignore */
        }
        ws.on("pong", () => {
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
                if (token !== authToken) {
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
                b.attachSocket(ws);
                try {
                    ws.send(JSON.stringify({ type: "auth_ok" }));
                }
                catch {
                    /* ignore */
                }
                startPing();
                console.error("[poke-browser-mcp] Extension WebSocket client authenticated");
                return;
            }
            b.handleMessage(raw);
        });
        ws.on("close", () => {
            stopPing();
            trackedClients.delete(ws);
            if (authenticated) {
                b.clearSocket(ws);
                b.rejectAllPending("Chrome extension WebSocket disconnected");
            }
            console.error("[poke-browser-mcp] Extension WebSocket client disconnected");
        });
        ws.on("error", (err) => {
            console.error("[poke-browser-mcp] WebSocket socket error:", err.message);
        });
    });
    await waitForWebSocketListening(wss);
    extensionWebSocketServer = wss;
    console.error(`[poke-browser-mcp] WebSocket listening on ws://127.0.0.1:${port}`);
    console.error("[poke-browser-mcp] Load the poke-browser extension and keep this process running.");
    return wss;
}
//# sourceMappingURL=transport.js.map