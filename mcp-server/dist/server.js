import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools.js";
const SERVER_VERSION = "0.1.0";
const MCP_SERVER_NAME = process.env.POKE_BROWSER_MCP_SERVER_NAME?.trim() || "poke-browser-mcp";
export function createPokeBrowserMcpServer() {
    const mcp = new McpServer({
        name: MCP_SERVER_NAME,
        version: SERVER_VERSION,
    });
    registerTools(mcp);
    return mcp;
}
//# sourceMappingURL=server.js.map