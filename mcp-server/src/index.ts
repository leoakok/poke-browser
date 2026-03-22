import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { bridge, readPort, startExtensionWebSocketServer } from "./transport.js";
import { registerTools } from "./tools.js";

const WS_PORT = readPort();
startExtensionWebSocketServer(WS_PORT, bridge);

const mcp = new McpServer({
  name: "poke-browser-mcp",
  version: "0.0.1",
});

registerTools(mcp);

const transport = new StdioServerTransport();
await mcp.connect(transport);
console.error("[poke-browser-mcp] MCP stdio transport connected (ready for MCP clients)");
