#!/usr/bin/env node
/**
 * TaleShed MCP Server — HTTP (Streamable HTTP) transport.
 * Run with: npm run start:http
 * Claude and other remote clients connect via URL, e.g. http://localhost:3000/mcp
 */

import fs from "fs";
import path from "path";
import { createMcpExpressApp, StreamableHTTPServerTransport } from "./sdk-shim.js";
import { initDatabase, getDbPath } from "./db/schema.js";
import { createTaleshedServer } from "./app.js";

const CWD = process.cwd();
const ERROR_LOG = path.join(CWD, "taleshed-errors.log");
function logError(label: string, err: unknown) {
  const line = `[${new Date().toISOString()}] ${label} ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`;
  fs.appendFileSync(ERROR_LOG, line);
  console.error("[TaleShed]", label, err);
}
function logRequest(method: string, url: string) {
  const line = `[${new Date().toISOString()}] ${method} ${url}\n`;
  fs.appendFileSync(ERROR_LOG, line);
}
// Create log file at startup so it exists and we know where we're logging
fs.appendFileSync(ERROR_LOG, `[${new Date().toISOString()}] TaleShed started (cwd=${CWD}, log=${ERROR_LOG})\n`);

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
app.use((req: import("node:http").IncomingMessage & { method?: string; headers?: Record<string, string | string[] | undefined> }, res: import("node:http").ServerResponse, next: () => void) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, mcp-session-id");
  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }
  // MCP transport returns 406 unless Accept includes text/event-stream; some clients send */* first
  const accept = req.headers?.accept;
  if (accept === "*/*" && req.headers) {
    req.headers.accept = "application/json, text/event-stream";
  }
  next();
});

const handleMcp = async (req: import("node:http").IncomingMessage & { body?: unknown; method?: string; url?: string }, res: import("node:http").ServerResponse) => {
  logRequest(req.method ?? "?", req.url ?? "/");
  try {
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    logError("MCP request error:", err);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error", message: err instanceof Error ? err.message : String(err) }));
    }
  }
};

process.on("uncaughtException", (err) => {
  logError("uncaughtException:", err);
});
process.on("unhandledRejection", (reason, promise) => {
  logError("unhandledRejection:", reason ?? promise);
});
// Streamable HTTP: GET (event stream) and POST (JSON-RPC)
// Also handle "/" so when a reverse proxy strips a prefix (e.g. /taleshed -> /), requests still work
app.get("/", handleMcp);
app.get("/mcp", handleMcp);
app.get("/mcp/sse", handleMcp);
app.post("/", handleMcp);
app.post("/mcp", handleMcp);
app.post("/mcp/sse", handleMcp);

const httpServer = app.listen(PORT, HOST, () => {
  const base = `http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`;
  process.stderr.write(`TaleShed MCP server (HTTP) listening at ${base}\n`);
  process.stderr.write(`  MCP endpoint: ${base}/mcp\n`);
  process.stderr.write(`  Database: ${dbPath}\n`);
  process.stderr.write(`  Request/error log: ${ERROR_LOG}\n`);
});

process.on("SIGINT", () => {
  httpServer.close();
  process.exit(0);
});
