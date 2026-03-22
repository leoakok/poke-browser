/** @typedef {{ type: string, requestId?: string, command?: string, payload?: unknown }} WsInbound */

const DEFAULT_WS_PORT = 9009;
const LOG_MAX = 50;
const WS_INITIAL_RETRY_MS = 1000;
const WS_MAX_RETRY_MS = 30000;
const WS_MAX_RETRIES = 20;
const NAVIGATE_WAIT_MS = 30_000;
const MAX_NET_PER_TAB = 200;

/** @type {Set<number>} */
const networkCaptureTabs = new Set();

/**
 * Per-tab network log: FIFO order of requestIds and merged entries.
 * @type {Map<number, { order: string[]; byId: Map<string, Record<string, unknown>> }>}
 */
const networkStateByTab = new Map();

/** @type {WebSocket | null} */
let socket = null;
/** When true, the next `close` event does not schedule a reconnect (port change / manual reconnect). */
let suppressReconnectOnce = false;

/** @type {ReturnType<typeof setTimeout> | null} */
let reconnectTimer = null;
/** Next delay (ms) after a connection close (doubles, capped); reset on successful open. */
let wsRetryDelayMs = WS_INITIAL_RETRY_MS;
/** Scheduled reconnects after close without a successful open in between; reset on open. */
let wsReconnectCycles = 0;
/** @type {"disconnected" | "connecting" | "connected"} */
let mcpStatus = "disconnected";

/** @type {Array<{ ts: number, direction: "in" | "out", summary: string }>} */
let commandLog = [];

function logCommand(direction, summary) {
  commandLog.unshift({ ts: Date.now(), direction, summary });
  if (commandLog.length > LOG_MAX) commandLog.length = LOG_MAX;
  chrome.runtime.sendMessage({ type: "POKE_LOG_UPDATE" }).catch(() => {});
}

async function getWsPort() {
  const { wsPort } = await chrome.storage.local.get("wsPort");
  if (typeof wsPort === "number" && Number.isFinite(wsPort) && wsPort > 0 && wsPort < 65536) {
    return wsPort;
  }
  return DEFAULT_WS_PORT;
}

async function getWsAuthToken() {
  const { wsAuthToken } = await chrome.storage.local.get("wsAuthToken");
  return typeof wsAuthToken === "string" ? wsAuthToken : "";
}

function setStatus(next) {
  mcpStatus = next;
  chrome.runtime.sendMessage({ type: "POKE_STATUS", status: next }).catch(() => {});
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

/**
 * @param {number} [closeCode] WebSocket close code from the `close` event (0 if unknown).
 */
function scheduleReconnectAfterClose(closeCode = 0) {
  clearReconnectTimer();
  if (wsReconnectCycles >= WS_MAX_RETRIES) {
    console.error("poke-browser: max WebSocket reconnect attempts reached; not retrying further");
    logCommand("out", `WebSocket: gave up after ${WS_MAX_RETRIES} failed reconnects`);
    setStatus("disconnected");
    return;
  }
  let delay = wsRetryDelayMs;
  /** Code 4000 was historically used for "replaced" closes; wait ≥5s before retry to avoid tight reconnect loops. */
  if (closeCode === 4000) {
    delay = Math.max(delay, 5000);
  }
  wsRetryDelayMs = Math.min(wsRetryDelayMs * 2, WS_MAX_RETRY_MS);
  wsReconnectCycles += 1;
  console.log("[poke-browser ext] Retrying WebSocket in", delay, "ms (cycle", wsReconnectCycles, "/", WS_MAX_RETRIES, ")");
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWebSocket();
  }, delay);
  logCommand("out", `WebSocket: reconnect in ${delay}ms (${wsReconnectCycles}/${WS_MAX_RETRIES})`);
}

function resetWebSocketBackoff() {
  clearReconnectTimer();
  wsRetryDelayMs = WS_INITIAL_RETRY_MS;
  wsReconnectCycles = 0;
}

function connectWebSocket() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    console.log("[poke-browser ext] connectWebSocket skipped (socket already open/connecting)");
    return;
  }

  setStatus("connecting");
  getWsPort().then((port) => {
    const url = `ws://127.0.0.1:${port}`;
    console.log(
      "[poke-browser ext] Attempting WebSocket connection to",
      url,
      "| reconnect cycles completed:",
      wsReconnectCycles,
      "| next backoff ms:",
      wsRetryDelayMs,
    );
    try {
      socket = new WebSocket(url);
    } catch (e) {
      setStatus("disconnected");
      logCommand("out", `WebSocket construct failed: ${String(e)}`);
      scheduleReconnectAfterClose();
      return;
    }

    socket.addEventListener("open", () => {
      resetWebSocketBackoff();
      setStatus("connected");
      console.log("[poke-browser ext] WebSocket OPENED", url);
      logCommand("out", `Connected to MCP WebSocket ${url}`);
      void (async () => {
        const token = await getWsAuthToken();
        const hello =
          token.length > 0
            ? {
                type: "hello",
                token,
                client: "poke-browser-extension",
                version: chrome.runtime.getManifest().version,
              }
            : {
                type: "hello",
                client: "poke-browser-extension",
                version: chrome.runtime.getManifest().version,
              };
        try {
          socket?.send(JSON.stringify(hello));
        } catch (_) {
          /* ignore */
        }
      })();
    });

    socket.addEventListener("message", (event) => {
      const raw = String(event.data);
      console.log("[poke-browser ext] Message from MCP (first 200 chars):", raw.slice(0, 200));
      handleSocketMessage(raw).catch((err) => {
        logCommand("in", `Handler error: ${String(err)}`);
      });
    });

    socket.addEventListener("close", (event) => {
      setStatus("disconnected");
      console.error(
        "[poke-browser ext] WebSocket CLOSED, code:",
        event.code,
        "reason:",
        event.reason,
        "wasClean:",
        event.wasClean,
      );
      logCommand("out", "WebSocket closed");
      socket = null;
      if (suppressReconnectOnce) {
        suppressReconnectOnce = false;
        return;
      }
      if (event.code === 1000 || event.code === 1001) {
        console.error("[poke-browser ext] Clean close, not reconnecting");
        return;
      }
      scheduleReconnectAfterClose(event.code);
    });

    socket.addEventListener("error", (event) => {
      console.error("[poke-browser ext] WebSocket ERROR event:", event);
      logCommand("out", "WebSocket error (see close for reconnect)");
    });
  });
}

/**
 * @param {unknown} data
 */
function safeSend(data) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} raw
 */
async function handleSocketMessage(raw) {
  /** @type {WsInbound} */
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    logCommand("in", "Invalid JSON from MCP");
    return;
  }

  if (msg.type === "auth_ok") {
    console.log("[poke-browser ext] Auth OK received, connection fully established");
    logCommand("out", "WebSocket: auth OK from MCP");
    return;
  }

  if (msg.type !== "command" || typeof msg.requestId !== "string" || typeof msg.command !== "string") {
    return;
  }

  logCommand("in", `${msg.command} (${msg.requestId.slice(0, 8)}…)`);
  try {
    const result = await dispatchCommand(msg.command, msg.payload);
    safeSend({ type: "response", requestId: msg.requestId, ok: true, result });
    logCommand("out", `OK ${msg.command}`);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    safeSend({ type: "response", requestId: msg.requestId, ok: false, error });
    logCommand("out", `ERR ${msg.command}: ${error}`);
  }
}

/**
 * @param {unknown} payload
 */
function asPayload(payload) {
  return /** @type {Record<string, unknown>} */ (payload && typeof payload === "object" ? payload : {});
}

/**
 * @param {number | undefined} tabId
 */
async function resolveTabId(tabId) {
  if (typeof tabId === "number" && Number.isFinite(tabId)) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error(`Tab not found: ${tabId}`);
    return tabId;
  }
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!active?.id) throw new Error("No active tab");
  return active.id;
}

/**
 * Merge Chrome tab metadata into tool results (tabId, url, title from tabs.get).
 * @param {number} tabId
 * @param {unknown} value
 */
async function withTabMeta(tabId, value) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const meta = {
    tabId,
    url: tab?.url ?? "",
    title: tab?.title ?? "",
  };
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return { ...(/** @type {Record<string, unknown>} */ (value)), ...meta };
  }
  return { ...meta, value };
}

/**
 * Bring a tab to the foreground so captureVisibleTab targets it.
 * @param {number} tabId
 */
async function ensureTabVisibleForCapture(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab?.id || tab.windowId == null) throw new Error(`Tab not found: ${tabId}`);
  if (!tab.active) {
    await chrome.tabs.update(tabId, { active: true });
  }
  await chrome.windows.update(tab.windowId, { focused: true });
  await new Promise((r) => setTimeout(r, 75));
  return tab;
}

/**
 * @param {number} tabId
 * @param {string} method
 * @param {object} [params]
 */
function debuggerSend(tabId, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, () => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(undefined);
    });
  });
}

/**
 * @param {number} tabId
 * @param {string} method
 * @param {object} [params]
 * @returns {Promise<unknown>}
 */
function debuggerSendWithResult(tabId, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(result);
    });
  });
}

/**
 * @param {number} tabId
 */
async function debuggerAttach(tabId) {
  await new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, "1.3", () => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(undefined);
    });
  });
}

/**
 * @param {number} tabId
 */
async function debuggerDetach(tabId) {
  await new Promise((resolve) => {
    chrome.debugger.detach({ tabId }, () => resolve());
  });
}

/**
 * @param {number} tabId
 */
function isNetworkCapturing(tabId) {
  return networkCaptureTabs.has(tabId);
}

/**
 * @param {number} tabId
 */
async function debuggerAttachForTool(tabId) {
  if (isNetworkCapturing(tabId)) return;
  await debuggerAttach(tabId);
}

/**
 * @param {number} tabId
 */
async function debuggerDetachForTool(tabId) {
  if (isNetworkCapturing(tabId)) return;
  await debuggerDetach(tabId);
}

/**
 * @param {unknown} headers
 * @returns {Record<string, string>}
 */
function normalizeHeaders(headers) {
  if (!headers || typeof headers !== "object") return {};
  if (Array.isArray(headers)) {
    /** @type {Record<string, string>} */
    const o = {};
    for (const row of headers) {
      if (row && typeof row === "object" && "name" in row) {
        const name = String(/** @type {{ name?: string }} */ (row).name ?? "");
        if (name) o[name] = String(/** @type {{ value?: string }} */ (row).value ?? "");
      }
    }
    return o;
  }
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of Object.entries(/** @type {Record<string, unknown>} */ (headers))) {
    out[k] = typeof v === "string" ? v : JSON.stringify(v);
  }
  return out;
}

/**
 * @param {number} tabId
 * @param {string} requestId
 * @param {Record<string, unknown>} patch
 */
function upsertNetworkEntry(tabId, requestId, patch) {
  let state = networkStateByTab.get(tabId);
  if (!state) {
    state = { order: [], byId: new Map() };
    networkStateByTab.set(tabId, state);
  }
  const existing = state.byId.get(requestId);
  if (existing) {
    Object.assign(existing, patch);
  } else {
    state.byId.set(requestId, { requestId, ...patch });
    state.order.push(requestId);
    while (state.order.length > MAX_NET_PER_TAB) {
      const drop = state.order.shift();
      if (drop) state.byId.delete(drop);
    }
  }
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (tabId == null || !networkCaptureTabs.has(tabId)) return;
  const p = params && typeof params === "object" ? /** @type {Record<string, unknown>} */ (params) : {};
  const rid = p.requestId != null ? String(p.requestId) : "";
  if (!rid) return;

  if (method === "Network.requestWillBeSent") {
    const req = /** @type {{ url?: string; method?: string; headers?: unknown }} */ (p.request ?? {});
    upsertNetworkEntry(tabId, rid, {
      url: req.url ?? "",
      method: req.method ?? "GET",
      requestHeaders: normalizeHeaders(req.headers),
    });
  } else if (method === "Network.responseReceived") {
    const res = /** @type {{ status?: number; mimeType?: string; headers?: unknown; timing?: unknown }} */ (p.response ?? {});
    upsertNetworkEntry(tabId, rid, {
      status: res.status,
      mimeType: res.mimeType,
      responseHeaders: normalizeHeaders(res.headers),
      timing: res.timing ?? null,
    });
  } else if (method === "Network.loadingFinished") {
    upsertNetworkEntry(tabId, rid, {
      bodySize: typeof p.encodedDataLength === "number" ? p.encodedDataLength : undefined,
      loaded: true,
    });
  }
});

chrome.debugger.onDetach.addListener((source, _reason) => {
  if (source.tabId != null) networkCaptureTabs.delete(source.tabId);
});

/**
 * @param {number} tabId
 * @param {number} x
 * @param {number} y
 */
async function clickViaDebugger(tabId, x, y) {
  await debuggerAttachForTool(tabId);
  try {
    await debuggerSend(tabId, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    await debuggerSend(tabId, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    return { success: true };
  } finally {
    await debuggerDetachForTool(tabId);
  }
}

/**
 * @param {number} tabId
 * @param {string} text
 */
async function typeTextViaDebugger(tabId, text) {
  await debuggerAttachForTool(tabId);
  try {
    for (const ch of text) {
      if (ch === "\n" || ch === "\r") {
        if (ch === "\r") continue;
        await debuggerSend(tabId, "Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
        });
        await debuggerSend(tabId, "Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
        });
        continue;
      }
      await debuggerSend(tabId, "Input.dispatchKeyEvent", {
        type: "keyDown",
        text: ch,
      });
      await debuggerSend(tabId, "Input.dispatchKeyEvent", {
        type: "keyUp",
        text: ch,
      });
    }
    return { success: true, charsTyped: text.length };
  } finally {
    await debuggerDetachForTool(tabId);
  }
}

/**
 * @param {number} tabId
 * @param {number} timeoutMs
 */
function waitForTabLoadComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error("navigate_to: load timeout"));
    }, timeoutMs);

    /**
     * @param {number} id
     * @param {chrome.tabs.TabChangeInfo} changeInfo
     */
    function onUpdated(id, changeInfo) {
      if (id !== tabId) return;
      if (changeInfo.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

async function handleListTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs
    .filter((t) => t.id != null)
    .map((t) => ({
      tabId: t.id,
      title: t.title ?? "",
      url: t.url ?? "",
      active: Boolean(t.active),
      index: t.index,
    }));
}

async function handleGetActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) throw new Error("No active tab");
  return {
    tabId: tab.id,
    title: tab.title ?? "",
    url: tab.url ?? "",
    active: true,
    index: tab.index,
  };
}

/** @param {unknown} payload */
async function handleNavigateTo(payload) {
  const p = asPayload(payload);
  const url = typeof p.url === "string" ? p.url : "";
  if (!url) throw new Error("navigate_to requires url");
  const tabId = await resolveTabId(typeof p.tabId === "number" ? p.tabId : undefined);
  /** Always wait for chrome.tabs.onUpdated status "complete" so finalUrl/title match the loaded page (not a stale devtools/interstitial URL). */
  const timeoutMs = p.waitForLoad === false ? 10_000 : NAVIGATE_WAIT_MS;
  const done = waitForTabLoadComplete(tabId, timeoutMs);
  await chrome.tabs.update(tabId, { url });
  await done;
  const tab = await chrome.tabs.get(tabId);
  const finalUrl = tab.url ?? "";
  const title = tab.title ?? "";
  return {
    success: true,
    tabId,
    url: finalUrl,
    finalUrl,
    title,
  };
}

/** @param {unknown} payload */
async function handleClickElement(payload) {
  const p = asPayload(payload);
  const tabId = await resolveTabId(typeof p.tabId === "number" ? p.tabId : undefined);
  const selector = typeof p.selector === "string" ? p.selector.trim() : "";
  const x = typeof p.x === "number" ? p.x : Number(p.x);
  const y = typeof p.y === "number" ? p.y : Number(p.y);
  const hasXY = Number.isFinite(x) && Number.isFinite(y);

  if (selector) {
    const res = await chrome.tabs.sendMessage(tabId, { type: "POKE_CLICK_ELEMENT", selector }).catch((e) => {
      throw new Error(`click_element relay failed: ${String(e)}`);
    });
    return withTabMeta(tabId, res);
  }
  if (hasXY) {
    const r = await clickViaDebugger(tabId, x, y);
    return withTabMeta(tabId, r);
  }
  throw new Error("click_element requires selector or numeric x and y");
}

/** @param {unknown} payload */
async function handleTypeText(payload) {
  const p = asPayload(payload);
  const text = typeof p.text === "string" ? p.text : "";
  const tabId = await resolveTabId(typeof p.tabId === "number" ? p.tabId : undefined);
  const selector = typeof p.selector === "string" ? p.selector : undefined;
  const clearFirst = p.clearFirst === true;

  const res = await chrome.tabs
    .sendMessage(tabId, {
      type: "POKE_TYPE_TEXT",
      text,
      selector,
      clearFirst,
    })
    .catch(() => null);

  if (res && res.success === true) {
    return withTabMeta(tabId, {
      success: true,
      charsTyped: typeof res.charsTyped === "number" ? res.charsTyped : text.length,
    });
  }
  const dbg = await typeTextViaDebugger(tabId, text);
  return withTabMeta(tabId, dbg);
}

/** @param {unknown} payload */
async function handleScrollWindow(payload) {
  const p = asPayload(payload);
  const tabId = await resolveTabId(typeof p.tabId === "number" ? p.tabId : undefined);
  const res = await chrome.tabs.sendMessage(tabId, { type: "POKE_SCROLL_WINDOW", payload: p }).catch((e) => {
    throw new Error(`scroll_window relay failed: ${String(e)}`);
  });
  return withTabMeta(tabId, res);
}

/** @param {unknown} payload */
async function handleScreenshot(payload) {
  const p = asPayload(payload);
  const tabId = await resolveTabId(typeof p.tabId === "number" ? p.tabId : undefined);
  const tab = await ensureTabVisibleForCapture(tabId);
  const fmt = p.format === "jpeg" ? "jpeg" : "png";
  const rawQ = typeof p.quality === "number" ? p.quality : 85;
  /** @type {{ format: 'png' | 'jpeg', quality?: number }} */
  const opts =
    fmt === "jpeg"
      ? { format: "jpeg", quality: Math.min(100, Math.max(0, rawQ)) }
      : { format: "png" };
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, opts);
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!m) throw new Error("Invalid screenshot data from browser");
  return withTabMeta(tabId, {
    type: "screenshot_result",
    data: m[2],
    mimeType: m[1],
  });
}

/** @param {unknown} payload */
async function handleErrorReporter(payload) {
  const p = asPayload(payload);
  const tabId = await resolveTabId(typeof p.tabId === "number" ? p.tabId : undefined);
  const limit = typeof p.limit === "number" ? p.limit : 50;
  return chrome.tabs
    .sendMessage(tabId, { type: "POKE_GET_PAGE_ERRORS", limit })
    .catch((e) => {
      throw new Error(`error_reporter relay failed: ${String(e)}`);
    });
}

/** @param {unknown} payload */
async function handleGetPerformanceMetrics(payload) {
  const p = asPayload(payload);
  const tabId = await resolveTabId(typeof p.tabId === "number" ? p.tabId : undefined);
  await debuggerAttachForTool(tabId);
  try {
    const rawMetrics = await debuggerSendWithResult(tabId, "Performance.getMetrics", {});
    const metricsArr = Array.isArray(rawMetrics)
      ? rawMetrics
      : rawMetrics && typeof rawMetrics === "object" && "metrics" in rawMetrics
        ? /** @type {{ metrics?: unknown }} */ (rawMetrics).metrics
        : null;
    /**
     * @param {string} name
     */
    const by = (name) => {
      if (!Array.isArray(metricsArr)) return undefined;
      const row = metricsArr.find(
        (x) => x && typeof x === "object" && /** @type {{ name?: string }} */ (x).name === name,
      );
      return row && typeof /** @type {{ value?: number }} */ (row).value === "number"
        ? /** @type {{ value: number }} */ (row).value
        : undefined;
    };

    const navExpr = `(() => {
      const t = performance.timing;
      const ns = t.navigationStart || 0;
      if (!ns) return { domContentLoaded: null, loadEventEnd: null };
      return {
        domContentLoaded: t.domContentLoadedEventEnd > 0 ? t.domContentLoadedEventEnd - ns : null,
        loadEventEnd: t.loadEventEnd > 0 ? t.loadEventEnd - ns : null,
      };
    })()`;
    const navRes = await debuggerSendWithResult(tabId, "Runtime.evaluate", {
      expression: navExpr,
      returnByValue: true,
    });
    const navVal =
      navRes && typeof navRes === "object" && "result" in navRes
        ? /** @type {{ result?: { value?: unknown } }} */ (navRes).result?.value
        : undefined;

    const paintExpr = `(() => {
      const entries = performance.getEntriesByType("paint");
      let firstPaint = null;
      let firstContentfulPaint = null;
      for (const e of entries) {
        if (e.name === "first-paint") firstPaint = e.startTime;
        if (e.name === "first-contentful-paint") firstContentfulPaint = e.startTime;
      }
      return { firstPaint, firstContentfulPaint };
    })()`;
    const paintRes = await debuggerSendWithResult(tabId, "Runtime.evaluate", {
      expression: paintExpr,
      returnByValue: true,
    });
    const paintVal =
      paintRes && typeof paintRes === "object" && "result" in paintRes
        ? /** @type {{ result?: { value?: unknown } }} */ (paintRes).result?.value
        : undefined;

    const nv = navVal && typeof navVal === "object" ? /** @type {Record<string, unknown>} */ (navVal) : {};
    const pv = paintVal && typeof paintVal === "object" ? /** @type {Record<string, unknown>} */ (paintVal) : {};

    return {
      domContentLoaded: nv.domContentLoaded ?? null,
      loadEventEnd: nv.loadEventEnd ?? null,
      firstPaint: pv.firstPaint ?? null,
      firstContentfulPaint: pv.firstContentfulPaint ?? null,
      jsHeapUsed: by("JSHeapUsedSize") ?? null,
      jsHeapTotal: by("JSHeapTotalSize") ?? null,
    };
  } finally {
    await debuggerDetachForTool(tabId);
  }
}

/**
 * @param {ArrayBuffer} buffer
 */
function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.byteLength; i += chunk) {
    binary += String.fromCharCode.apply(null, /** @type {number[]} */ (Array.from(bytes.subarray(i, i + chunk))));
  }
  return btoa(binary);
}

/**
 * @param {string[]} dataUrls
 */
async function stitchFullPageScreenshots(dataUrls) {
  if (dataUrls.length === 0) throw new Error("full_page_capture: no strips");
  /** @type {ImageBitmap[]} */
  const bitmaps = [];
  try {
    for (const u of dataUrls) {
      const res = await fetch(u);
      const blob = await res.blob();
      const bm = await createImageBitmap(blob);
      bitmaps.push(bm);
    }
    let width = 0;
    let height = 0;
    for (const bm of bitmaps) {
      width = Math.max(width, bm.width);
      height += bm.height;
    }
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("full_page_capture: no 2d context");
    let y = 0;
    for (const bm of bitmaps) {
      ctx.drawImage(bm, 0, y);
      y += bm.height;
    }
    const mimeType = String(dataUrls[0]).startsWith("data:image/jpeg") ? "image/jpeg" : "image/png";
    const blob = await canvas.convertToBlob({ type: mimeType });
    const buf = await blob.arrayBuffer();
    const b64 = arrayBufferToBase64(buf);
    return `data:${mimeType};base64,${b64}`;
  } finally {
    for (const bm of bitmaps) {
      try {
        bm.close();
      } catch {
        /* ignore */
      }
    }
  }
}

/** @param {unknown} payload */
async function handleFullPageCapture(payload) {
  const p = asPayload(payload);
  const tabId = await resolveTabId(typeof p.tabId === "number" ? p.tabId : undefined);
  const tab = await ensureTabVisibleForCapture(tabId);
  const fmt = p.format === "jpeg" ? "jpeg" : "png";
  const rawQ = typeof p.quality === "number" ? p.quality : 85;
  /** @type {{ format: 'png' | 'jpeg', quality?: number }} */
  const opts =
    fmt === "jpeg"
      ? { format: "jpeg", quality: Math.min(100, Math.max(0, rawQ)) }
      : { format: "png" };

  const info = await chrome.tabs.sendMessage(tabId, { type: "POKE_GET_SCROLL_INFO" }).catch(() => null);
  if (!info || typeof info !== "object" || typeof /** @type {{ scrollHeight?: unknown }} */ (info).scrollHeight !== "number") {
    throw new Error("full_page_capture: content script unavailable or invalid scroll info");
  }
  const scrollHeight = /** @type {{ scrollHeight: number; innerHeight?: number }} */ (info).scrollHeight;
  const vh = Math.max(1, Math.floor(/** @type {{ innerHeight?: number }} */ (info).innerHeight || 600));

  /** @type {string[]} */
  const dataUrls = [];
  await chrome.tabs.sendMessage(tabId, { type: "POKE_SCROLL_TO", y: 0 });
  await new Promise((r) => setTimeout(r, 100));

  let y = 0;
  for (;;) {
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, opts);
    dataUrls.push(dataUrl);
    if (y + vh >= scrollHeight - 2) break;
    y = Math.min(y + vh, Math.max(0, scrollHeight - vh));
    await chrome.tabs.sendMessage(tabId, { type: "POKE_SCROLL_TO", y });
    await new Promise((r) => setTimeout(r, 120));
  }

  await chrome.tabs.sendMessage(tabId, { type: "POKE_SCROLL_TO", y: 0 });

  const stitched = await stitchFullPageScreenshots(dataUrls);
  const m = /^data:([^;]+);base64,(.+)$/.exec(stitched);
  if (!m) throw new Error("full_page_capture: invalid stitched data URL");
  return withTabMeta(tabId, {
    type: "screenshot_result",
    data: m[2],
    mimeType: m[1],
  });
}

/** @param {unknown} payload */
async function handlePdfExport(payload) {
  const p = asPayload(payload);
  const tabId = await resolveTabId(typeof p.tabId === "number" ? p.tabId : undefined);
  await ensureTabVisibleForCapture(tabId);
  await debuggerAttachForTool(tabId);
  try {
    const scale = typeof p.scale === "number" && p.scale > 0 ? p.scale : 1;
    const res = await debuggerSendWithResult(tabId, "Page.printToPDF", {
      printBackground: true,
      landscape: p.landscape === true,
      scale,
    });
    const data =
      res && typeof res === "object" && res !== null && "data" in res
        ? String(/** @type {{ data?: string }} */ (res).data ?? "")
        : "";
    if (!data) throw new Error("pdf_export: printToPDF returned no data");
    return { success: true, data, mimeType: "application/pdf" };
  } finally {
    await debuggerDetachForTool(tabId);
  }
}

const DEVICE_PRESETS = {
  mobile: { width: 390, height: 844, deviceScaleFactor: 3, mobile: true },
  tablet: { width: 834, height: 1112, deviceScaleFactor: 2, mobile: true },
  desktop: { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false },
};

/** @param {unknown} payload */
async function handleDeviceEmulate(payload) {
  const p = asPayload(payload);
  const tabId = await resolveTabId(typeof p.tabId === "number" ? p.tabId : undefined);
  const d = p.device === "mobile" || p.device === "tablet" || p.device === "desktop" ? p.device : "desktop";
  const preset = DEVICE_PRESETS[d];
  const width = typeof p.width === "number" ? p.width : preset.width;
  const height = typeof p.height === "number" ? p.height : preset.height;
  const deviceScaleFactor =
    typeof p.deviceScaleFactor === "number" ? p.deviceScaleFactor : preset.deviceScaleFactor;

  await debuggerAttachForTool(tabId);
  try {
    await debuggerSend(tabId, "Emulation.setDeviceMetricsOverride", {
      width: Math.round(width),
      height: Math.round(height),
      deviceScaleFactor,
      mobile: preset.mobile,
      fitWindow: false,
      scale: 1,
    });
    const ua = typeof p.userAgent === "string" && p.userAgent.trim() ? p.userAgent.trim() : undefined;
    if (ua) {
      await debuggerSend(tabId, "Network.setUserAgentOverride", { userAgent: ua });
    }
    return { success: true };
  } finally {
    await debuggerDetachForTool(tabId);
  }
}

/** @param {unknown} payload */
async function handleEvaluateJs(payload) {
  const p = asPayload(payload);
  const code = typeof p.code === "string" ? p.code : "";
  if (!code) throw new Error("evaluate_js requires code");
  const tabId = await resolveTabId(typeof p.tabId === "number" ? p.tabId : undefined);
  const requestId =
    typeof p.requestId === "string" ? p.requestId : `bg-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const timeoutMs = typeof p.timeoutMs === "number" ? p.timeoutMs : 30000;
  const res = await chrome.tabs.sendMessage(tabId, {
    type: "POKE_EVAL",
    code,
    requestId,
    timeoutMs,
  }).catch((e) => {
    throw new Error(`evaluate_js relay failed: ${String(e)}`);
  });
  return res;
}

/**
 * @param {number} tabId
 * @param {string} pokeType
 * @param {Record<string, unknown>} data
 */
async function sendPerceptionToTab(tabId, pokeType, data) {
  const res = await chrome.tabs.sendMessage(tabId, { ...data, type: pokeType }).catch((e) => {
    throw new Error(`Perception relay failed (${pokeType}): ${String(e)}`);
  });
  if (res && typeof res === "object" && "error" in res && typeof res.error === "string") {
    throw new Error(res.error);
  }
  return res;
}

/** @param {unknown} payload */
async function handleGetDomSnapshot(payload) {
  const p = asPayload(payload);
  const tabId = await resolveTabId(typeof p.tabId === "number" ? p.tabId : undefined);
  const res = await sendPerceptionToTab(tabId, "POKE_GET_DOM_SNAPSHOT", {
    includeHidden: p.includeHidden === true,
    maxDepth: typeof p.maxDepth === "number" ? p.maxDepth : undefined,
  });
  return withTabMeta(tabId, res);
}

/** @param {unknown} payload */
async function handleGetAccessibilityTree(payload) {
  const p = asPayload(payload);
  const tabId = await resolveTabId(typeof p.tabId === "number" ? p.tabId : undefined);
  const res = await sendPerceptionToTab(tabId, "POKE_GET_A11Y_TREE", {
    interactiveOnly: p.interactiveOnly === true,
  });
  return withTabMeta(tabId, res);
}

/** @param {unknown} payload */
async function handleFindElement(payload) {
  const p = asPayload(payload);
  const tabId = await resolveTabId(typeof p.tabId === "number" ? p.tabId : undefined);
  const query = typeof p.query === "string" ? p.query : "";
  const strategy =
    p.strategy === "css" || p.strategy === "text" || p.strategy === "aria" || p.strategy === "xpath"
      ? p.strategy
      : "auto";
  const res = await sendPerceptionToTab(tabId, "POKE_FIND_ELEMENT", { query, strategy });
  return withTabMeta(tabId, res);
}

/** @param {unknown} payload */
async function handleReadPage(payload) {
  const p = asPayload(payload);
  const tabId = await resolveTabId(typeof p.tabId === "number" ? p.tabId : undefined);
  const format =
    p.format === "markdown" || p.format === "text" || p.format === "structured" ? p.format : "structured";
  const res = await sendPerceptionToTab(tabId, "POKE_READ_PAGE", { format });
  return withTabMeta(tabId, res);
}

/** @param {unknown} payload */
async function handleWaitForSelector(payload) {
  const p = asPayload(payload);
  const selector = typeof p.selector === "string" ? p.selector : "";
  if (!selector.trim()) throw new Error("wait_for_selector requires selector");
  const tabId = await resolveTabId(typeof p.tabId === "number" ? p.tabId : undefined);
  const timeout = typeof p.timeout === "number" && p.timeout > 0 ? p.timeout : 10000;
  const visible = p.visible === true;
  const res = await chrome.tabs
    .sendMessage(tabId, { type: "POKE_WAIT_FOR_SELECTOR", selector, timeout, visible })
    .catch((e) => {
      throw new Error(`wait_for_selector relay failed: ${String(e)}`);
    });
  return withTabMeta(tabId, res);
}

/** @param {unknown} payload */
async function handleExecuteScript(payload) {
  const p = asPayload(payload);
  const script = typeof p.script === "string" ? p.script : "";
  if (!script.trim()) throw new Error("execute_script requires script");
  const tabId = await resolveTabId(typeof p.tabId === "number" ? p.tabId : undefined);
  const args = Array.isArray(p.args) ? p.args : [];

  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: false },
    world: "MAIN",
    injectImmediately: true,
    func: async (scriptSource, callArgs) => {
      const seen = new WeakSet();
      /**
       * @param {string} _k
       * @param {unknown} val
       */
      function replacer(_k, val) {
        if (typeof val === "bigint") return val.toString();
        if (typeof val === "object" && val !== null) {
          if (seen.has(/** @type {object} */ (val))) return "[Circular]";
          seen.add(/** @type {object} */ (val));
        }
        return val;
      }
      try {
        const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
        const fn = new AsyncFunction("args", `return (async () => {\n${scriptSource}\n})();`);
        const raw = await fn(callArgs ?? []);
        try {
          return { result: JSON.parse(JSON.stringify(raw, replacer)) };
        } catch (serErr) {
          return {
            result: String(raw),
            error: `serialization: ${serErr instanceof Error ? serErr.message : String(serErr)}`,
          };
        }
      } catch (e) {
        return { error: String(e) };
      }
    },
    args: [script, args],
  });

  const fr = /** @type {{ result?: unknown; error?: string } | undefined} */ (results[0]?.result);
  if (!fr) return withTabMeta(tabId, { result: null, error: "No frame result" });
  if (typeof fr.error === "string" && fr.error && fr.result === undefined) {
    return withTabMeta(tabId, { result: undefined, error: fr.error });
  }
  return withTabMeta(tabId, {
    result: fr.result,
    error: typeof fr.error === "string" ? fr.error : undefined,
  });
}

/** @param {unknown} payload */
async function handleGetConsoleLogs(payload) {
  const p = asPayload(payload);
  const tabId = await resolveTabId(typeof p.tabId === "number" ? p.tabId : undefined);
  const level =
    p.level === "error" || p.level === "warn" || p.level === "info" || p.level === "log" || p.level === "all"
      ? p.level
      : "all";
  const limit = typeof p.limit === "number" ? Math.min(500, Math.max(1, p.limit)) : 100;
  const res = await chrome.tabs
    .sendMessage(tabId, { type: "POKE_GET_CONSOLE_LOGS", level, limit })
    .catch((e) => {
      throw new Error(`get_console_logs relay failed: ${String(e)}`);
    });
  const logs = res && typeof res === "object" && "logs" in res ? /** @type {{ logs: unknown }} */ (res).logs : [];
  const count = res && typeof res === "object" && "count" in res ? Number(/** @type {{ count?: number }} */ (res).count) : 0;
  return { logs, count, tabId };
}

/** @param {unknown} payload */
async function handleClearConsoleLogs(payload) {
  const p = asPayload(payload);
  const tabId = await resolveTabId(typeof p.tabId === "number" ? p.tabId : undefined);
  await chrome.tabs.sendMessage(tabId, { type: "POKE_CLEAR_CONSOLE_LOGS" }).catch((e) => {
    throw new Error(`clear_console_logs relay failed: ${String(e)}`);
  });
  return { cleared: true, tabId };
}

/** @param {unknown} payload */
async function handleStartNetworkCapture(payload) {
  const p = asPayload(payload);
  const tabId = await resolveTabId(typeof p.tabId === "number" ? p.tabId : undefined);
  networkStateByTab.delete(tabId);
  if (!networkCaptureTabs.has(tabId)) {
    await debuggerAttach(tabId);
    networkCaptureTabs.add(tabId);
  }
  await debuggerSend(tabId, "Network.enable", {});
  return { success: true, tabId, capturing: true };
}

/** @param {unknown} payload */
async function handleStopNetworkCapture(payload) {
  const p = asPayload(payload);
  const tabId = await resolveTabId(typeof p.tabId === "number" ? p.tabId : undefined);
  if (!networkCaptureTabs.has(tabId)) {
    return { success: true, tabId, capturing: false };
  }
  try {
    await debuggerSend(tabId, "Network.disable", {});
  } catch {
    /* ignore */
  }
  networkCaptureTabs.delete(tabId);
  await debuggerDetach(tabId);
  return { success: true, tabId, capturing: false };
}

/** @param {unknown} payload */
async function handleGetNetworkLogs(payload) {
  const p = asPayload(payload);
  const tabId = await resolveTabId(typeof p.tabId === "number" ? p.tabId : undefined);
  const filter = typeof p.filter === "string" ? p.filter : "";
  const limit = typeof p.limit === "number" ? Math.min(200, Math.max(1, p.limit)) : 50;
  const includeBody = p.includeBody === true;

  const state = networkStateByTab.get(tabId);
  if (!state) {
    return { requests: [], count: 0 };
  }

  /** @type {Record<string, unknown>[]} */
  const rows = [];
  for (const rid of state.order) {
    const row = state.byId.get(rid);
    if (row) rows.push(row);
  }
  let filtered = filter ? rows.filter((r) => String(r.url ?? "").includes(filter)) : [...rows];
  filtered = filtered.slice(-limit);

  const needTempAttach = includeBody && !networkCaptureTabs.has(tabId);
  if (needTempAttach) {
    await debuggerAttach(tabId);
  }
  try {
    /** @type {Record<string, unknown>[]} */
    const out = [];
    for (const e of filtered) {
      const copy = { ...e };
      if (includeBody && e.loaded === true && typeof e.requestId === "string") {
        try {
          const bodyRes = /** @type {{ body?: string; base64Encoded?: boolean }} */ (
            await debuggerSendWithResult(tabId, "Network.getResponseBody", { requestId: e.requestId })
          );
          copy.body = bodyRes.body;
          copy.bodyBase64Encoded = bodyRes.base64Encoded === true;
        } catch {
          copy.bodyFetchError = "Network.getResponseBody failed";
        }
      }
      out.push(copy);
    }
    return { requests: out, count: out.length };
  } finally {
    if (needTempAttach) {
      await debuggerDetach(tabId);
    }
  }
}

/** @param {unknown} payload */
async function handleClearNetworkLogs(payload) {
  const p = asPayload(payload);
  const tabId = await resolveTabId(typeof p.tabId === "number" ? p.tabId : undefined);
  networkStateByTab.delete(tabId);
  return { cleared: true, tabId };
}

const PERSISTENT_LOADER_ID = "poke-browser-persistent-loader";

/**
 * @param {chrome.cookies.Cookie} c
 */
function cookieRemoveUrl(c) {
  const dom = c.domain.startsWith(".") ? c.domain.slice(1) : c.domain;
  const scheme = c.secure ? "https" : "http";
  const path = c.path && c.path.length ? c.path : "/";
  return `${scheme}://${dom}${path}`;
}

/**
 * @param {chrome.cookies.Cookie} c
 */
function serializeCookie(c) {
  return {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    sameSite: c.sameSite,
    expirationDate: c.expirationDate,
    session: c.session,
  };
}

async function ensurePersistentLoaderRegistered() {
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [PERSISTENT_LOADER_ID] });
  if (Array.isArray(existing) && existing.length > 0) return;
  await chrome.scripting.registerContentScripts([
    {
      id: PERSISTENT_LOADER_ID,
      matches: ["<all_urls>"],
      js: ["persistent-loader.js"],
      runAt: "document_start",
    },
  ]);
}

/**
 * @param {number} tabId
 */
async function tabHttpUrl(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const u = tab.url ?? "";
  if (!u.startsWith("http://") && !u.startsWith("https://")) {
    throw new Error("Tab must have an http(s) URL for this operation");
  }
  return u;
}

/** @param {unknown} payload */
async function handleScriptInject(payload) {
  const p = asPayload(payload);
  const script = typeof p.script === "string" ? p.script : "";
  if (!script.trim()) throw new Error("script_inject requires script");
  const tabId = await resolveTabId(typeof p.tabId === "number" ? p.tabId : undefined);
  await tabHttpUrl(tabId);
  const persistent = p.persistent === true;
  const runAt =
    p.runAt === "document_start" || p.runAt === "document_end" || p.runAt === "document_idle"
      ? p.runAt
      : "document_idle";

  if (persistent) {
    const tab = await chrome.tabs.get(tabId);
    const url = tab.url ?? "";
    const u = new URL(url);
    const matchPattern = `${u.origin}/*`;
    const injectionId = `poke-${crypto.randomUUID()}`;
    const got = await chrome.storage.local.get("pokePersistentInjections");
    const list = Array.isArray(got.pokePersistentInjections) ? got.pokePersistentInjections : [];
    list.push({ id: injectionId, matchPattern, script, runAt });
    await chrome.storage.local.set({ pokePersistentInjections: list });
    await ensurePersistentLoaderRegistered();
    return { success: true, injectionId };
  }

  if (runAt === "document_idle") {
    const res = await chrome.tabs.sendMessage(tabId, { type: "POKE_SCRIPT_INJECT", script }).catch((e) => {
      throw new Error(`script_inject relay failed: ${String(e)}`);
    });
    return { success: Boolean(res && res.success === true) };
  }

  await chrome.scripting.executeScript({
    target: { tabId, allFrames: false },
    world: "MAIN",
    injectImmediately: runAt === "document_start",
    func: (code) => {
      const s = document.createElement("script");
      s.textContent = code;
      const r = document.documentElement || document.head || document.body;
      if (r) {
        r.appendChild(s);
        s.remove();
      }
    },
    args: [script],
  });
  return { success: true };
}

/** @param {unknown} payload */
async function handleCookieManager(payload) {
  const p = asPayload(payload);
  const action =
    p.action === "get" || p.action === "get_all" || p.action === "set" || p.action === "delete" || p.action === "delete_all"
      ? p.action
      : null;
  if (!action) throw new Error("cookie_manager requires action");

  const tabId =
    typeof p.tabId === "number" && Number.isFinite(p.tabId) ? await resolveTabId(p.tabId) : undefined;

  /** @type {string | undefined} */
  let baseUrl = typeof p.url === "string" && p.url.length > 0 ? p.url : undefined;
  if (!baseUrl && tabId != null) {
    try {
      baseUrl = await tabHttpUrl(tabId);
    } catch {
      /* tab may be invalid for http(s); leave baseUrl unset */
    }
  }

  if (action === "get") {
    const name = typeof p.name === "string" ? p.name : "";
    if (!name) throw new Error("cookie get requires name");
    if (!baseUrl) throw new Error("cookie get requires url or http(s) tabId");
    const c = await chrome.cookies.get({ url: baseUrl, name });
    return { success: true, cookie: c ? serializeCookie(c) : undefined };
  }

  if (action === "get_all") {
    /** @type {chrome.cookies.GetAllDetails} */
    const q = {};
    if (baseUrl) q.url = baseUrl;
    const dom = typeof p.domain === "string" && p.domain.length > 0 ? p.domain : undefined;
    if (dom) q.domain = dom;
    if (!q.url && !q.domain) throw new Error("cookie get_all requires url/domain or http(s) tabId");
    const all = await chrome.cookies.getAll(q);
    const cookies = all.map(serializeCookie);
    return { success: true, cookie: cookies };
  }

  if (action === "set") {
    const name = typeof p.name === "string" ? p.name : "";
    if (!name) throw new Error("cookie set requires name");
    const value = typeof p.value === "string" ? p.value : "";
    if (!baseUrl && typeof p.domain !== "string") {
      throw new Error("cookie set requires url or tab with http(s) URL, or domain");
    }
    /** @type {chrome.cookies.SetDetails} */
    const details = { name, value };
    if (baseUrl) details.url = baseUrl;
    if (typeof p.domain === "string") details.domain = p.domain;
    if (typeof p.path === "string") details.path = p.path;
    if (p.secure === true) details.secure = true;
    if (p.httpOnly === true) details.httpOnly = true;
    if (typeof p.expirationDate === "number") details.expirationDate = p.expirationDate;
    const c = await chrome.cookies.set(details);
    if (!c) return { success: false, cookie: undefined };
    return { success: true, cookie: serializeCookie(c) };
  }

  if (action === "delete") {
    const name = typeof p.name === "string" ? p.name : "";
    if (!name) throw new Error("cookie delete requires name");
    if (!baseUrl) throw new Error("cookie delete requires url or http(s) tabId");
    const res = await chrome.cookies.remove({ url: baseUrl, name });
    return { success: Boolean(res) };
  }

  if (action === "delete_all") {
    const dom = typeof p.domain === "string" ? p.domain.trim() : "";
    if (!dom) throw new Error("cookie delete_all requires domain");
    const normalized = dom.startsWith(".") ? dom : `.${dom}`;
    const all = await chrome.cookies.getAll({ domain: normalized });
    for (const c of all) {
      const u = cookieRemoveUrl(c);
      await chrome.cookies.remove({ url: u, name: c.name });
    }
    return { success: true, cookie: all.map(serializeCookie) };
  }

  throw new Error("cookie_manager: unsupported action");
}

/** @param {unknown} payload */
async function handleFillForm(payload) {
  const p = asPayload(payload);
  const tabId = await resolveTabId(typeof p.tabId === "number" ? p.tabId : undefined);
  const fields = Array.isArray(p.fields) ? p.fields : [];
  const res = await chrome.tabs
    .sendMessage(tabId, {
      type: "POKE_FILL_FORM",
      fields,
      submitAfter: p.submitAfter === true,
      submitSelector: typeof p.submitSelector === "string" ? p.submitSelector : undefined,
    })
    .catch((e) => {
      throw new Error(`fill_form relay failed: ${String(e)}`);
    });
  return withTabMeta(tabId, res);
}

/** @param {unknown} payload */
async function handleGetStorage(payload) {
  const p = asPayload(payload);
  const type = p.type === "local" || p.type === "session" || p.type === "cookie" ? p.type : "local";
  const key = typeof p.key === "string" ? p.key : undefined;

  if (type === "cookie") {
    const tabId = await resolveTabId(typeof p.tabId === "number" ? p.tabId : undefined);
    const url = await tabHttpUrl(tabId);
    const all = await chrome.cookies.getAll({ url });
    /** @type {Record<string, string>} */
    const data = {};
    for (const c of all) {
      if (key && c.name !== key) continue;
      data[c.name] = c.value;
    }
    return { data, count: Object.keys(data).length };
  }

  const tabId = await resolveTabId(typeof p.tabId === "number" ? p.tabId : undefined);
  const res = await chrome.tabs
    .sendMessage(tabId, {
      type: "POKE_GET_STORAGE",
      storageType: type,
      key,
    })
    .catch((e) => {
      throw new Error(`get_storage relay failed: ${String(e)}`);
    });
  return res;
}

/** @param {unknown} payload */
async function handleSetStorage(payload) {
  const p = asPayload(payload);
  const type = p.type === "local" || p.type === "session" ? p.type : "local";
  const key = typeof p.key === "string" ? p.key : "";
  const value = typeof p.value === "string" ? p.value : "";
  if (!key) throw new Error("set_storage requires key");
  const tabId = await resolveTabId(typeof p.tabId === "number" ? p.tabId : undefined);
  const res = await chrome.tabs
    .sendMessage(tabId, {
      type: "POKE_SET_STORAGE",
      storageType: type,
      key,
      value,
    })
    .catch((e) => {
      throw new Error(`set_storage relay failed: ${String(e)}`);
    });
  return res;
}

/** @param {unknown} payload */
async function handleHoverElement(payload) {
  const p = asPayload(payload);
  const tabId = await resolveTabId(typeof p.tabId === "number" ? p.tabId : undefined);
  const selector = typeof p.selector === "string" ? p.selector.trim() : "";
  const x = typeof p.x === "number" ? p.x : Number(p.x);
  const y = typeof p.y === "number" ? p.y : Number(p.y);
  const hasXY = Number.isFinite(x) && Number.isFinite(y);

  if (selector) {
    const res = await chrome.tabs.sendMessage(tabId, { type: "POKE_HOVER_ELEMENT", selector }).catch((e) => {
      throw new Error(`hover_element relay failed: ${String(e)}`);
    });
    return withTabMeta(tabId, res);
  }
  if (hasXY) {
    await debuggerAttachForTool(tabId);
    try {
      await debuggerSend(tabId, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x,
        y,
      });
      return withTabMeta(tabId, { success: true });
    } finally {
      await debuggerDetachForTool(tabId);
    }
  }
  throw new Error("hover_element requires selector or numeric x and y");
}

/** @param {unknown} payload */
async function handleNewTab(payload) {
  const p = asPayload(payload);
  const url = typeof p.url === "string" && p.url.length > 0 ? p.url : "about:blank";
  const tab = await chrome.tabs.create({ url, active: p.active !== false });
  if (tab.id == null) throw new Error("Failed to create tab");
  return { tabId: tab.id };
}

/** @param {unknown} payload */
async function handleCloseTab(payload) {
  const p = asPayload(payload);
  if (typeof p.tabId !== "number" || !Number.isFinite(p.tabId)) {
    throw new Error("close_tab requires tabId");
  }
  await chrome.tabs.get(p.tabId).catch(() => {
    throw new Error(`Tab not found: ${p.tabId}`);
  });
  await chrome.tabs.remove(p.tabId);
  return { closed: true, tabId: p.tabId };
}

/** @param {unknown} payload */
async function handleSwitchTab(payload) {
  const p = asPayload(payload);
  if (typeof p.tabId !== "number" || !Number.isFinite(p.tabId)) {
    throw new Error("switch_tab requires tabId");
  }
  const tab = await chrome.tabs.get(p.tabId).catch(() => null);
  if (!tab?.id) throw new Error(`Tab not found: ${p.tabId}`);
  await chrome.tabs.update(p.tabId, { active: true });
  if (tab.windowId != null) {
    await chrome.windows.update(tab.windowId, { focused: true });
  }
  return { tabId: p.tabId, active: true };
}

/** @type {Record<string, (payload: unknown) => Promise<unknown>>} */
const COMMAND_HANDLERS = {
  list_tabs: handleListTabs,
  get_active_tab: handleGetActiveTab,
  navigate_to: handleNavigateTo,
  click_element: handleClickElement,
  type_text: handleTypeText,
  scroll_window: handleScrollWindow,
  screenshot: handleScreenshot,
  evaluate_js: handleEvaluateJs,
  new_tab: handleNewTab,
  close_tab: handleCloseTab,
  switch_tab: handleSwitchTab,
  get_dom_snapshot: handleGetDomSnapshot,
  get_accessibility_tree: handleGetAccessibilityTree,
  find_element: handleFindElement,
  read_page: handleReadPage,
  wait_for_selector: handleWaitForSelector,
  execute_script: handleExecuteScript,
  get_console_logs: handleGetConsoleLogs,
  clear_console_logs: handleClearConsoleLogs,
  get_network_logs: handleGetNetworkLogs,
  clear_network_logs: handleClearNetworkLogs,
  start_network_capture: handleStartNetworkCapture,
  stop_network_capture: handleStopNetworkCapture,
  hover_element: handleHoverElement,
  script_inject: handleScriptInject,
  cookie_manager: handleCookieManager,
  fill_form: handleFillForm,
  get_storage: handleGetStorage,
  set_storage: handleSetStorage,
  error_reporter: handleErrorReporter,
  get_performance_metrics: handleGetPerformanceMetrics,
  full_page_capture: handleFullPageCapture,
  pdf_export: handlePdfExport,
  device_emulate: handleDeviceEmulate,
};

/**
 * @param {string} command
 * @param {unknown} payload
 */
async function dispatchCommand(command, payload) {
  const handler = COMMAND_HANDLERS[command];
  if (!handler) throw new Error(`Unknown command: ${command}`);
  return handler(payload);
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get("wsPort").then((v) => {
    if (v.wsPort == null) {
      chrome.storage.local.set({ wsPort: DEFAULT_WS_PORT });
    }
  });
});

chrome.runtime.onStartup.addListener(() => {
  connectWebSocket();
});

connectWebSocket();

/** @type {Record<string, (message: unknown, sendResponse: (r: unknown) => void) => boolean | void>} */
const RUNTIME_HANDLERS = {
  POKE_GET_STATE: (message, sendResponse) => {
    void Promise.all([getWsPort(), chrome.storage.local.get("wsAuthToken")]).then(([port, st]) => {
      const tok = st && typeof st.wsAuthToken === "string" ? st.wsAuthToken : "";
      sendResponse({
        status: mcpStatus,
        port,
        log: commandLog,
        hasAuthToken: tok.length > 0,
      });
    });
    return true;
  },
  POKE_SET_TOKEN: (message, sendResponse) => {
    const m = /** @type {{ token?: unknown }} */ (message);
    const token = typeof m.token === "string" ? m.token : "";
    void chrome.storage.local.set({ wsAuthToken: token }).then(() => {
      resetWebSocketBackoff();
      if (socket) {
        suppressReconnectOnce = true;
        try {
          socket.close();
        } catch (_) {
          suppressReconnectOnce = false;
        }
        socket = null;
      }
      connectWebSocket();
      sendResponse({ ok: true });
    });
    return true;
  },
  POKE_SET_PORT: (message, sendResponse) => {
    const m = /** @type {{ port?: unknown }} */ (message);
    const next = Number(m.port);
    if (!Number.isFinite(next) || next <= 0 || next >= 65536) {
      sendResponse({ ok: false, error: "Invalid port" });
      return false;
    }
    void chrome.storage.local.set({ wsPort: next }).then(() => {
      resetWebSocketBackoff();
      if (socket) {
        suppressReconnectOnce = true;
        try {
          socket.close();
        } catch (_) {
          suppressReconnectOnce = false;
        }
        socket = null;
      }
      connectWebSocket();
      sendResponse({ ok: true, port: next });
    });
    return true;
  },
  POKE_RECONNECT: (_message, sendResponse) => {
    resetWebSocketBackoff();
    if (socket) {
      suppressReconnectOnce = true;
      try {
        socket.close();
      } catch (_) {
        suppressReconnectOnce = false;
      }
      socket = null;
    }
    connectWebSocket();
    sendResponse({ ok: true });
    return false;
  },
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const t = message && typeof message === "object" && "type" in message ? String(message.type) : "";
  const fn = RUNTIME_HANDLERS[t];
  if (fn) return fn(message, sendResponse);
  return undefined;
});
