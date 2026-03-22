#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const transport = new StdioClientTransport({
  command: "node",
  args: ["./cli.mjs"],
  cwd: root,
  stderr: "inherit",
});

const client = new Client({ name: "medium-screenshot-runner", version: "1.0.0" });
await client.connect(transport);

/** Wait for extension WebSocket (e.g. after MCP process restart). */
for (let i = 0; i < 40; i += 1) {
  const probe = await client.callTool({
    name: "managetabs",
    arguments: { action: "list" },
  });
  const txt = probe.content?.find((c) => c.type === "text")?.text ?? "";
  if (!probe.isError && !txt.includes("not connected")) break;
  await new Promise((r) => setTimeout(r, 500));
}

const nav = await client.callTool({
  name: "navigate_to",
  arguments: { url: "https://medium.com", waitForLoad: true },
});
const navText = nav.content?.find((c) => c.type === "text")?.text;
console.error("navigate_to:", navText ?? JSON.stringify(nav));

const shot = await client.callTool({
  name: "capture_screenshot",
  arguments: { format: "png" },
});

const img = shot.content?.find((c) => c.type === "image");
if (!img?.data) {
  console.error("capture_screenshot failed:", JSON.stringify(shot, null, 2));
  await client.close();
  process.exit(1);
}

const out = "/tmp/medium-screenshot.png";
writeFileSync(out, Buffer.from(img.data, "base64"));
console.error("wrote", out, "bytes", Buffer.from(img.data, "base64").length);

await client.close();
console.log(out);
