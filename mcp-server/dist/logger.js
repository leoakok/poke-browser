/**
 * All server logs MUST go to stderr — stdout is reserved for MCP JSON-RPC over stdio.
 */
export function log(...args) {
    console.error(...args);
}
//# sourceMappingURL=logger.js.map