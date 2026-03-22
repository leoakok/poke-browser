/**
 * All server logs MUST go to stderr — stdout is reserved for MCP JSON-RPC over stdio.
 */
export function log(...args: unknown[]): void {
  console.error(...args);
}
