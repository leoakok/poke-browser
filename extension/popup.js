const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const portUrlEl = document.getElementById("portUrl");
const mcpEnabled = document.getElementById("mcpEnabled");
const versionEl = document.getElementById("version");
const logsSection = document.getElementById("logsSection");
const logsToggle = document.getElementById("logsToggle");

const { version } = chrome.runtime.getManifest();

const DEFAULT_PORT = 9009;
const LOG_LIST_MAX = 50;

function normalizePort(value) {
  const n = Number(value);
  if (Number.isFinite(n) && n > 0 && n < 65536) return Math.trunc(n);
  return DEFAULT_PORT;
}

function applyStatus(status) {
  if (!statusDot || !statusText) return;
  statusDot.classList.remove("connected", "connecting", "disconnected");
  if (status === "connected") {
    statusDot.classList.add("connected");
    statusText.textContent = "Connected";
  } else if (status === "connecting") {
    statusDot.classList.add("connecting");
    statusText.textContent = "Connecting…";
  } else {
    statusDot.classList.add("disconnected");
    statusText.textContent = "Disconnected";
  }
}

function setPortDisplay(port) {
  if (portUrlEl) {
    portUrlEl.textContent = `ws://localhost:${port}`;
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

  const stored = await chrome.storage.local.get(["enabled", "port", "wsPort"]);
  const port =
    typeof stored.port === "number"
      ? normalizePort(stored.port)
      : normalizePort(stored.wsPort);
  setPortDisplay(port);

  const enabled = typeof stored.enabled === "boolean" ? stored.enabled : true;
  if (mcpEnabled) mcpEnabled.checked = enabled;

  await syncFromBackgroundStatus();
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

void load();
