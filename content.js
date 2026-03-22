/**
 * Relays automation commands from the service worker into the page.
 */

/**
 * @param {string} selector
 * @returns {Element | null}
 */
function querySelectorOrXPath(selector) {
  const s = selector.trim();
  if (s.startsWith("//") || s.toLowerCase().startsWith("xpath:")) {
    const expr = s.toLowerCase().startsWith("xpath:") ? s.slice(6).trim() : s;
    try {
      const r = document.evaluate(expr, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      const node = r.singleNodeValue;
      return node instanceof Element ? node : null;
    } catch {
      return null;
    }
  }
  try {
    return document.querySelector(s);
  } catch {
    return null;
  }
}

/**
 * @param {Element} el
 */
function elementSummary(el) {
  const tag = el.tagName.toLowerCase();
  const id = el.id || undefined;
  const classes = typeof el.className === "string" ? el.className : "";
  let text = "";
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    text = el.value?.slice(0, 200) ?? "";
  } else {
    text = (el.textContent || "").trim().slice(0, 200);
  }
  return { tag, id, classes, text };
}

/**
 * @param {Element} el
 */
function syntheticClick(el) {
  const r = el.getBoundingClientRect();
  const x = r.left + Math.min(r.width / 2, 50);
  const y = r.top + Math.min(r.height / 2, 50);
  const init = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
  el.dispatchEvent(new MouseEvent("mousedown", init));
  el.dispatchEvent(new MouseEvent("mouseup", init));
  if (typeof el.click === "function") el.click();
  else el.dispatchEvent(new MouseEvent("click", init));
}

/**
 * @param {unknown} message
 * @param {(r: unknown) => void} sendResponse
 */
function handleClickElement(message, sendResponse) {
  const m = /** @type {{ selector?: string }} */ (message);
  const selector = typeof m.selector === "string" ? m.selector : "";
  if (!selector) {
    sendResponse({ success: false, error: "Missing selector" });
    return;
  }
  const el = querySelectorOrXPath(selector);
  if (!el) {
    sendResponse({ success: false, error: "Element not found" });
    return;
  }
  try {
    syntheticClick(el);
    sendResponse({ success: true, element: elementSummary(el) });
  } catch (err) {
    sendResponse({ success: false, error: String(err) });
  }
}

/**
 * @param {unknown} message
 * @param {(r: unknown) => void} sendResponse
 */
function handleTypeText(message, sendResponse) {
  const m = /** @type {{ text?: string; selector?: string; clearFirst?: boolean }} */ (message);
  const text = typeof m.text === "string" ? m.text : "";
  const clearFirst = m.clearFirst === true;
  let el = null;
  if (typeof m.selector === "string" && m.selector.trim()) {
    el = querySelectorOrXPath(m.selector);
  } else {
    const a = document.activeElement;
    el = a instanceof Element ? a : null;
  }
  if (!el || !(el instanceof HTMLElement)) {
    sendResponse({ success: false, charsTyped: 0 });
    return;
  }

  try {
    if (el.isContentEditable) {
      el.focus();
      if (clearFirst) {
        const sel = window.getSelection();
        if (sel && el.firstChild) {
          const range = document.createRange();
          range.selectNodeContents(el);
          sel.removeAllRanges();
          sel.addRange(range);
        }
        document.execCommand("delete");
        el.textContent = text;
      } else {
        el.textContent = (el.textContent || "") + text;
      }
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      sendResponse({ success: true, charsTyped: text.length });
      return;
    }

    const tag = el.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea") {
      const input = /** @type {HTMLInputElement | HTMLTextAreaElement} */ (el);
      input.focus();
      if (clearFirst) {
        input.select();
        document.execCommand("delete");
        input.value = text;
      } else {
        input.value = (input.value || "") + text;
      }
      input.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      sendResponse({ success: true, charsTyped: text.length });
      return;
    }

    sendResponse({ success: false, charsTyped: 0 });
  } catch (err) {
    sendResponse({ success: false, charsTyped: 0, error: String(err) });
  }
}

/**
 * @param {unknown} message
 * @param {(r: unknown) => void} sendResponse
 */
function handleScrollWindow(message, sendResponse) {
  const m = /** @type {{ payload?: Record<string, unknown> }} */ (message);
  const p = m.payload && typeof m.payload === "object" ? m.payload : {};
  const behavior = p.behavior === "smooth" ? "smooth" : "auto";
  const selector = typeof p.selector === "string" ? p.selector.trim() : "";

  try {
    if (selector) {
      const el = querySelectorOrXPath(selector);
      if (!el) {
        sendResponse({ success: false, scrollX: window.scrollX, scrollY: window.scrollY, error: "Element not found" });
        return;
      }
      el.scrollIntoView({ behavior, block: "center", inline: "nearest" });
    } else if (typeof p.x === "number" || typeof p.y === "number") {
      const left = typeof p.x === "number" ? p.x : window.scrollX;
      const top = typeof p.y === "number" ? p.y : window.scrollY;
      window.scrollTo({ left, top, behavior });
    } else {
      const dx = typeof p.deltaX === "number" ? p.deltaX : 0;
      const dy = typeof p.deltaY === "number" ? p.deltaY : 0;
      window.scrollBy({ left: dx, top: dy, behavior });
    }
    sendResponse({ success: true, scrollX: window.scrollX, scrollY: window.scrollY });
  } catch (err) {
    sendResponse({ success: false, scrollX: window.scrollX, scrollY: window.scrollY, error: String(err) });
  }
}

/**
 * @param {unknown} message
 * @param {(r: unknown) => void} sendResponse
 */
function handleEval(message, sendResponse) {
  const m = /** @type {{ requestId?: string; code?: string; timeoutMs?: number }} */ (message);
  const requestId = m.requestId || `poke-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const code = String(m.code ?? "");
  let finished = false;
  const timeoutMs = typeof m.timeoutMs === "number" ? m.timeoutMs : 30000;

  const timer = setTimeout(() => {
    if (finished) return;
    finished = true;
    window.removeEventListener("message", onWindowMessage);
    sendResponse({ ok: false, error: "evaluate_js timed out in content script" });
  }, timeoutMs);

  /**
   * @param {MessageEvent} event
   */
  function onWindowMessage(event) {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.type !== "POKE_EVAL_RESULT" || data.requestId !== requestId) return;
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    window.removeEventListener("message", onWindowMessage);
    if (data.ok) {
      sendResponse({ ok: true, result: data.result });
    } else {
      sendResponse({ ok: false, error: data.error || "evaluate failed" });
    }
  }

  window.addEventListener("message", onWindowMessage);

  const s = document.createElement("script");
  s.textContent = `
      (function () {
        var requestId = ${JSON.stringify(requestId)};
        try {
          var result = (0, eval)(${JSON.stringify(code)});
          window.postMessage({ type: "POKE_EVAL_RESULT", requestId: requestId, ok: true, result: result }, "*");
        } catch (e) {
          window.postMessage({ type: "POKE_EVAL_RESULT", requestId: requestId, ok: false, error: String(e) }, "*");
        }
      })();
    `;
  (document.documentElement || document.head || document.body).appendChild(s);
  s.remove();
}

/** @type {Record<string, (message: unknown, sendResponse: (r: unknown) => void) => void>} */
const MESSAGE_HANDLERS = {
  POKE_CLICK_ELEMENT: handleClickElement,
  POKE_TYPE_TEXT: handleTypeText,
  POKE_SCROLL_WINDOW: handleScrollWindow,
  POKE_EVAL: handleEval,
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const t = message && typeof message === "object" && "type" in message ? String(message.type) : "";
  const fn = MESSAGE_HANDLERS[t];
  if (!fn) return undefined;
  queueMicrotask(() => {
    try {
      fn(message, sendResponse);
    } catch (err) {
      sendResponse({ success: false, error: String(err), ok: false });
    }
  });
  return true;
});
