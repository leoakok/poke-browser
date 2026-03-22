import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools.js";
const SERVER_VERSION = "0.1.0";
export function createPokeBrowserMcpServer() {
    const mcp = new McpServer({
        name: "poke-browser-mcp",
        version: SERVER_VERSION,
    });
    registerTools(mcp);
    return mcp;
}
//# sourceMappingURL=server.js.map