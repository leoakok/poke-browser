const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const urlDisplay = document.getElementById("url-display");
const urlEditBtn = document.getElementById("url-edit-btn");
const urlInput = document.getElementById("url-input");
const urlOkBtn = document.getElementById("url-ok-btn");
const urlCancelBtn = document.getElementById("url-cancel-btn");
const mcpEnabled = document.getElementById("mcpEnabled");
const versionEl = document.getElementById("version");
const logsSection = document.getElementById("logsSection");
const logsToggle = document.getElementById("logsToggle");
const disconnectedHint = document.getElementById("disconnected-hint");
const apiKeyInput = document.getElementById("api-key-input");
const saveApiKeyBtn = document.getElementById("save-api-key-btn");
const clearApiKeyBtn = document.getElementById("clear-api-key-btn");
const apiKeyStatus = document.getElementById("api-key-status");
const pokeMessageInput = document.getElementById("poke-message-input");
const sendPokeMessageBtn = document.getElementById("send-poke-message-btn");
const pokeSendStatus = document.getElementById("poke-send-status");

const { version } = chrome.runtime.getManifest();

const DEFAULT_PORT = 9009;
const LOG_LIST_MAX = 50;

function checkForUpdates() {
  const currentVersion = chrome.runtime.getManifest().version;
  fetch("https://registry.npmjs.org/poke-browser/latest", {
    signal: AbortSignal.timeout(5000),
  })
    .then((r) => r.json())
    .then((data) => {
      const latestVersion = data.version;
      if (latestVersion && latestVersion !== currentVersion) {
        const updateEl = document.getElementById("update-notice");
        if (updateEl) {
          updateEl.textContent =
            "⚡ v" +
            latestVersion +
            " available — npx poke-browser@latest";
          updateEl.style.display = "block";
        }
      }
    })
    .catch(() => {});
}

function normalizePort(value) {
  const n = Number(value);
  if (Number.isFinite(n) && n > 0 && n < 65536) return Math.trunc(n);
  return DEFAULT_PORT;
}

/**
 * @param {{ port?: unknown; wsPort?: unknown; wsUrl?: unknown }} stored
 */
function resolvedWsUrlString(stored) {
  if (typeof stored.wsUrl === "string" && stored.wsUrl.trim()) {
    return stored.wsUrl.trim();
  }
  const port =
    typeof stored.port === "number"
      ? normalizePort(stored.port)
      : normalizePort(stored.wsPort);
  return `ws://localhost:${port}`;
}

function enterEditMode() {
  if (!urlDisplay || !urlEditBtn || !urlInput || !urlOkBtn || !urlCancelBtn) return;
  urlDisplay.classList.add("hidden");
  urlEditBtn.classList.add("hidden");
  urlInput.classList.remove("hidden");
  urlOkBtn.classList.remove("hidden");
  urlCancelBtn.classList.remove("hidden");
  urlInput.value = urlDisplay.textContent ?? "";
  urlInput.focus();
  urlInput.select();
}

function exitEditMode() {
  if (!urlDisplay || !urlEditBtn || !urlInput || !urlOkBtn || !urlCancelBtn) return;
  urlDisplay.classList.remove("hidden");
  urlEditBtn.classList.remove("hidden");
  urlInput.classList.add("hidden");
  urlOkBtn.classList.add("hidden");
  urlCancelBtn.classList.add("hidden");
}

async function saveUrlFromInput() {
  if (!urlInput || !urlDisplay) return;
  const newUrl = urlInput.value.trim();
  if (!newUrl) return;
  await chrome.storage.local.set({ wsUrl: newUrl });
  urlDisplay.textContent = newUrl;
  exitEditMode();
  try {
    await chrome.runtime.sendMessage({ action: "reconnect", wsUrl: newUrl });
  } catch {
    /* extension invalidated */
  }
  await syncFromBackgroundStatus();
}

function applyStatus(status) {
  if (!statusDot || !statusText) return;
  statusDot.classList.remove("connected", "connecting", "disconnected");
  if (status === "connected") {
    statusDot.classList.add("connected");
    statusText.textContent = "Connected";
    disconnectedHint?.classList.add("hidden");
  } else if (status === "connecting") {
    statusDot.classList.add("connecting");
    statusText.textContent = "Connecting…";
    disconnectedHint?.classList.add("hidden");
  } else {
    statusDot.classList.add("disconnected");
    statusText.textContent = "Disconnected";
    disconnectedHint?.classList.remove("hidden");
  }
}

async function syncFromBackgroundStatus() {
  try {
    const state = await chrome.runtime.sendMessage({ type: "POKE_GET_STATE" });
    if (state && typeof state.status === "string") {
      applyStatus(state.status);
    }
  } catch {
    applyStatus("disconnected");
  }
}

function prependLogLine(text) {
  const list = document.getElementById("log-list");
  if (!list) return;
  const line = document.createElement("div");
  line.className = "log-line";
  line.textContent = text;
  list.insertBefore(line, list.firstChild);
  while (list.children.length > LOG_LIST_MAX) {
    list.removeChild(list.lastChild);
  }
}

async function load() {
  if (versionEl) {
    versionEl.textContent = `v${version}`;
  }

  const stored = await chrome.storage.local.get(["enabled", "port", "wsPort", "wsUrl"]);
  if (urlDisplay) {
    urlDisplay.textContent = resolvedWsUrlString(stored);
  }

  const enabled = typeof stored.enabled === "boolean" ? stored.enabled : true;
  if (mcpEnabled) mcpEnabled.checked = enabled;

  await syncFromBackgroundStatus();

  try {
    const keyState = await chrome.runtime.sendMessage({ type: "POKE_GET_API_KEY_STATE" });
    if (keyState?.hasApiKey) {
      if (apiKeyStatus) apiKeyStatus.textContent = "API key saved.";
      if (apiKeyInput) apiKeyInput.placeholder = "Saved (enter a new key to replace)";
    } else if (apiKeyStatus) {
      apiKeyStatus.textContent = "No API key saved.";
    }
  } catch {
    if (apiKeyStatus) apiKeyStatus.textContent = "Could not read API key state.";
  }
}

async function saveApiKey() {
  const key = apiKeyInput?.value?.trim() ?? "";
  if (!key) {
    if (apiKeyStatus) apiKeyStatus.textContent = "Enter an API key first.";
    return;
  }
  if (apiKeyStatus) apiKeyStatus.textContent = "Saving...";
  try {
    const res = await chrome.runtime.sendMessage({ type: "POKE_SET_API_KEY", apiKey: key });
    if (res?.ok) {
      if (apiKeyInput) apiKeyInput.value = "";
      if (apiKeyStatus) apiKeyStatus.textContent = "API key saved.";
    } else if (apiKeyStatus) {
      apiKeyStatus.textContent = "Failed to save API key.";
    }
  } catch {
    if (apiKeyStatus) apiKeyStatus.textContent = "Failed to save API key.";
  }
}

async function clearApiKey() {
  if (apiKeyStatus) apiKeyStatus.textContent = "Clearing...";
  try {
    const res = await chrome.runtime.sendMessage({ type: "POKE_SET_API_KEY", apiKey: "" });
    if (res?.ok) {
      if (apiKeyInput) apiKeyInput.value = "";
      if (apiKeyStatus) apiKeyStatus.textContent = "API key cleared.";
    } else if (apiKeyStatus) {
      apiKeyStatus.textContent = "Failed to clear API key.";
    }
  } catch {
    if (apiKeyStatus) apiKeyStatus.textContent = "Failed to clear API key.";
  }
}

async function sendPokeMessage() {
  const message = pokeMessageInput?.value?.trim() ?? "";
  if (!message) {
    if (pokeSendStatus) pokeSendStatus.textContent = "Enter a message first.";
    return;
  }
  if (pokeSendStatus) pokeSendStatus.textContent = "Sending...";
  if (sendPokeMessageBtn) sendPokeMessageBtn.disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({ type: "POKE_SEND_MESSAGE", message });
    if (res?.ok) {
      if (pokeSendStatus) pokeSendStatus.textContent = "Message sent to Poke.";
      if (pokeMessageInput) pokeMessageInput.value = "";
    } else {
      if (pokeSendStatus) pokeSendStatus.textContent = res?.error ? String(res.error) : "Failed to send message.";
    }
  } catch {
    if (pokeSendStatus) pokeSendStatus.textContent = "Failed to send message.";
  } finally {
    if (sendPokeMessageBtn) sendPokeMessageBtn.disabled = false;
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "POKE_STATUS" && typeof msg.status === "string") {
    applyStatus(msg.status);
  }
  if (msg?.type === "POKE_LOG_UPDATE") {
    void syncFromBackgroundStatus();
  }
  if (msg?.type === "log" && typeof msg.message === "string") {
    prependLogLine(msg.message);
  }
});

logsToggle?.addEventListener("click", () => {
  const expanded = logsSection?.classList.toggle("expanded");
  logsToggle?.setAttribute("aria-expanded", expanded ? "true" : "false");
});

urlEditBtn?.addEventListener("click", () => {
  enterEditMode();
});

urlCancelBtn?.addEventListener("click", () => {
  exitEditMode();
});

urlOkBtn?.addEventListener("click", () => {
  void saveUrlFromInput();
});

urlInput?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    void saveUrlFromInput();
  } else if (e.key === "Escape") {
    e.preventDefault();
    exitEditMode();
  }
});

mcpEnabled?.addEventListener("change", async () => {
  const enabled = mcpEnabled.checked;
  await chrome.storage.local.set({ enabled });
  try {
    await chrome.runtime.sendMessage({ action: "setPokeBrowserEnabled", enabled });
  } catch {
    /* extension invalidated */
  }
  await syncFromBackgroundStatus();
});

saveApiKeyBtn?.addEventListener("click", () => {
  void saveApiKey();
});

clearApiKeyBtn?.addEventListener("click", () => {
  void clearApiKey();
});

apiKeyInput?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    void saveApiKey();
  }
});

sendPokeMessageBtn?.addEventListener("click", () => {
  void sendPokeMessage();
});

pokeMessageInput?.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    void sendPokeMessage();
  }
});

checkForUpdates();
void load();
