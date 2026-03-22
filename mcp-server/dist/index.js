import { main } from "./run.js";
main().catch((err) => {
    console.error("[poke-browser-mcp] Fatal startup error:", err);
    process.exit(1);
});
//# sourceMappingURL=index.js.map