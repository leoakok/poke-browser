/**
 * All server logs MUST go to stderr — stdout is reserved for MCP JSON-RPC over stdio.
 * Quiet mode (default): only logError / logNotice print. Verbose: set POKE_BROWSER_VERBOSE=1
 * (CLI --debug / --verbose).
 */
export function isVerbose() {
    return process.env.POKE_BROWSER_VERBOSE === "1";
}
/** Verbose / debug logging only (--debug / --verbose). */
export function log(...args) {
    if (!isVerbose())
        return;
    console.error(...args);
}
/** Always printed (fatal errors, port bind failures, security rejects). */
export function logError(...args) {
    console.error(...args);
}
/** Short user-facing lines in quiet mode (e.g. tunnel URL, browser connected). */
export function logNotice(...args) {
    console.error(...args);
}
//# sourceMappingURL=logger.js.map