import { main } from "./run.js";

main().catch((err: unknown) => {
  console.error("[poke-browser-mcp] Fatal startup error:", err);
  process.exit(1);
});
