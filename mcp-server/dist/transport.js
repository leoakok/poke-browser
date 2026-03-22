import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { WebSocketServer, WebSocket } from "ws";
const WS_PING_INTERVAL_MS = 20_000;
const WS_PONG_DEADLINE_MS = 30_000;
/** Strong ref so the server is never GC'd; also useful for tests. */
export let extensionWebSocketServer = null;
export const DEFAULT_PORT = 9009;
export const PENDING_REQUEST_TIMEOUT_MS = 10_000;
export const EVALUATE_JS_TIMEOUT_MS = 60_000;
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
        if (msg.type === "hello") {
            console.error("[poke-browser-mcp] Extension connected:", jsonText(msg));
            return;
        }
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
/**
 * Binds the extension WebSocket server and resolves only after the port is listening
 * (avoids ERR_CONNECTION_REFUSED races with early client connects).
 */
export async function startExtensionWebSocketServer(port, b) {
    const wss = new WebSocketServer({ port, host: "127.0.0.1" });
    const trackedClients = new Set();
    wss.on("error", (err) => {
        console.error("[poke-browser-mcp] WebSocket server error:", err);
    });
    wss.on("connection", (ws) => {
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
        b.attachSocket(ws);
        console.error("[poke-browser-mcp] Extension WebSocket client connected");
        let pongDeadline = null;
        const clearPongDeadline = () => {
            if (pongDeadline) {
                clearTimeout(pongDeadline);
                pongDeadline = null;
            }
        };
        const pingInterval = setInterval(() => {
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
        ws.on("pong", () => {
            clearPongDeadline();
        });
        ws.on("message", (data) => {
            const raw = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
            b.handleMessage(raw);
        });
        ws.on("close", () => {
            clearInterval(pingInterval);
            clearPongDeadline();
            trackedClients.delete(ws);
            b.clearSocket(ws);
            b.rejectAllPending("Chrome extension WebSocket disconnected");
            console.error("[poke-browser-mcp] Extension WebSocket client disconnected");
        });
        ws.on("error", (err) => {
            console.error("[poke-browser-mcp] WebSocket socket error:", err.message);
        });
    });
    await once(wss, "listening");
    extensionWebSocketServer = wss;
    console.error(`[poke-browser-mcp] WebSocket listening on ws://127.0.0.1:${port}`);
    console.error("[poke-browser-mcp] Load the poke-browser extension and keep this process running.");
    return wss;
}
//# sourceMappingURL=transport.js.map