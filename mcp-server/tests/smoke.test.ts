import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { WebSocket } from "ws";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = 9099;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.resolve(__dirname, "../dist/index.js");

let serverProcess: ChildProcess;

beforeAll(async () => {
  serverProcess = spawn("node", [SERVER_PATH], {
    env: {
      ...process.env,
      POKE_BROWSER_WS_PORT: String(PORT),
      POKE_BROWSER_TOKEN: "test-token",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Drain MCP JSON-RPC on stdout so the pipe buffer never blocks the server.
  serverProcess.stdout?.on("data", () => {});

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Server start timeout")), 8000);
    const onData = (data: Buffer): void => {
      if (data.toString().includes("listening")) {
        clearTimeout(timeout);
        serverProcess.stderr?.off("data", onData);
        resolve();
      }
    };
    serverProcess.stderr?.on("data", onData);
    serverProcess.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}, 20_000);

afterAll(() => {
  serverProcess?.kill("SIGTERM");
});

function connectWs(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function sendAndReceive(ws: WebSocket, msg: object): Promise<object> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Response timeout")), 5000);
    ws.once("message", (data) => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(data.toString()) as object);
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
    ws.send(JSON.stringify(msg));
  });
}

// One authenticated client replaces another; run tests one at a time.
describe.sequential("poke-browser MCP server", () => {
  afterEach(async () => {
    await new Promise((r) => setTimeout(r, 200));
  });

  it("accepts connections and sends welcome", async () => {
    const ws = await connectWs();
    expect(ws.readyState).toBe(WebSocket.OPEN);
    const welcome = await new Promise<object>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("welcome timeout")), 5000);
      ws.once("message", (data) => {
        clearTimeout(t);
        resolve(JSON.parse(data.toString()) as object);
      });
    });
    expect(welcome).toMatchObject({ type: "welcome" });
    ws.close();
  });

  it("rejects hello with wrong token", async () => {
    const ws = await connectWs();
    await new Promise<void>((resolve) => {
      ws.once("message", () => resolve());
    });
    const response = await sendAndReceive(ws, {
      type: "hello",
      token: "wrong-token",
      requestId: "r1",
    });
    expect(
      (response as { error?: string; type?: string }).error ??
        (response as { error?: string; type?: string }).type,
    ).toBeTruthy();
    await new Promise<void>((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) resolve();
      else ws.once("close", () => resolve());
    });
  });

  it("accepts hello with correct token", async () => {
    const ws = await connectWs();
    await new Promise<void>((resolve) => {
      ws.once("message", () => resolve());
    });
    const response = await sendAndReceive(ws, {
      type: "hello",
      token: "test-token",
      requestId: "r2",
    });
    expect(response).toMatchObject({ type: "auth_ok" });
    expect((response as { error?: string }).error).toBeUndefined();
    ws.close();
  });
});
