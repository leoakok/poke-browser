/** @typedef {{ type: string, requestId?: string, command?: string, payload?: unknown }} WsInbound */

const DEFAULT_WS_PORT = 9009;
const LOG_MAX = 50;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 60000;
const NAVIGATE_WAIT_MS = 30_000;

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
 * @param {number} x
 * @param {number} y
 */
async function clickViaDebugger(tabId, x, y) {
  await debuggerAttach(tabId);
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
    await debuggerDetach(tabId);
  }
}

/**
 * @param {number} tabId
 * @param {string} text
 */
async function typeTextViaDebugger(tabId, text) {
  await debuggerAttach(tabId);
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
    await debuggerDetach(tabId);
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
