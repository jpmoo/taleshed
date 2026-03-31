#!/usr/bin/env node
/**
 * TaleShed MCP Server — Stdio transport (local process).
 * For URL-based access use: npm run start:http
 */

import "dotenv/config";
import { StdioServerTransport } from "./sdk-shim.js";
import { initDatabase, getDbPath } from "./db/schema.js";
import { createTaleshedServer } from "./app.js";

const dbPath = getDbPath();
const db = initDatabase(dbPath);

const server = createTaleshedServer(db);
const transport = new StdioServerTransport();
await server.connect(transport);

process.stderr.write(`TaleShed MCP server (stdio) running, database: ${dbPath}\n`);
