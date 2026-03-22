/**
 * Relays automation commands from the service worker into the page.
 */

const CONSOLE_RING_MAX = 500;
const PAGE_ERROR_RING_MAX = 200;

/** @type {Array<{ level: string; message: string; timestamp: number; stack?: string }>} */
let consoleRing = [];

/**
 * Uncaught errors and unhandled rejections (separate from console ring).
 * @type {Array<{ kind: string; message: string; stack?: string; filename?: string; lineno?: number; colno?: number; timestamp: number }>}
 */
let pageErrorRing = [];

/**
 * @param {{ kind: string; message: string; stack?: string; filename?: string; lineno?: number; colno?: number; timestamp: number }} entry
 */
function pushPageError(entry) {
  pageErrorRing.push(entry);
  while (pageErrorRing.length > PAGE_ERROR_RING_MAX) pageErrorRing.shift();
}

window.addEventListener("error", (ev) => {
  try {
    pushPageError({
      kind: "error",
      message: ev.message || String(ev.error || "error"),
      stack: ev.error instanceof Error ? ev.error.stack : undefined,
      filename: ev.filename,
      lineno: ev.lineno,
      colno: ev.colno,
      timestamp: Date.now(),
    });
  } catch {
    /* ignore */
  }
});

window.addEventListener("unhandledrejection", (ev) => {
  try {
    const reason = ev.reason;
    const message =
      reason instanceof Error ? reason.message : typeof reason === "string" ? reason : String(reason);
    const stack = reason instanceof Error ? reason.stack : undefined;
    pushPageError({
      kind: "unhandledrejection",
      message,
      stack,
      timestamp: Date.now(),
    });
  } catch {
    /* ignore */
  }
});

/**
 * @param {unknown} a
 */
function formatConsoleArg(a) {
  if (a instanceof Error) return a.stack || a.message;
  if (typeof a === "object" && a !== null) {
    try {
      return JSON.stringify(a);
    } catch {
      return String(a);
    }
  }
  return String(a);
}

/**
 * @param {string} level
 * @param {unknown[]} args
 */
function pushConsoleEntry(level, args) {
  const message = args.map(formatConsoleArg).join(" ").slice(0, 20000);
  const errArg = args.find((x) => x instanceof Error);
  consoleRing.push({
    level,
    message,
    timestamp: Date.now(),
    stack: errArg instanceof Error ? errArg.stack : undefined,
  });
  while (consoleRing.length > CONSOLE_RING_MAX) consoleRing.shift();
}

["log", "info", "warn", "error"].forEach((level) => {
  const orig = console[level].bind(console);
  console[level] = function pokeConsolePatched(...args) {
    try {
      pushConsoleEntry(level, args);
    } catch {
      /* ignore ring failures */
    }
    orig(...args);
  };
});

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

// --- Perception: shared helpers -------------------------------------------------

/**
 * @param {Record<string, unknown>} obj
 */
function compactJson(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/**
 * @param {Element} el
 */
function cssEscapeId(id) {
  if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(id);
  return id.replace(/([^\w-])/g, "\\$1");
}

/**
 * @param {Element} el
 */
function uniqueSelector(el) {
  if (!(el instanceof Element)) return "";
  if (el.id && document.querySelectorAll(`#${cssEscapeId(el.id)}`).length === 1) {
    return `#${cssEscapeId(el.id)}`;
  }
  const parts = [];
  let cur = el;
  while (cur && cur.nodeType === Node.ELEMENT_NODE && cur !== document.documentElement) {
    let part = cur.tagName.toLowerCase();
    if (cur.id) {
      parts.unshift(`#${cssEscapeId(cur.id)}`);
      break;
    }
    const parent = cur.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
      const idx = siblings.indexOf(cur) + 1;
      if (siblings.length > 1) part += `:nth-of-type(${idx})`;
    }
    parts.unshift(part);
    cur = /** @type {Element} */ (parent);
  }
  return parts.join(" > ");
}

/**
 * @param {Element} el
 */
function elementInteractive(el) {
  if (!(el instanceof Element)) return false;
  const tag = el.tagName.toLowerCase();
  if (["a", "button", "input", "select", "textarea", "summary", "option", "label"].includes(tag)) {
    return true;
  }
  const role = el.getAttribute("role");
  if (
    role &&
    ["button", "link", "menuitem", "tab", "checkbox", "radio", "switch", "textbox", "searchbox", "combobox", "slider", "spinbutton"].includes(
      role
    )
  ) {
    return true;
  }
  if (el.hasAttribute("onclick")) return true;
  if (el instanceof HTMLElement && el.isContentEditable) return true;
  const tab = el.getAttribute("tabindex");
  if (tab !== null && tab !== "-1" && !Number.isNaN(Number.parseInt(tab, 10))) return true;
  return false;
}

/**
 * @param {Element} el
 * @param {boolean} includeHidden
 */
function isSkippedHidden(el, includeHidden) {
  if (includeHidden) return false;
  if (!(el instanceof HTMLElement)) return true;
  if (el === document.body || el === document.documentElement) return false;
  const st = window.getComputedStyle(el);
  if (st.display === "none" || st.visibility === "hidden") return true;
  if (el.offsetParent === null) {
    const pos = st.position;
    if (pos !== "fixed" && pos !== "sticky") return true;
  }
  return false;
}

/**
 * @param {Element} el
 * @param {number} maxLen
 */
function trimText(el, maxLen) {
  let t = (el.textContent || "").trim().replace(/\s+/g, " ");
  if (t.length > maxLen) t = t.slice(0, maxLen);
  return t;
}

/**
 * @param {Element} el
 * @param {number} depth
 * @param {number} maxDepth
 * @param {boolean} includeHidden
 */
function buildDomSnapshotNode(el, depth, maxDepth, includeHidden) {
  if (depth > maxDepth) return null;
  if (isSkippedHidden(el, includeHidden)) return null;
  const r = el.getBoundingClientRect();
  /** @type {Record<string, unknown>} */
  const node = {
    tag: el.tagName.toLowerCase(),
    rect: { x: r.x, y: r.y, width: r.width, height: r.height },
    interactive: elementInteractive(el),
  };
  if (el.id) node.id = el.id;
  const cls =
    typeof el.className === "string" && el.className.trim()
      ? el.className.trim().split(/\s+/).filter(Boolean)
      : [];
  if (cls.length) node.classes = cls;
  const role = el.getAttribute("role");
  if (role) node.role = role;
  const al = el.getAttribute("aria-label");
  if (al) node["aria-label"] = al;
  const tx = trimText(el, 120);
  if (tx) node.text = tx;
  const childEls = Array.from(el.children);
  const children = [];
  for (const c of childEls) {
    const sn = buildDomSnapshotNode(c, depth + 1, maxDepth, includeHidden);
    if (sn) children.push(sn);
  }
  if (children.length) node.children = children;
  return node;
}

/**
 * @param {unknown} message
 * @param {(r: unknown) => void} sendResponse
 */
function handleGetDomSnapshot(message, sendResponse) {
  const m = /** @type {{ includeHidden?: boolean; maxDepth?: number }} */ (message);
  const includeHidden = m.includeHidden === true;
  const maxDepth = typeof m.maxDepth === "number" && Number.isFinite(m.maxDepth) ? Math.max(0, Math.min(50, m.maxDepth)) : 6;
  if (!document.body) {
    sendResponse({ error: "No document.body" });
    return;
  }
  const snapshot = buildDomSnapshotNode(document.body, 0, maxDepth, includeHidden);
  sendResponse(
    compactJson({
      snapshot,
      url: location.href,
      title: document.title || "",
      timestamp: Date.now(),
    })
  );
}

/**
 * @param {Element} el
 */
function impliedRole(el) {
  const r = el.getAttribute("role");
  if (r) return r;
  const t = el.tagName.toLowerCase();
  if (t === "a") return "link";
  if (t === "button") return "button";
  if (t === "select") return "combobox";
  if (t === "textarea") return "textbox";
  if (t === "img") return "img";
  if (t === "form") return "form";
  if (t === "input") {
    const type = (/** @type {HTMLInputElement} */ (el)).type || "text";
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "button" || type === "submit" || type === "reset") return "button";
    return "textbox";
  }
  if (/^h[1-6]$/.test(t)) return "heading";
  if (t === "p") return "paragraph";
  if (t === "li") return "listitem";
  return t;
}

/**
 * @param {Element} el
 */
function accessibilityName(el) {
  const aria = el.getAttribute("aria-label");
  if (aria && aria.trim()) return aria.trim().slice(0, 80);
  if (el instanceof HTMLImageElement && el.alt) return el.alt.trim().slice(0, 80);
  const title = el.getAttribute("title");
  if (title && title.trim()) return title.trim().slice(0, 80);
  const ph = el.getAttribute("aria-placeholder");
  if (ph && ph.trim()) return ph.trim().slice(0, 80);
  const it = (el.innerText || "").trim().replace(/\s+/g, " ");
  return it.length > 80 ? it.slice(0, 80) : it;
}

/**
 * @param {Element} el
 */
function isFocusableInteractive(el) {
  if (!(el instanceof HTMLElement)) return false;
  if (el.hasAttribute("disabled")) return false;
  if (elementInteractive(el)) {
    const tab = el.getAttribute("tabindex");
    if (tab === "-1" && !["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "SUMMARY"].includes(el.tagName)) {
      return false;
    }
    return true;
  }
  return false;
}

/**
 * @param {unknown} message
 * @param {(r: unknown) => void} sendResponse
 */
function handleGetAccessibilityTree(message, sendResponse) {
  const m = /** @type {{ interactiveOnly?: boolean }} */ (message);
  const interactiveOnly = m.interactiveOnly === true;
  const sel =
    '[role], a, button, input, select, textarea, h1, h2, h3, h4, h5, h6, p, li, img, form';
  const list = Array.from(document.querySelectorAll(sel));
  /** @type {Array<Record<string, unknown>>} */
  const raw = [];
  for (const el of list) {
    if (!(el instanceof Element)) continue;
    if (isSkippedHidden(el, false)) continue;
    if (interactiveOnly && !isFocusableInteractive(el)) continue;
    const r = el.getBoundingClientRect();
    const tag = el.tagName.toLowerCase();
    /** @type {Record<string, unknown>} */
    const row = {
      role: impliedRole(el),
      name: accessibilityName(el),
      selector: uniqueSelector(el),
      disabled: el instanceof HTMLElement && (el.hasAttribute("disabled") || /** @type {HTMLInputElement} */ (el).disabled === true),
      rect: { x: r.x, y: r.y, w: r.width, h: r.height },
    };
    if (el.id) row.id = el.id;
    if (/^h[1-6]$/.test(tag)) row.level = Number(tag[1]);
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
      row.value = el.value;
      if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
        row.checked = el.checked;
      }
    }
    raw.push(row);
  }
  raw.sort((a, b) => {
    const ra = /** @type {{ x: number; y: number }} */ (a.rect);
    const rb = /** @type {{ x: number; y: number }} */ (b.rect);
    if (Math.abs(ra.y - rb.y) > 1) return ra.y - rb.y;
    return ra.x - rb.x;
  });
  const nodes = raw.map((row) => compactJson({ ...row }));
  sendResponse({
    nodes,
    count: nodes.length,
    url: location.href,
  });
}

/**
 * @param {string} expr
 * @returns {Element[]}
 */
function xpathElements(expr) {
  const out = [];
  try {
    const r = document.evaluate(expr, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    for (let i = 0; i < r.snapshotLength; i++) {
      const n = r.snapshotItem(i);
      if (n instanceof Element) out.push(n);
    }
  } catch {
    /* ignore */
  }
  return out;
}

/**
 * @param {string} q
 * @returns {Element[]}
 */
function findElementsByText(q) {
  const ql = q.toLowerCase().trim();
  if (!ql) return [];
  const all = document.body ? document.body.querySelectorAll("*") : [];
  /** @type {Element[]} */
  const exact = [];
  /** @type {Element[]} */
  const partial = [];
  for (const el of all) {
    if (!(el instanceof HTMLElement)) continue;
    const tn = el.tagName;
    if (tn === "SCRIPT" || tn === "STYLE" || tn === "NOSCRIPT") continue;
    const t = (el.innerText || "").trim();
    if (!t) continue;
    const tl = t.toLowerCase();
    if (tl === ql) exact.push(el);
    else if (tl.includes(ql)) partial.push(el);
  }
  const pool = exact.length ? exact : partial;
  return filterOutAncestors(pool);
}

/**
 * @param {Element[]} els
 */
function filterOutAncestors(els) {
  /** @type {Element[]} */
  const out = [];
  for (const el of els) {
    let sub = false;
    for (const o of els) {
      if (o !== el && o.contains(el)) {
        sub = true;
        break;
      }
    }
    if (!sub) out.push(el);
  }
  return out;
}

/**
 * @param {string} q
 * @returns {Element[]}
 */
function findElementsByAria(q) {
  const ql = q.toLowerCase().trim();
  if (!ql) return [];
  const all = document.body ? document.body.querySelectorAll("*") : [];
  /** @type {Element[]} */
  const hits = [];
  for (const el of all) {
    if (!(el instanceof Element)) continue;
    const tn = el.tagName;
    if (tn === "SCRIPT" || tn === "STYLE" || tn === "NOSCRIPT") continue;
    const chunks = [
      el.getAttribute("aria-label"),
      el.getAttribute("aria-placeholder"),
      el.getAttribute("title"),
      el instanceof HTMLImageElement ? el.alt : null,
    ]
      .filter(Boolean)
      .map((s) => String(s).toLowerCase());
    if (chunks.some((c) => c.includes(ql))) hits.push(el);
  }
  return filterOutAncestors(hits);
}

/**
 * @param {Element} el
 * @param {number} index
 */
function toFoundElement(el, index) {
  const r = el.getBoundingClientRect();
  const cls =
    typeof el.className === "string" && el.className.trim()
      ? el.className.trim().split(/\s+/).filter(Boolean)
      : [];
  /** @type {Record<string, unknown>} */
  const o = {
    index,
    tag: el.tagName.toLowerCase(),
    text: (el.innerText || "").trim().slice(0, 200),
    selector: uniqueSelector(el),
    rect: { x: r.x, y: r.y, width: r.width, height: r.height },
    interactive: elementInteractive(el),
  };
  if (el.id) o.id = el.id;
  if (cls.length) o.classes = cls;
  return compactJson(o);
}

/**
 * @param {unknown} message
 * @param {(r: unknown) => void} sendResponse
 */
function handleFindElement(message, sendResponse) {
  const m = /** @type {{ query?: string; strategy?: string }} */ (message);
  const query = typeof m.query === "string" ? m.query : "";
  const strategy = m.strategy === "css" || m.strategy === "text" || m.strategy === "aria" || m.strategy === "xpath" ? m.strategy : "auto";
  if (!query.trim()) {
    sendResponse({ elements: [], query: "", strategy_used: strategy });
    return;
  }

  /** @type {Element[]} */
  let found = [];
  /** @type {string} */
  let used = strategy;

  function tryCss() {
    try {
      return Array.from(document.querySelectorAll(query));
    } catch {
      return [];
    }
  }

  if (strategy === "auto") {
    found = tryCss();
    used = "css";
    if (found.length === 0) {
      found = findElementsByText(query);
      used = "text";
    }
    if (found.length === 0) {
      found = findElementsByAria(query);
      used = "aria";
    }
  } else if (strategy === "css") {
    found = tryCss();
  } else if (strategy === "text") {
    found = findElementsByText(query);
  } else if (strategy === "aria") {
    found = findElementsByAria(query);
  } else if (strategy === "xpath") {
    found = xpathElements(query);
    used = "xpath";
  }

  const top = found.slice(0, 5);
  const elements = top.map((el, i) => toFoundElement(el, i));
  sendResponse({ elements, query, strategy_used: used });
}

/**
 * @returns {HTMLElement}
 */
function getReadPageRoot() {
  const main =
    document.querySelector("main") ||
    document.querySelector("article") ||
    document.querySelector('[role="main"]');
  if (main instanceof HTMLElement) return main;
  return document.body || document.documentElement;
}

/**
 * @param {HTMLElement} el
 */
function stripNoise(el) {
  el.querySelectorAll("script, style, noscript, nav, header, footer").forEach((n) => n.remove());
}

/**
 * @param {string} text
 */
function wordCountFrom(text) {
  const w = text.trim().split(/\s+/).filter(Boolean);
  return w.length;
}

/**
 * @param {HTMLElement} root
 */
function readStructured(root) {
  const clone = /** @type {HTMLElement} */ (root.cloneNode(true));
  stripNoise(clone);
  const descMeta = document.querySelector('meta[name="description"]');
  const description = descMeta?.getAttribute("content")?.trim() || "";
  /** @type {{ level: number; text: string }[]} */
  const headings = [];
  clone.querySelectorAll("h1, h2, h3, h4, h5, h6").forEach((h) => {
    const tag = h.tagName.toLowerCase();
    headings.push({ level: Number(tag[1]), text: (h.textContent || "").trim() });
  });
  /** @type {{ text: string; href: string }[]} */
  const links = [];
  clone.querySelectorAll("a[href]").forEach((a) => {
    const href = a.getAttribute("href") || "";
    links.push({ text: (a.textContent || "").trim(), href });
  });
  /** @type {{ alt: string; src: string }[]} */
  const images = [];
  clone.querySelectorAll("img[src]").forEach((img) => {
    images.push({ alt: img.getAttribute("alt") || "", src: img.getAttribute("src") || "" });
  });
  const mainText = (clone.innerText || "").trim().replace(/\s+/g, " ");
  return {
    title: document.title || "",
    url: location.href,
    description,
    mainText,
    headings,
    links,
    images,
  };
}

/**
 * @param {HTMLElement} el
 * @returns {string}
 */
function elementToMarkdown(el) {
  const tag = el.tagName.toLowerCase();
  if (["script", "style", "noscript", "nav", "header", "footer"].includes(tag)) return "";
  if (tag === "br") return "\n";
  if (el.childNodes.length === 0) return "";

  /** @type {string[]} */
  const bits = [];
  for (const node of el.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = node.textContent || "";
      if (t.trim()) bits.push(t);
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const child = /** @type {HTMLElement} */ (node);
      const ct = child.tagName.toLowerCase();
      if (["script", "style", "noscript", "nav", "header", "footer"].includes(ct)) continue;
      if (/^h[1-6]$/.test(ct)) {
        const level = Number(ct[1]);
        bits.push(`${"#".repeat(level)} ${(child.innerText || "").trim()}\n\n`);
      } else if (ct === "p") {
        bits.push(`${(child.innerText || "").trim()}\n\n`);
      } else if (ct === "a" && child.getAttribute("href")) {
        const href = child.getAttribute("href") || "";
        bits.push(`[${(child.textContent || "").trim()}](${href})`);
      } else if (ct === "ul") {
        for (const li of child.querySelectorAll(":scope > li")) {
          bits.push(`- ${(li.textContent || "").trim()}\n`);
        }
        bits.push("\n");
      } else if (ct === "ol") {
        let i = 1;
        for (const li of child.querySelectorAll(":scope > li")) {
          bits.push(`${i}. ${(li.textContent || "").trim()}\n`);
          i += 1;
        }
        bits.push("\n");
      } else if (ct === "pre") {
        bits.push(`\`\`\`\n${(child.textContent || "").trim()}\n\`\`\`\n\n`);
      } else if (ct === "code" && child.parentElement?.tagName.toLowerCase() !== "pre") {
        bits.push(`\`${(child.textContent || "").trim()}\``);
      } else if (ct === "strong" || ct === "b") {
        bits.push(`**${(child.textContent || "").trim()}**`);
      } else if (ct === "img" && child.getAttribute("src")) {
        const src = child.getAttribute("src") || "";
        const alt = child.getAttribute("alt") || "";
        bits.push(`![${alt}](${src})`);
      } else {
        bits.push(elementToMarkdown(child));
      }
    }
  }
  return bits.join("");
}

/**
 * @param {unknown} message
 * @param {(r: unknown) => void} sendResponse
 */
/**
 * @param {Element} el
 * @param {boolean} requireVisible
 */
function elementMatchesVisible(el, requireVisible) {
  if (!requireVisible) return true;
  if (!(el instanceof HTMLElement)) return false;
  if (el.offsetParent === null) {
    const st = getComputedStyle(el);
    const pos = st.position;
    if (pos !== "fixed" && pos !== "sticky") return false;
  }
  const st = getComputedStyle(el);
  if (st.display === "none" || st.visibility === "hidden" || Number.parseFloat(st.opacity) === 0) {
    return false;
  }
  return true;
}

/**
 * @param {unknown} message
 * @param {(r: unknown) => void} sendResponse
 */
function handleWaitForSelector(message, sendResponse) {
  const m = /** @type {{ selector?: string; timeout?: number; visible?: boolean }} */ (message);
  const selector = typeof m.selector === "string" ? m.selector : "";
  const timeout = typeof m.timeout === "number" && m.timeout > 0 ? m.timeout : 10000;
  const visible = m.visible === true;
  const start = Date.now();

  /** @type {ReturnType<typeof setInterval> | undefined} */
  let iv;

  function tick() {
    const el = querySelectorOrXPath(selector);
    if (el && elementMatchesVisible(el, visible)) {
      if (iv !== undefined) clearInterval(iv);
      const r = el.getBoundingClientRect();
      sendResponse({
        found: true,
        selector,
        elapsed: Date.now() - start,
        element: {
          tag: el.tagName.toLowerCase(),
          id: el.id || undefined,
          text: (el.textContent || "").trim().slice(0, 200),
          rect: { x: r.x, y: r.y, width: r.width, height: r.height },
        },
      });
      return;
    }
    if (Date.now() - start >= timeout) {
      if (iv !== undefined) clearInterval(iv);
      sendResponse({
        found: false,
        selector,
        elapsed: Date.now() - start,
        error: "timeout",
      });
    }
  }

  iv = setInterval(tick, 100);
  tick();
}

/**
 * @param {unknown} message
 * @param {(r: unknown) => void} sendResponse
 */
function handleGetConsoleLogs(message, sendResponse) {
  const m = /** @type {{ level?: string; limit?: number }} */ (message);
  const level = m.level === "error" || m.level === "warn" || m.level === "info" || m.level === "log" ? m.level : "all";
  const limit = typeof m.limit === "number" ? Math.min(500, Math.max(1, m.limit)) : 100;
  let logs = consoleRing;
  if (level !== "all") {
    logs = logs.filter((e) => e.level === level);
  }
  const sliced = logs.slice(-limit);
  sendResponse({ logs: sliced, count: sliced.length });
}

/**
 * @param {unknown} _message
 * @param {(r: unknown) => void} sendResponse
 */
function handleClearConsoleLogs(_message, sendResponse) {
  consoleRing = [];
  sendResponse({ cleared: true });
}

/**
 * @param {unknown} message
 * @param {(r: unknown) => void} sendResponse
 */
function handleGetPageErrors(message, sendResponse) {
  const m = /** @type {{ limit?: number }} */ (message);
  const limit = typeof m.limit === "number" ? Math.min(200, Math.max(1, m.limit)) : 50;
  const sliced = pageErrorRing.slice(-limit);
  sendResponse({ errors: sliced, count: sliced.length });
}

/**
 * @param {unknown} _message
 * @param {(r: unknown) => void} sendResponse
 */
function handleGetScrollInfo(_message, sendResponse) {
  const de = document.documentElement;
  const body = document.body;
  sendResponse({
    scrollHeight: Math.max(de.scrollHeight, body ? body.scrollHeight : 0, de.clientHeight),
    innerHeight: window.innerHeight,
    innerWidth: window.innerWidth,
    scrollY: window.scrollY,
    devicePixelRatio: window.devicePixelRatio || 1,
  });
}

/**
 * @param {unknown} message
 * @param {(r: unknown) => void} sendResponse
 */
function handleScrollTo(message, sendResponse) {
  const m = /** @type {{ y?: number }} */ (message);
  const y = typeof m.y === "number" ? m.y : 0;
  window.scrollTo({ top: y, left: 0, behavior: "instant" });
  sendResponse({ scrollY: window.scrollY });
}

/**
 * @param {unknown} message
 * @param {(r: unknown) => void} sendResponse
 */
function handleHoverElement(message, sendResponse) {
  const m = /** @type {{ selector?: string }} */ (message);
  const selector = typeof m.selector === "string" ? m.selector : "";
  if (!selector.trim()) {
    sendResponse({ success: false });
    return;
  }
  const el = querySelectorOrXPath(selector);
  if (!el) {
    sendResponse({ success: false });
    return;
  }
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  const init = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
  el.dispatchEvent(new MouseEvent("mousemove", init));
  el.dispatchEvent(new MouseEvent("mouseover", init));
  el.dispatchEvent(new MouseEvent("mouseenter", init));
  sendResponse({
    success: true,
    element: {
      tag: el.tagName.toLowerCase(),
      id: el.id || undefined,
      text: (el.textContent || "").trim().slice(0, 200),
      rect: { x: r.x, y: r.y, width: r.width, height: r.height },
    },
  });
}

/**
 * @param {unknown} message
 * @param {(r: unknown) => void} sendResponse
 */
function handleScriptInject(message, sendResponse) {
  const m = /** @type {{ script?: string }} */ (message);
  const script = typeof m.script === "string" ? m.script : "";
  if (!script) {
    sendResponse({ success: false });
    return;
  }
  try {
    const s = document.createElement("script");
    s.textContent = script;
    const root = document.documentElement || document.head || document.body;
    if (!root) {
      sendResponse({ success: false });
      return;
    }
    root.appendChild(s);
    s.remove();
    sendResponse({ success: true });
  } catch (err) {
    sendResponse({ success: false, error: String(err) });
  }
}

/**
 * @param {unknown} message
 * @param {(r: unknown) => void} sendResponse
 */
function handleFillForm(message, sendResponse) {
  const m = /** @type {{
    fields?: Array<{ selector?: string; value?: string; type?: string }>;
    submitAfter?: boolean;
    submitSelector?: string;
  }} */ (message);
  const fields = Array.isArray(m.fields) ? m.fields : [];
  /** @type {Array<{ selector: string; error: string }>} */
  const errors = [];
  let filled = 0;

  for (const f of fields) {
    const sel = typeof f.selector === "string" ? f.selector : "";
    const val = typeof f.value === "string" ? f.value : "";
    const typ = f.type === "select" || f.type === "checkbox" || f.type === "radio" || f.type === "file" ? f.type : "text";
    if (!sel) {
      errors.push({ selector: sel, error: "empty selector" });
      continue;
    }
    const el = querySelectorOrXPath(sel);
    if (!el) {
      errors.push({ selector: sel, error: "not found" });
      continue;
    }
    try {
      if (typ === "file") {
        errors.push({ selector: sel, error: "file inputs are not supported" });
        continue;
      }
      if (typ === "checkbox") {
        const input = el instanceof HTMLInputElement ? el : null;
        if (!input || input.type !== "checkbox") {
          errors.push({ selector: sel, error: "not a checkbox input" });
          continue;
        }
        const vl = val.toLowerCase();
        input.checked = !(vl === "false" || val === "0" || vl === "off" || val === "");
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        filled += 1;
        continue;
      }
      if (typ === "radio") {
        const input = el instanceof HTMLInputElement ? el : null;
        if (!input || input.type !== "radio") {
          errors.push({ selector: sel, error: "not a radio input" });
          continue;
        }
        const vl = val.toLowerCase();
        const off = val === "" || vl === "false" || val === "0" || vl === "off";
        if (off) {
          input.checked = false;
        } else {
          input.checked = true;
          if (input.form) {
            const rads = input.form.querySelectorAll('input[type="radio"]');
            rads.forEach((x) => {
              if (x instanceof HTMLInputElement && x.name === input.name && x !== input) {
                x.checked = false;
              }
            });
          }
        }
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        filled += 1;
        continue;
      }
      if (typ === "select" && el instanceof HTMLSelectElement) {
        let matched = false;
        for (let i = 0; i < el.options.length; i += 1) {
          const o = el.options[i];
          if (o.value === val || o.text === val) {
            el.selectedIndex = i;
            matched = true;
            break;
          }
        }
        if (!matched) el.value = val;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        filled += 1;
        continue;
      }
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        el.focus();
        el.value = val;
        el.dispatchEvent(
          new InputEvent("input", { bubbles: true, data: val, inputType: "insertReplacementText" }),
        );
        el.dispatchEvent(new Event("change", { bubbles: true }));
        filled += 1;
        continue;
      }
      errors.push({ selector: sel, error: "unsupported element for text fill" });
    } catch (err) {
      errors.push({ selector: sel, error: String(err) });
    }
  }

  let success = errors.length === 0;
  if (m.submitAfter === true) {
    const subSel = typeof m.submitSelector === "string" ? m.submitSelector.trim() : "";
    let sub = subSel ? querySelectorOrXPath(subSel) : null;
    if (!sub && fields[0]) {
      const firstSel = typeof fields[0].selector === "string" ? fields[0].selector : "";
      const first = firstSel ? querySelectorOrXPath(firstSel) : null;
      const form = first && first.closest ? first.closest("form") : null;
      if (form) {
        sub =
          form.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
      }
    }
    if (sub) {
      syntheticClick(sub);
    } else {
      errors.push({ selector: "[submit]", error: "no submit control found" });
      success = false;
    }
  }

  sendResponse({ success, filled, errors });
}

/**
 * @param {unknown} message
 * @param {(r: unknown) => void} sendResponse
 */
function handleGetStoragePage(message, sendResponse) {
  const m = /** @type {{ storageType?: string; key?: string }} */ (message);
  const useSession = m.storageType === "session";
  const t = useSession ? sessionStorage : localStorage;
  const key = typeof m.key === "string" ? m.key : undefined;
  /** @type {Record<string, string>} */
  const data = {};
  try {
    if (key) {
      const v = t.getItem(key);
      if (v !== null) data[key] = v;
    } else {
      for (let i = 0; i < t.length; i += 1) {
        const k = t.key(i);
        if (k) data[k] = t.getItem(k) ?? "";
      }
    }
    sendResponse({ data, count: Object.keys(data).length });
  } catch (err) {
    sendResponse({ data: {}, count: 0, error: String(err) });
  }
}

/**
 * @param {unknown} message
 * @param {(r: unknown) => void} sendResponse
 */
function handleSetStoragePage(message, sendResponse) {
  const m = /** @type {{ storageType?: string; key?: string; value?: string }} */ (message);
  const useSession = m.storageType === "session";
  const t = useSession ? sessionStorage : localStorage;
  const key = typeof m.key === "string" ? m.key : "";
  const value = typeof m.value === "string" ? m.value : "";
  if (!key) {
    sendResponse({ success: false });
    return;
  }
  try {
    t.setItem(key, value);
    sendResponse({ success: true });
  } catch (err) {
    sendResponse({ success: false, error: String(err) });
  }
}

function handleReadPage(message, sendResponse) {
  const m = /** @type {{ format?: string }} */ (message);
  const format =
    m.format === "markdown" || m.format === "text" || m.format === "structured" ? m.format : "structured";
  const root = getReadPageRoot();
  const title = document.title || "";
  const url = location.href;

  if (format === "text") {
    const clone = /** @type {HTMLElement} */ (root.cloneNode(true));
    stripNoise(clone);
    const text = (clone.innerText || "").trim().replace(/\s+/g, " ");
    sendResponse({ text, url, title, wordCount: wordCountFrom(text) });
    return;
  }

  if (format === "markdown") {
    const clone = /** @type {HTMLElement} */ (root.cloneNode(true));
    stripNoise(clone);
    const markdown = elementToMarkdown(clone).trim();
    sendResponse({ markdown, url, title, wordCount: wordCountFrom(markdown) });
    return;
  }

  const structured = readStructured(root);
  const wc = wordCountFrom(structured.mainText);
  sendResponse({ ...structured, wordCount: wc });
}

/** @type {Record<string, (message: unknown, sendResponse: (r: unknown) => void) => void>} */
const MESSAGE_HANDLERS = {
  POKE_CLICK_ELEMENT: handleClickElement,
  POKE_TYPE_TEXT: handleTypeText,
  POKE_SCROLL_WINDOW: handleScrollWindow,
  POKE_EVAL: handleEval,
  POKE_GET_DOM_SNAPSHOT: handleGetDomSnapshot,
  POKE_GET_A11Y_TREE: handleGetAccessibilityTree,
  POKE_FIND_ELEMENT: handleFindElement,
  POKE_READ_PAGE: handleReadPage,
  POKE_WAIT_FOR_SELECTOR: handleWaitForSelector,
  POKE_GET_CONSOLE_LOGS: handleGetConsoleLogs,
  POKE_CLEAR_CONSOLE_LOGS: handleClearConsoleLogs,
  POKE_GET_PAGE_ERRORS: handleGetPageErrors,
  POKE_GET_SCROLL_INFO: handleGetScrollInfo,
  POKE_SCROLL_TO: handleScrollTo,
  POKE_HOVER_ELEMENT: handleHoverElement,
  POKE_SCRIPT_INJECT: handleScriptInject,
  POKE_FILL_FORM: handleFillForm,
  POKE_GET_STORAGE: handleGetStoragePage,
  POKE_SET_STORAGE: handleSetStoragePage,
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
