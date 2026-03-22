/**
 * Dynamically registered content script: re-injects persisted page scripts on each navigation.
 * Entries live in chrome.storage.local under pokePersistentInjections.
 */

/**
 * @param {string} href
 * @param {string} pattern
 */
function matchUrl(href, pattern) {
  if (!pattern || pattern === "<all_urls>") return true;
  try {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`).test(href);
  } catch {
    return false;
  }
}

/**
 * @param {string} code
 */
function injectMainWorld(code) {
  const s = document.createElement("script");
  s.textContent = code;
  const root = document.documentElement || document.head || document.body;
  if (!root) return;
  root.appendChild(s);
  s.remove();
}

/**
 * @param {{ script: string; runAt?: string }} entry
 */
function scheduleInject(entry) {
  const code = entry.script;
  const runAt = entry.runAt === "document_end" || entry.runAt === "document_idle" ? entry.runAt : "document_start";
  const run = () => {
    try {
      injectMainWorld(code);
    } catch {
      /* ignore */
    }
  };
  if (runAt === "document_start") {
    run();
    return;
  }
  if (runAt === "document_end") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", run, { once: true });
    } else {
      run();
    }
    return;
  }
  if (document.readyState === "complete") {
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(() => run());
    } else {
      setTimeout(run, 0);
    }
  } else {
    window.addEventListener(
      "load",
      () => {
        if (typeof requestIdleCallback === "function") {
          requestIdleCallback(() => run());
        } else {
          setTimeout(run, 0);
        }
      },
      { once: true },
    );
  }
}

(async () => {
  try {
    const got = await chrome.storage.local.get("pokePersistentInjections");
    const list = Array.isArray(got.pokePersistentInjections) ? got.pokePersistentInjections : [];
    const href = location.href;
    for (const entry of list) {
      if (!entry || typeof entry.script !== "string" || !entry.matchPattern) continue;
      if (!matchUrl(href, entry.matchPattern)) continue;
      scheduleInject(entry);
    }
  } catch {
    /* ignore */
  }
})();
