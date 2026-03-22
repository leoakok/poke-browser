// All server logs MUST go to stderr - stdout is reserved for MCP JSON-RPC
import { log } from "./logger.js";
import { main } from "./run.js";

main().catch((err: unknown) => {
  log("[poke-browser-mcp] Fatal startup error:", err);
  process.exit(1);
});
