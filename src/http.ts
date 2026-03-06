#!/usr/bin/env node
/**
 * TaleShed MCP Server — HTTP (Streamable HTTP) transport.
 * Run with: npm run start:http
 * Claude and other remote clients connect via URL, e.g. http://localhost:3000/mcp
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createMcpExpressApp, StreamableHTTPServerTransport } from "./sdk-shim.js";
import { initDatabase, getDbPath } from "./db/schema.js";
import { createTaleshedServer } from "./app.js";

// Log next to project root (parent of dist/), not cwd, so it works from systemd/any cwd
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
let ERROR_LOG = path.join(PROJECT_ROOT, "taleshed-errors.log");

function appendLog(logPath: string, line: string) {
  fs.appendFileSync(logPath, line);
}
function logError(label: string, err: unknown) {
  const line = `[${new Date().toISOString()}] ${label} ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`;
  try {
    appendLog(ERROR_LOG, line);
  } catch {
    try {
      appendLog("/tmp/taleshed-errors.log", line);
    } catch (_) {}
  }
  console.error("[TaleShed]", label, err);
}
function logRequest(method: string, url: string) {
  const line = `[${new Date().toISOString()}] ${method} ${url}\n`;
  try {
    appendLog(ERROR_LOG, line);
  } catch {
    try {
      appendLog("/tmp/taleshed-errors.log", line);
    } catch (_) {}
  }
}

// Create log file at startup; fall back to /tmp if project dir not writable
const startupLine = `[${new Date().toISOString()}] TaleShed started (project=${PROJECT_ROOT}, log=${ERROR_LOG}, cwd=${process.cwd()})\n`;
try {
  appendLog(ERROR_LOG, startupLine);
} catch {
  ERROR_LOG = "/tmp/taleshed-errors.log";
  try {
    appendLog(ERROR_LOG, startupLine);
  } catch (_) {}
}
process.stderr.write(`[TaleShed] Log file: ${ERROR_LOG}\n`);

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
