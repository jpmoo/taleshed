#!/usr/bin/env node
/**
 * TaleShed MCP Server — HTTP (Streamable HTTP) transport.
 * Run with: npm run start:http
 * Claude and other remote clients connect via URL, e.g. http://localhost:3000/mcp
 */

import { createMcpExpressApp, StreamableHTTPServerTransport } from "./sdk-shim.js";
import { initDatabase, getDbPath } from "./db/schema.js";
import { createTaleshedServer } from "./app.js";

const PORT = Number(process.env["TALESHED_PORT"] ?? process.env["PORT"] ?? 3000);
const HOST = process.env["TALESHED_HOST"] ?? "0.0.0.0";

const dbPath = getDbPath();
const db = initDatabase(dbPath);

const server = createTaleshedServer(db);
const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
await server.connect(transport);

const app = createMcpExpressApp({
  host: HOST,
  ...(HOST === "0.0.0.0" && { allowedHosts: ["localhost", "127.0.0.1"] }),
});

// CORS so browser-based MCP clients (e.g. Claude in browser) can connect
app.use((req: import("node:http").IncomingMessage & { method?: string }, res: import("node:http").ServerResponse, next: () => void) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, mcp-session-id");
  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }
  next();
});

const handleMcp = async (req: import("node:http").IncomingMessage & { body?: unknown }, res: import("node:http").ServerResponse) => {
  await transport.handleRequest(req, res, req.body);
};
// Streamable HTTP: GET (event stream) and POST (JSON-RPC); client may request /mcp or /mcp/sse
app.get("/mcp", handleMcp);
app.get("/mcp/sse", handleMcp);
app.post("/mcp", handleMcp);
app.post("/mcp/sse", handleMcp);

const httpServer = app.listen(PORT, HOST, () => {
  const base = `http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`;
  process.stderr.write(`TaleShed MCP server (HTTP) listening at ${base}\n`);
  process.stderr.write(`  MCP endpoint: ${base}/mcp\n`);
  process.stderr.write(`  Database: ${dbPath}\n`);
});

process.on("SIGINT", () => {
  httpServer.close();
  process.exit(0);
});
