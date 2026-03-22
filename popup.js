const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const portInput = document.getElementById("port");
const applyPort = document.getElementById("applyPort");
const reconnectBtn = document.getElementById("reconnect");
const tokenInput = document.getElementById("token");
const applyToken = document.getElementById("applyToken");
const logEl = document.getElementById("log");

function formatTime(ts) {
  try {
    return new Date(ts).toLocaleTimeString();
  } catch {
    return String(ts);
  }
}

function renderLog(entries) {
  if (!logEl) return;
  if (!entries || entries.length === 0) {
    logEl.textContent = "No events yet.";
    return;
  }
  logEl.textContent = entries
    .map((e) => {
      const arrow = e.direction === "in" ? "←" : "→";
      return `[${formatTime(e.ts)}] ${arrow} ${e.summary}`;
    })
    .join("\n");
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

async function refresh() {
  const state = await chrome.runtime.sendMessage({ type: "POKE_GET_STATE" });
  if (state && portInput) {
    portInput.value = String(state.port ?? "");
  }
  if (state && tokenInput && typeof state.hasAuthToken === "boolean") {
    tokenInput.placeholder = state.hasAuthToken ? "•••••• (saved — type to replace)" : "Paste token from MCP stderr";
  }
  if (state) {
    applyStatus(state.status);
    renderLog(state.log);
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "POKE_STATUS" || msg?.type === "POKE_LOG_UPDATE") {
    refresh();
  }
});

applyPort?.addEventListener("click", async () => {
  const raw = portInput?.value ?? "";
  const port = Number(raw);
  const res = await chrome.runtime.sendMessage({ type: "POKE_SET_PORT", port });
  if (res && !res.ok) {
    applyStatus("disconnected");
    if (logEl) logEl.textContent = res.error || "Invalid port";
    return;
  }
  await refresh();
});

reconnectBtn?.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "POKE_RECONNECT" });
  await refresh();
});

applyToken?.addEventListener("click", async () => {
  const token = tokenInput?.value ?? "";
  const res = await chrome.runtime.sendMessage({ type: "POKE_SET_TOKEN", token });
  if (res && !res.ok && logEl) {
    logEl.textContent = "Could not save token.";
    return;
  }
  if (tokenInput) tokenInput.value = "";
  await refresh();
});

refresh();
