/**
 * Re-export MCP server from SDK dist so TypeScript finds .d.ts (sibling of .js).
 * Runtime still uses package exports when this file is compiled to dist/.
 */
export { McpServer } from "../node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js";
export { StdioServerTransport } from "../node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js";
export { StreamableHTTPServerTransport } from "../node_modules/@modelcontextprotocol/sdk/dist/esm/server/streamableHttp.js";
export { SSEServerTransport } from "../node_modules/@modelcontextprotocol/sdk/dist/esm/server/sse.js";
export { createMcpExpressApp } from "../node_modules/@modelcontextprotocol/sdk/dist/esm/server/express.js";
