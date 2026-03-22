import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
export declare function toolText(data: unknown): CallToolResult;
export declare function toolError(text: string): CallToolResult;
export declare function registerTools(mcp: McpServer): void;
//# sourceMappingURL=tools.d.ts.map