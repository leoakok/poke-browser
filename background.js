/** @typedef {{ type: string, requestId?: string, command?: string, payload?: unknown }} WsInbound */

const DEFAULT_WS_PORT = 9009;
const LOG_MAX = 50;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 60000;
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
/** @type {ReturnType<typeof setTimeout> | null} */
let reconnectTimer = null;
let reconnectAttempt = 0;
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

function setStatus(next) {
  mcpStatus = next;
  chrome.runtime.sendMessage({ type: "POKE_STATUS", status: next }).catch(() => {});
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempt, RECONNECT_MAX_MS);
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWebSocket();
  }, delay);
}

function connectWebSocket() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  setStatus("connecting");
  getWsPort().then((port) => {
    const url = `ws://127.0.0.1:${port}`;
    try {
      socket = new WebSocket(url);
    } catch (e) {
      setStatus("disconnected");
      logCommand("out", `WebSocket construct failed: ${String(e)}`);
      scheduleReconnect();
      return;
    }

    socket.addEventListener("open", () => {
      reconnectAttempt = 0;
      setStatus("connected");
      logCommand("out", `Connected to MCP WebSocket ${url}`);
      try {
        socket?.send(
          JSON.stringify({
            type: "hello",
            client: "poke-browser-extension",
            version: chrome.runtime.getManifest().version,
          })
        );
      } catch (_) {
        /* ignore */
      }
    });

    socket.addEventListener("message", (event) => {
      handleSocketMessage(String(event.data)).catch((err) => {
        logCommand("in", `Handler error: ${String(err)}`);
      });
    });

    socket.addEventListener("close", () => {
      setStatus("disconnected");
      logCommand("out", "WebSocket closed");
      socket = null;
      scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      logCommand("out", "WebSocket error");
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
  const waitForLoad = p.waitForLoad === true;
  if (waitForLoad) {
    const done = waitForTabLoadComplete(tabId, NAVIGATE_WAIT_MS);
    await chrome.tabs.update(tabId, { url });
    await done;
  } else {
    await chrome.tabs.update(tabId, { url });
  }
  const tab = await chrome.tabs.get(tabId);
  return {
    success: true,
    finalUrl: tab.url ?? "",
    title: tab.title ?? "",
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
    return res;
  }
  if (hasXY) {
    return clickViaDebugger(tabId, x, y);
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
    return { success: true, charsTyped: typeof res.charsTyped === "number" ? res.charsTyped : text.length };
  }
  return typeTextViaDebugger(tabId, text);
}

/** @param {unknown} payload */
async function handleScrollWindow(payload) {
  const p = asPayload(payload);
  const tabId = await resolveTabId(typeof p.tabId === "number" ? p.tabId : undefined);
  const res = await chrome.tabs.sendMessage(tabId, { type: "POKE_SCROLL_WINDOW", payload: p }).catch((e) => {
    throw new Error(`scroll_window relay failed: ${String(e)}`);
  });
  return res;
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
  return {
    type: "screenshot_result",
    data: m[2],
    mimeType: m[1],
  };
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
  return sendPerceptionToTab(tabId, "POKE_GET_DOM_SNAPSHOT", {
    includeHidden: p.includeHidden === true,
    maxDepth: typeof p.maxDepth === "number" ? p.maxDepth : undefined,
  });
}

/** @param {unknown} payload */
async function handleGetAccessibilityTree(payload) {
  const p = asPayload(payload);
  const tabId = await resolveTabId(typeof p.tabId === "number" ? p.tabId : undefined);
  return sendPerceptionToTab(tabId, "POKE_GET_A11Y_TREE", {
    interactiveOnly: p.interactiveOnly === true,
  });
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
  return sendPerceptionToTab(tabId, "POKE_FIND_ELEMENT", { query, strategy });
}

/** @param {unknown} payload */
async function handleReadPage(payload) {
  const p = asPayload(payload);
  const tabId = await resolveTabId(typeof p.tabId === "number" ? p.tabId : undefined);
  const format =
    p.format === "markdown" || p.format === "text" || p.format === "structured" ? p.format : "structured";
  return sendPerceptionToTab(tabId, "POKE_READ_PAGE", { format });
}

/** @param {unknown} payload */
async function handleWaitForSelector(payload) {
  const p = asPayload(payload);
  const selector = typeof p.selector === "string" ? p.selector : "";
  if (!selector.trim()) throw new Error("wait_for_selector requires selector");
  const tabId = await resolveTabId(typeof p.tabId === "number" ? p.tabId : undefined);
  const timeout = typeof p.timeout === "number" && p.timeout > 0 ? p.timeout : 10000;
  const visible = p.visible === true;
  return chrome.tabs
    .sendMessage(tabId, { type: "POKE_WAIT_FOR_SELECTOR", selector, timeout, visible })
    .catch((e) => {
      throw new Error(`wait_for_selector relay failed: ${String(e)}`);
    });
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
  if (!fr) return { result: null, error: "No frame result" };
  if (typeof fr.error === "string" && fr.error && fr.result === undefined) {
    return { result: undefined, error: fr.error };
  }
  return { result: fr.result, error: typeof fr.error === "string" ? fr.error : undefined };
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

/** @param {unknown} payload */
async function handleHoverElement(payload) {
  const p = asPayload(payload);
  const tabId = await resolveTabId(typeof p.tabId === "number" ? p.tabId : undefined);
  const selector = typeof p.selector === "string" ? p.selector.trim() : "";
  const x = typeof p.x === "number" ? p.x : Number(p.x);
  const y = typeof p.y === "number" ? p.y : Number(p.y);
  const hasXY = Number.isFinite(x) && Number.isFinite(y);

  if (selector) {
    return chrome.tabs.sendMessage(tabId, { type: "POKE_HOVER_ELEMENT", selector }).catch((e) => {
      throw new Error(`hover_element relay failed: ${String(e)}`);
    });
  }
  if (hasXY) {
    await debuggerAttachForTool(tabId);
    try {
      await debuggerSend(tabId, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x,
        y,
      });
      return { success: true };
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
    void getWsPort().then((port) => {
      sendResponse({
        status: mcpStatus,
        port,
        log: commandLog,
      });
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
      if (socket) {
        try {
          socket.close();
        } catch (_) {
          /* ignore */
        }
        socket = null;
      }
      reconnectAttempt = 0;
      connectWebSocket();
      sendResponse({ ok: true, port: next });
    });
    return true;
  },
  POKE_RECONNECT: (_message, sendResponse) => {
    reconnectAttempt = 0;
    if (socket) {
      try {
        socket.close();
      } catch (_) {
        /* ignore */
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
