/**
 * All server logs MUST go to stderr — stdout is reserved for MCP JSON-RPC over stdio.
 * Quiet mode (default): only logError / logNotice print. Verbose: set POKE_BROWSER_VERBOSE=1
 * (CLI --debug / --verbose).
 */
export function isVerbose(): boolean {
  return process.env.POKE_BROWSER_VERBOSE === "1";
}

/** Verbose / debug logging only (--debug / --verbose). */
export function log(...args: unknown[]): void {
  if (!isVerbose()) return;
  console.error(...args);
}

/** Always printed (fatal errors, port bind failures, security rejects). */
export function logError(...args: unknown[]): void {
  console.error(...args);
}

/** Short user-facing lines in quiet mode (e.g. tunnel URL, browser connected). */
export function logNotice(...args: unknown[]): void {
  console.error(...args);
}
