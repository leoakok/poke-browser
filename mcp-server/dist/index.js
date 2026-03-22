// All server logs MUST go to stderr - stdout is reserved for MCP JSON-RPC.
// Each MCP tool call is logged to stderr from `registerTools()` in tools.ts.
import { log } from "./logger.js";
import { main } from "./run.js";
main().catch((err) => {
    log("[poke-browser-mcp] Fatal startup error:", err);
    process.exit(1);
});
//# sourceMappingURL=index.js.map