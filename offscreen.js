/**
 * MV3 offscreen document: holds the MCP WebSocket so the connection survives
 * service worker suspension (service workers cannot keep long-lived sockets).
 */

/** Offscreen documents cannot use chrome.storage; port comes from the document URL (set by background). */
const params = new URLSearchParams(location.search);
let mcpPort = Number.parseInt(params.get("port") ?? "9009", 10);
if (!Number.isFinite(mcpPort) || mcpPort <= 0 || mcpPort > 65535) {
  mcpPort = 9009;
}

const WS_INITIAL_RETRY_MS = 1000;
const WS_MAX_RETRY_MS = 30000;
const WS_MAX_RETRIES = 20;

/** @type {WebSocket | null} */
let socket = null;
/** When true, the next socket `close` does not schedule reconnect (internal reconnect path). */
let suppressReconnectOnce = false;
/** @type {ReturnType<typeof setTimeout> | null} */
let reconnectTimer = null;
let wsRetryDelayMs = WS_INITIAL_RETRY_MS;
let wsReconnectCycles = 0;

/** @type {chrome.runtime.Port | null} */
let bgPort = null;

function postToBg(msg) {
  try {
    bgPort?.postMessage(msg);
  } catch {
    /* ignore */
  }
}

function notifyStatus(status) {
  postToBg({ type: "ws_status", status });
}

function notifyLog(direction, summary) {
  postToBg({ type: "ws_log", direction, summary });
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

/**
 * @param {number} [closeCode]
 */
function scheduleReconnectAfterClose(closeCode = 0) {
  clearReconnectTimer();
  if (wsReconnectCycles >= WS_MAX_RETRIES) {
    console.error("[poke-browser offscreen] max WebSocket reconnect attempts reached");
    notifyLog("out", `WebSocket: gave up after ${WS_MAX_RETRIES} failed reconnects`);
    notifyStatus("disconnected");
    return;
  }
  let delay = wsRetryDelayMs;
  if (closeCode === 4000) {
    delay = Math.max(delay, 5000);
  }
  wsRetryDelayMs = Math.min(wsRetryDelayMs * 2, WS_MAX_RETRY_MS);
  wsReconnectCycles += 1;
  console.log("[poke-browser offscreen] Reconnect in", delay, "ms (cycle", wsReconnectCycles, "/", WS_MAX_RETRIES, ")");
  notifyLog("out", `WebSocket: reconnect in ${delay}ms (${wsReconnectCycles}/${WS_MAX_RETRIES})`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectMcpSocket();
  }, delay);
}

function resetWebSocketBackoff() {
  clearReconnectTimer();
  wsRetryDelayMs = WS_INITIAL_RETRY_MS;
  wsReconnectCycles = 0;
}

function connectMcpSocket() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    console.log("[poke-browser offscreen] connect skipped (socket already open/connecting)");
    return;
  }

  notifyStatus("connecting");
  const url = `ws://127.0.0.1:${mcpPort}`;
  console.log("[poke-browser offscreen] Connecting to", url);
  try {
    socket = new WebSocket(url);
  } catch (e) {
    notifyStatus("disconnected");
    notifyLog("out", `WebSocket construct failed: ${String(e)}`);
    scheduleReconnectAfterClose();
    return;
  }

  socket.addEventListener("open", () => {
    resetWebSocketBackoff();
    notifyStatus("connected");
    notifyLog("out", `Connected to MCP WebSocket ${url}`);
    postToBg({ type: "request_hello_credentials" });
  });

  socket.addEventListener("message", (event) => {
    const raw = String(event.data);
    console.log("[poke-browser offscreen] From MCP (first 200 chars):", raw.slice(0, 200));
    postToBg({ type: "ws_frame", raw });
  });

  socket.addEventListener("close", (event) => {
    notifyStatus("disconnected");
    console.error(
      "[poke-browser offscreen] WebSocket CLOSED, code:",
      event.code,
      "reason:",
      event.reason,
      "wasClean:",
      event.wasClean,
    );
    notifyLog("out", "WebSocket closed");
    socket = null;
    if (suppressReconnectOnce) {
      suppressReconnectOnce = false;
      return;
    }
    if (event.code === 1000 || event.code === 1001) {
      console.error("[poke-browser offscreen] Clean close, not reconnecting");
      return;
    }
    scheduleReconnectAfterClose(event.code);
  });

  socket.addEventListener("error", (event) => {
    console.error("[poke-browser offscreen] WebSocket ERROR:", event);
    notifyLog("out", "WebSocket error (see close for reconnect)");
  });
}

/**
 * @param {{ type?: string, payload?: unknown }} msg
 */
function sendHelloFromCredentials(msg) {
  const token = typeof msg.token === "string" ? msg.token : "";
  const version = typeof msg.version === "string" ? msg.version : "0";
  const hello =
    token.length > 0
      ? {
          type: "hello",
          token,
          client: "poke-browser-extension",
          version,
        }
      : {
          type: "hello",
          client: "poke-browser-extension",
          version,
        };
  try {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(hello));
    }
  } catch {
    /* ignore */
  }
}

function handleFromBg(msg) {
  if (msg.type === "hello_credentials") {
    sendHelloFromCredentials(msg);
    return;
  }
  if (msg.type === "ws_send" && msg.payload !== undefined) {
    try {
      if (socket?.readyState === WebSocket.OPEN) {
        const line = typeof msg.payload === "string" ? msg.payload : JSON.stringify(msg.payload);
        socket.send(line);
      }
    } catch {
      /* ignore */
    }
    return;
  }
  if (msg.type === "reconnect") {
    if (typeof msg.port === "number" && Number.isFinite(msg.port) && msg.port > 0 && msg.port < 65536) {
      mcpPort = Math.trunc(msg.port);
    }
    clearReconnectTimer();
    resetWebSocketBackoff();
    if (socket) {
      suppressReconnectOnce = true;
      try {
        socket.close();
      } catch {
        /* ignore */
      }
      socket = null;
      suppressReconnectOnce = false;
    }
    connectMcpSocket();
    return;
  }
  if (msg.type === "sw_wake") {
    if (socket?.readyState === WebSocket.OPEN) {
      try {
        socket.send(JSON.stringify({ type: "ping" }));
      } catch {
        /* ignore */
      }
    } else {
      connectMcpSocket();
    }
  }
}

function attachBridgePort() {
  if (bgPort) return;
  bgPort = chrome.runtime.connect({ name: "POKE_WS_BRIDGE" });
  bgPort.onMessage.addListener(handleFromBg);
  bgPort.onDisconnect.addListener(() => {
    bgPort = null;
    setTimeout(attachBridgePort, 500);
  });
}

attachBridgePort();
connectMcpSocket();
