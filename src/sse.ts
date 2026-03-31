#!/usr/bin/env node
/**
 * TaleShed MCP Server — legacy SSE transport.
 * Run with: npm run start:sse
 * Endpoints: GET /sse (establish stream), POST /messages?sessionId=... (send messages).
 * Use when your client only supports HTTP+SSE or Streamable HTTP is unreliable.
 */

import "dotenv/config";
import { createMcpExpressApp, SSEServerTransport } from "./sdk-shim.js";
import { initDatabase, getDbPath } from "./db/schema.js";
import { createTaleshedServer } from "./app.js";

const PORT = Number(process.env["TALESHED_PORT"] ?? process.env["PORT"] ?? 3000);
const HOST = process.env["TALESHED_HOST"] ?? "0.0.0.0";

const dbPath = getDbPath();
const db = initDatabase(dbPath);

const sessions = new Map<string, { transport: SSEServerTransport }>();

const app = createMcpExpressApp({
  host: HOST,
  ...(HOST === "0.0.0.0" && { allowedHosts: ["localhost", "127.0.0.1"] }),
});

app.get("/sse", async (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => {
  const transport = new SSEServerTransport("/messages", res);
  const sessionId = transport.sessionId;

  transport.onclose = () => sessions.delete(sessionId);

  const server = createTaleshedServer(db);
  await server.connect(transport);
  await transport.start();

  sessions.set(sessionId, { transport });
});

app.post("/messages", async (req: import("node:http").IncomingMessage & { body?: unknown }, res: import("node:http").ServerResponse) => {
  const url = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Missing sessionId query parameter" }));
    return;
  }
  const entry = sessions.get(sessionId);
  if (!entry) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Unknown session. Reconnect to GET /sse first." }));
    return;
  }
  await entry.transport.handlePostMessage(req, res, req.body);
});

const httpServer = app.listen(PORT, HOST, () => {
  const base = `http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`;
  process.stderr.write(`TaleShed MCP server (SSE) listening at ${base}\n`);
  process.stderr.write(`  GET  ${base}/sse      — establish SSE stream (client then POSTs to /messages?sessionId=...)\n`);
  process.stderr.write(`  POST ${base}/messages?sessionId=<id> — send messages\n`);
  process.stderr.write(`  Database: ${dbPath}\n`);
});

process.on("SIGINT", () => {
  httpServer.close();
  process.exit(0);
});
