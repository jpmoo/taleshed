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
import { checkOllamaReachable } from "./ollama.js";

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
const DEBUG = process.env["TALESHED_DEBUG"] === "1" || process.env["TALESHED_DEBUG"] === "true";
function logRequest(method: string, url: string, req?: import("node:http").IncomingMessage & { headers?: Record<string, string | string[] | undefined> }) {
  let line = `[${new Date().toISOString()}] ${method} ${url}\n`;
  if (DEBUG && req?.headers) {
    const host = req.headers.host ?? "(none)";
    const auth = req.headers.authorization ? "present" : "(none)";
    line += `  Host: ${host}  Authorization: ${auth}\n`;
  }
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
if (DEBUG) {
  process.stderr.write(`[TaleShed] DEBUG=1: logging Claude request bodies and Ollama prompts/responses to ${ERROR_LOG}\n`);
  try {
    appendLog(ERROR_LOG, `[${new Date().toISOString()}] DEBUG logging enabled (Claude bodies + Ollama prompts/responses)\n`);
  } catch (_) {}
  checkOllamaReachable().then((ok) => {
    const msg = ok ? "Ollama connection: OK" : "Ollama connection: FAILED (unreachable)";
    process.stderr.write(`[TaleShed] ${msg}\n`);
    try {
      appendLog(ERROR_LOG, `[${new Date().toISOString()}] [DEBUG] ${msg}\n`);
    } catch (_) {}
  });
}

const PORT = Number(process.env["TALESHED_PORT"] ?? process.env["PORT"] ?? 3000);
const HOST = process.env["TALESHED_HOST"] ?? "0.0.0.0";

const dbPath = getDbPath();
const db = initDatabase(dbPath);

// Stateless: new server + transport per request so reconnect always gets a fresh initialize (no "Server already initialized").

// Host header validation: when behind a proxy (e.g. Tailscale/Caddy), Host is the public hostname.
// Set TALESHED_ALLOWED_HOSTS=localhost,127.0.0.1,your-public-hostname (comma-separated).
// If unset and binding 0.0.0.0, we don't restrict Host so the public URL works.
const allowedHostsEnv = process.env["TALESHED_ALLOWED_HOSTS"];
const allowedHosts = allowedHostsEnv
  ? allowedHostsEnv.split(",").map((s) => s.trim()).filter(Boolean)
  : HOST === "0.0.0.0"
    ? undefined
    : ["localhost", "127.0.0.1"];

const app = createMcpExpressApp({
  host: HOST,
  ...(allowedHosts && allowedHosts.length > 0 && { allowedHosts }),
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
  // MCP transport requires Accept to include both application/json and text/event-stream.
  // The SDK's adapter reads from rawHeaders (not req.headers), so we must patch rawHeaders.
  const accept = req.headers?.accept;
  const needBoth = !accept?.includes("application/json") || !accept?.includes("text/event-stream");
  if (needBoth) {
    const want = "application/json, text/event-stream";
    if (req.headers) req.headers.accept = want;
    const raw = (req as import("node:http").IncomingMessage & { rawHeaders?: string[] }).rawHeaders;
    if (raw && Array.isArray(raw)) {
      const i = raw.findIndex((h) => h.toLowerCase() === "accept");
      if (i >= 0 && i + 1 < raw.length) raw[i + 1] = want;
      else raw.push("Accept", want);
    }
  }
  next();
});

const handleMcp = async (req: import("node:http").IncomingMessage & { body?: unknown; method?: string; url?: string; headers?: Record<string, string | string[] | undefined> }, res: import("node:http").ServerResponse) => {
  logRequest(req.method ?? "?", req.url ?? "/", req);
  if (DEBUG && req.body !== undefined) {
    const bodyStr = typeof req.body === "string" ? req.body : JSON.stringify(req.body, null, 2);
    const maxLen = 15000;
    const truncated = bodyStr.length > maxLen ? bodyStr.slice(0, maxLen) + "\n... [truncated]\n" : bodyStr;
    try {
      appendLog(ERROR_LOG, `[DEBUG] Claude request body:\n${truncated}\n`);
    } catch {
      try {
        appendLog("/tmp/taleshed-errors.log", `[DEBUG] Claude request body:\n${truncated}\n`);
      } catch (_) {}
    }
  }
  if (DEBUG) {
    res.on("finish", () => {
      try {
        appendLog(ERROR_LOG, `  -> ${res.statusCode}\n`);
      } catch {
        try {
          appendLog("/tmp/taleshed-errors.log", `  -> ${res.statusCode}\n`);
        } catch (_) {}
      }
    });
  }
  const server = createTaleshedServer(db);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  transport.onerror = (err) => logError("transport.onerror:", err);
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    logError("MCP request error:", err);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error", message: err instanceof Error ? err.message : String(err) }));
    }
  } finally {
    const cleanup = () => {
      transport.close();
      server.close();
    };
    res.once("finish", cleanup);
    res.once("close", cleanup);
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
  if (allowedHosts?.length) {
    process.stderr.write(`  Allowed Host headers: ${allowedHosts.join(", ")}\n`);
  } else {
    process.stderr.write(`  Allowed Host headers: any (no validation)\n`);
  }
});

process.on("SIGINT", () => {
  httpServer.close();
  process.exit(0);
});
