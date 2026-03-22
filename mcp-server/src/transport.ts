import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";

const WS_PING_INTERVAL_MS = 20_000;
const WS_PONG_DEADLINE_MS = 30_000;

/** Strong ref so the server is never GC'd; also useful for tests. */
export let extensionWebSocketServer: WebSocketServer | null = null;

export const DEFAULT_PORT = 9009;
export const PENDING_REQUEST_TIMEOUT_MS = 10_000;
export const EVALUATE_JS_TIMEOUT_MS = 60_000;

export type ExtensionCommand =
  | "list_tabs"
  | "get_active_tab"
  | "navigate_to"
  | "click_element"
  | "type_text"
  | "scroll_window"
  | "screenshot"
  | "evaluate_js"
  | "new_tab"
  | "close_tab"
  | "switch_tab"
  | "get_dom_snapshot"
  | "get_accessibility_tree"
  | "find_element"
  | "read_page"
  | "wait_for_selector"
  | "execute_script"
  | "get_console_logs"
  | "clear_console_logs"
  | "get_network_logs"
  | "clear_network_logs"
  | "start_network_capture"
  | "stop_network_capture"
  | "hover_element"
  | "script_inject"
  | "cookie_manager"
  | "fill_form"
  | "get_storage"
  | "set_storage"
  | "error_reporter"
  | "get_performance_metrics"
  | "full_page_capture"
  | "pdf_export"
  | "device_emulate";

export type CommandMessage = {
  type: "command";
  requestId: string;
  command: ExtensionCommand;
  payload?: unknown;
};

export type ScreenshotResultPayload = {
  type: "screenshot_result";
  data: string;
  mimeType: string;
};

export function readPort(): number {
  const raw = process.env.POKE_BROWSER_WS_PORT ?? process.env.WS_PORT;
  if (raw === undefined || raw === "") return DEFAULT_PORT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 65535) {
    console.error(`Invalid POKE_BROWSER_WS_PORT="${raw}", falling back to ${DEFAULT_PORT}`);
    return DEFAULT_PORT;
  }
  return Math.trunc(n);
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function isScreenshotResultPayload(v: unknown): v is ScreenshotResultPayload {
  if (!isRecord(v)) return false;
  return (
    v.type === "screenshot_result" &&
    typeof v.data === "string" &&
    typeof v.mimeType === "string"
  );
}

export function jsonText(data: unknown): string {
  try {
    return JSON.stringify(data, null, 2);
  } catch (e) {
    return JSON.stringify({ error: "Failed to serialize result", detail: String(e) });
  }
}

export class ExtensionBridge {
  private socket: WebSocket | null = null;
  private readonly pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();

  attachSocket(ws: WebSocket): void {
    this.socket = ws;
  }

  clearSocket(ws: WebSocket): void {
    if (this.socket === ws) this.socket = null;
  }

  isReady(): boolean {
    return this.socket !== null && this.socket.readyState === 1;
  }

  rejectAllPending(reason: string): void {
    for (const [requestId, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
      this.pending.delete(requestId);
    }
  }

  handleMessage(raw: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(raw) as unknown;
    } catch {
      return;
    }
    if (!isRecord(msg)) return;

    if (msg.type === "hello") {
      console.error("[poke-browser-mcp] Extension connected:", jsonText(msg));
      return;
    }

    if (msg.type === "response" && typeof msg.requestId === "string") {
      const entry = this.pending.get(msg.requestId);
      if (!entry) return;
      this.pending.delete(msg.requestId);
      clearTimeout(entry.timer);
      if (msg.ok === true) {
        entry.resolve(msg.result);
      } else {
        entry.reject(new Error(typeof msg.error === "string" ? msg.error : "Extension reported failure"));
      }
    }
  }

  request(command: ExtensionCommand, payload: unknown, timeoutMs: number): Promise<unknown> {
    const sock = this.socket;
    if (!sock || sock.readyState !== 1) {
      return Promise.reject(new Error("Chrome extension is not connected to the MCP WebSocket server"));
    }

    const requestId = randomUUID();
    const body: CommandMessage = { type: "command", requestId, command, payload };

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
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }
}

export const bridge = new ExtensionBridge();

function waitForWebSocketListening(wss: WebSocketServer): Promise<void> {
  return new Promise((resolve, reject) => {
    const onListen = (): void => {
      wss.off("error", onErr);
      resolve();
    };
    const onErr = (err: Error): void => {
      wss.off("listening", onListen);
      reject(err);
    };
    wss.once("listening", onListen);
    wss.once("error", onErr);
  });
}

/**
 * Binds the extension WebSocket server and resolves only after the port is listening
 * (avoids ERR_CONNECTION_REFUSED races with early client connects).
 */
export async function startExtensionWebSocketServer(
  port: number,
  b: ExtensionBridge,
): Promise<WebSocketServer> {
  const wss = new WebSocketServer({ port, host: "127.0.0.1" });
  const trackedClients = new Set<WebSocket>();

  wss.on("error", (err: Error) => {
    console.error("[poke-browser-mcp] WebSocket server error:", err);
  });

  wss.on("connection", (ws: WebSocket) => {
    for (const client of wss.clients) {
      if (client !== ws && client.readyState === WebSocket.OPEN) {
        try {
          client.close(4000, "replaced by new poke-browser connection");
        } catch {
          /* ignore */
        }
      }
    }

    trackedClients.add(ws);
    b.attachSocket(ws);
    console.error("[poke-browser-mcp] Extension WebSocket client connected");

    let pongDeadline: NodeJS.Timeout | null = null;
    const clearPongDeadline = (): void => {
      if (pongDeadline) {
        clearTimeout(pongDeadline);
        pongDeadline = null;
      }
    };

    const pingInterval = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      clearPongDeadline();
      pongDeadline = setTimeout(() => {
        console.error("[poke-browser-mcp] WebSocket client missed pong deadline; terminating client");
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
      }, WS_PONG_DEADLINE_MS);
      try {
        ws.ping();
      } catch {
        /* ignore */
      }
    }, WS_PING_INTERVAL_MS);

    ws.on("pong", () => {
      clearPongDeadline();
    });

    ws.on("message", (data) => {
      const raw =
        typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
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

  await waitForWebSocketListening(wss);
  extensionWebSocketServer = wss;
  console.error(`[poke-browser-mcp] WebSocket listening on ws://127.0.0.1:${port}`);
  console.error("[poke-browser-mcp] Load the poke-browser extension and keep this process running.");

  return wss;
}
