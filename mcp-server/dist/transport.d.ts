import { WebSocketServer, WebSocket } from "ws";
/** Strong ref so the server is never GC'd; also useful for tests. */
export declare let extensionWebSocketServer: WebSocketServer | null;
export declare const DEFAULT_PORT = 9009;
export declare const PENDING_REQUEST_TIMEOUT_MS = 10000;
export declare const EVALUATE_JS_TIMEOUT_MS = 60000;
export type ExtensionCommand = "list_tabs" | "get_active_tab" | "navigate_to" | "click_element" | "type_text" | "scroll_window" | "screenshot" | "evaluate_js" | "new_tab" | "close_tab" | "switch_tab" | "get_dom_snapshot" | "get_accessibility_tree" | "find_element" | "read_page" | "wait_for_selector" | "execute_script" | "get_console_logs" | "clear_console_logs" | "get_network_logs" | "clear_network_logs" | "start_network_capture" | "stop_network_capture" | "hover_element" | "script_inject" | "cookie_manager" | "fill_form" | "get_storage" | "set_storage" | "error_reporter" | "get_performance_metrics" | "full_page_capture" | "pdf_export" | "device_emulate";
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
/**
 * When `POKE_BROWSER_TOKEN` is set to a non-empty value (after trim), the extension `hello` must
 * include the same token. When unset/empty, WebSocket auth is disabled (zero-config / dev mode).
 */
export declare function readOptionalWebSocketAuthToken(): string | undefined;
export declare class RateLimitError extends Error {
    readonly retryAfter = 10;
    constructor();
}
/**
 * WebSocket listen port for the Chrome extension (default 9009).
 * Uses `POKE_BROWSER_WS_PORT` or `WS_PORT`. Note: `POKE_BROWSER_PORT` in `run.ts` is the MCP HTTP
 * port, not this value; the extension stores its target port in chrome.storage (`wsPort`).
 */
export declare function readPort(): number;
/** Shown when tools run but no extension has completed the WebSocket `hello` handshake yet. */
export declare function extensionBridgeDisconnectedMessage(): string;
export declare function isRecord(v: unknown): v is Record<string, unknown>;
export declare function isScreenshotResultPayload(v: unknown): v is ScreenshotResultPayload;
export declare function jsonText(data: unknown): string;
export declare class ExtensionBridge {
    private socket;
    private rateTimestamps;
    private readonly pending;
    attachSocket(ws: WebSocket): void;
    clearSocket(ws: WebSocket): void;
    isReady(): boolean;
    rejectAllPending(reason: string): void;
    handleMessage(raw: string): void;
    request(command: ExtensionCommand, payload: unknown, timeoutMs: number): Promise<unknown>;
}
export declare const bridge: ExtensionBridge;
export type ExtensionWsServerOptions = {
    /** Required match for `hello.token` when set. Omitted or empty → auth disabled. */
    authToken?: string;
};
/**
 * Binds the extension WebSocket server and resolves only after the port is listening
 * (avoids ERR_CONNECTION_REFUSED races with early client connects).
 */
export declare function startExtensionWebSocketServer(port: number, b: ExtensionBridge, options?: ExtensionWsServerOptions): Promise<WebSocketServer>;
//# sourceMappingURL=transport.d.ts.map