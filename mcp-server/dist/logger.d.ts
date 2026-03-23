/**
 * All server logs MUST go to stderr — stdout is reserved for MCP JSON-RPC over stdio.
 * Quiet mode (default): only logError / logNotice print. Verbose: set POKE_BROWSER_VERBOSE=1
 * (CLI --debug / --verbose).
 */
export declare function isVerbose(): boolean;
/** Verbose / debug logging only (--debug / --verbose). */
export declare function log(...args: unknown[]): void;
/** Always printed (fatal errors, port bind failures, security rejects). */
export declare function logError(...args: unknown[]): void;
/** Short user-facing lines in quiet mode (e.g. tunnel URL, browser connected). */
export declare function logNotice(...args: unknown[]): void;
//# sourceMappingURL=logger.d.ts.map