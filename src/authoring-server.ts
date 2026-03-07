#!/usr/bin/env node
/**
 * TaleShed Authoring Web App — world graph editor.
 * Run with: npm run start:authoring
 * Requires .env: TALESHED_WEB_API_KEY. Optional: TALESHED_WEB_IP (default 0.0.0.0), TALESHED_WEB_PORT (default MCP port + 1).
 * Access: http://localhost:PORT/?api=YOUR_API_KEY
 */

import path from "path";
import { fileURLToPath } from "url";
import express, { Request, Response, NextFunction } from "express";
import { initDatabase, getDbPath } from "./db/schema.js";
import type { WorldNode } from "./db/schema.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const AUTHORING_DIR = path.join(PROJECT_ROOT, "authoring");

const apiKey = process.env["TALESHED_WEB_API_KEY"];
if (!apiKey || apiKey.length < 1) {
  console.error("TaleShed Authoring: set TALESHED_WEB_API_KEY in .env");
  process.exit(1);
}

const mcpPort = Number(process.env["TALESHED_PORT"] ?? process.env["PORT"] ?? 3000);
const PORT = Number(process.env["TALESHED_WEB_PORT"] ?? String(mcpPort + 1));
const HOST = process.env["TALESHED_WEB_IP"] ?? "0.0.0.0";

const dbPath = getDbPath();
const db = initDatabase(dbPath);

const DIRECTIONS = ["north", "south", "east", "west"] as const;
function oppositeDirection(d: string): string {
  const lower = (d || "").toLowerCase();
  if (lower === "north") return "south";
  if (lower === "south") return "north";
  if (lower === "east") return "west";
  if (lower === "west") return "east";
  return "";
}

type ExitRow = { label: string; target: string; direction: string };
function parseExitsJson(exits: string): ExitRow[] {
  try {
    const raw = typeof exits === "string" ? exits.trim() : "";
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((e): e is Record<string, unknown> => e != null && typeof e === "object")
      .map((e) => ({
        label: String(e.label ?? e.name ?? "").trim() || String(e.target ?? "").trim() || "(exit)",
        target: String(e.target ?? e.target_node_id ?? e.destination ?? "").trim(),
        direction: DIRECTIONS.includes((e.direction as string)?.toLowerCase() as (typeof DIRECTIONS)[number])
          ? (e.direction as string).toLowerCase()
          : "",
      }))
      .filter((e) => e.target && e.direction);
  } catch {
    return [];
  }
}

function exitsToJson(exits: ExitRow[]): string {
  return JSON.stringify(exits.map((e) => ({ label: e.label, target: e.target, direction: e.direction })));
}

/** Update target location's exits: add or remove the reverse exit. */
function syncReverseExit(
  fromNodeId: string,
  fromExits: ExitRow[],
  targetNodeId: string,
  reverseDirection: string,
  labelFromTargetSide: string,
  add: boolean
): void {
  const row = db.prepare("SELECT exits FROM world_graph WHERE node_id = ? AND is_active = 1").get(targetNodeId) as { exits: string } | undefined;
  if (!row) return;
  let targetExits = parseExitsJson(row.exits);
  if (add) {
    if (targetExits.some((e) => e.direction === reverseDirection)) return;
    targetExits = [...targetExits, { label: labelFromTargetSide, target: fromNodeId, direction: reverseDirection }];
  } else {
    targetExits = targetExits.filter((e) => !(e.target === fromNodeId && e.direction === reverseDirection));
  }
  db.prepare("UPDATE world_graph SET exits = ? WHERE node_id = ?").run(exitsToJson(targetExits), targetNodeId);
}

/** When deleting a node, remove any exits (from other locations) that target this node. */
function removeExitsTargetingNode(deletedNodeId: string): void {
  const locations = db.prepare("SELECT node_id, exits FROM world_graph WHERE node_type = 'location' AND is_active = 1").all() as { node_id: string; exits: string }[];
  for (const loc of locations) {
    const exits = parseExitsJson(loc.exits);
    const filtered = exits.filter((e) => e.target !== deletedNodeId);
    if (filtered.length !== exits.length) {
      db.prepare("UPDATE world_graph SET exits = ? WHERE node_id = ?").run(exitsToJson(filtered), loc.node_id);
    }
  }
}

function getApiKey(req: Request): string | null {
  const q = (req.query?.api as string) ?? null;
  const h = (req.headers["x-api-key"] as string) ?? null;
  return q ?? h ?? null;
}

function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const key = getApiKey(req);
  if (!key || key !== apiKey) {
    res.status(401).json({ error: "Missing or invalid API key. Use ?api=YOUR_KEY or X-API-Key header." });
    return;
  }
  next();
}

const app = express();
app.use(express.json());

// API routes require API key
app.use("/api", requireApiKey);

// All world_graph nodes (for grid + list)
app.get("/api/world-graph", (_req: Request, res: Response) => {
  try {
    const rows = db.prepare("SELECT * FROM world_graph ORDER BY node_type, node_id").all() as WorldNode[];
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// Single node
app.get("/api/world-graph/:node_id", (req: Request, res: Response) => {
  try {
    const row = db.prepare("SELECT * FROM world_graph WHERE node_id = ?").get(req.params.node_id) as WorldNode | undefined;
    if (!row) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// Update node
app.put("/api/world-graph/:node_id", (req: Request, res: Response) => {
  const nodeId = req.params.node_id;
  const body = req.body as Record<string, unknown>;
  if (!body || typeof body !== "object") {
    res.status(400).json({ error: "JSON body required" });
    return;
  }
  try {
    const existingRow = db.prepare("SELECT node_type, exits FROM world_graph WHERE node_id = ?").get(nodeId) as { node_type: string; exits: string } | undefined;
    if (!existingRow) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const node_type = (body.node_type as string) ?? "location";
    const name = (body.name as string) ?? "";
    const base_description = (body.base_description as string) ?? "";
    const adjectives = typeof body.adjectives === "string" ? body.adjectives : JSON.stringify(body.adjectives ?? []);
    const location_id = body.location_id != null ? String(body.location_id) : null;
    const is_active = body.is_active != null ? (body.is_active ? 1 : 0) : 1;
    const meta = body.meta != null ? String(body.meta) : null;
    let exits = typeof body.exits === "string" ? body.exits : JSON.stringify(body.exits ?? []);
    const grid_x = body.grid_x != null ? Number(body.grid_x) : null;
    const grid_y = body.grid_y != null ? Number(body.grid_y) : null;

    if (node_type === "location") {
      const oldExits = parseExitsJson(existingRow.exits);
      const newExits = parseExitsJson(exits);
      const oldByDir = new Map(oldExits.map((e) => [e.direction, e]));
      const newByDir = new Map(newExits.map((e) => [e.direction, e]));
      for (const e of oldExits) {
        if (!newByDir.has(e.direction)) {
          syncReverseExit(nodeId, newExits, e.target, oppositeDirection(e.direction), e.label, false);
        }
      }
      for (const e of newExits) {
        const old = oldByDir.get(e.direction);
        if (!old || old.target !== e.target) {
          if (old && old.target) syncReverseExit(nodeId, newExits, old.target, oppositeDirection(old.direction), old.label, false);
          syncReverseExit(nodeId, newExits, e.target, oppositeDirection(e.direction), e.label, true);
        }
      }
      exits = exitsToJson(newExits);
    } else {
      exits = "[]";
    }

    db.prepare(
      `UPDATE world_graph SET node_type = ?, name = ?, base_description = ?, adjectives = ?, location_id = ?, is_active = ?, meta = ?, exits = ?, grid_x = ?, grid_y = ? WHERE node_id = ?`
    ).run(node_type, name, base_description, adjectives, location_id, is_active, meta, exits, grid_x, grid_y, nodeId);
    const row = db.prepare("SELECT * FROM world_graph WHERE node_id = ?").get(nodeId) as WorldNode;
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// Create node
app.post("/api/world-graph", (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  if (!body || typeof body !== "object") {
    res.status(400).json({ error: "JSON body required" });
    return;
  }
  const node_id = (body.node_id as string)?.trim();
  if (!node_id) {
    res.status(400).json({ error: "node_id required" });
    return;
  }
  try {
    const existing = db.prepare("SELECT 1 FROM world_graph WHERE node_id = ?").get(node_id);
    if (existing) {
      res.status(409).json({ error: "node_id already exists" });
      return;
    }
    const node_type = (body.node_type as string) ?? "location";
    const name = (body.name as string) ?? node_id;
    const base_description = (body.base_description as string) ?? "";
    const adjectives = typeof body.adjectives === "string" ? body.adjectives : JSON.stringify(body.adjectives ?? []);
    const location_id = body.location_id != null ? String(body.location_id) : null;
    const is_active = body.is_active != null ? (body.is_active ? 1 : 0) : 1;
    const meta = body.meta != null ? String(body.meta) : null;
    const exits = typeof body.exits === "string" ? body.exits : JSON.stringify(body.exits ?? []);
    const grid_x = body.grid_x != null ? Number(body.grid_x) : null;
    const grid_y = body.grid_y != null ? Number(body.grid_y) : null;

    db.prepare(
      `INSERT INTO world_graph (node_id, node_type, name, base_description, adjectives, location_id, is_active, meta, exits, grid_x, grid_y)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(node_id, node_type, name, base_description, adjectives, location_id, is_active, meta, exits, grid_x, grid_y);
    if (node_type === "location") {
      const newExits = parseExitsJson(exits);
      for (const e of newExits) {
        syncReverseExit(node_id, newExits, e.target, oppositeDirection(e.direction), e.label, true);
      }
    }
    const row = db.prepare("SELECT * FROM world_graph WHERE node_id = ?").get(node_id) as WorldNode;
    res.status(201).json(row);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// Delete node
app.delete("/api/world-graph/:node_id", (req: Request, res: Response) => {
  const nodeId = req.params.node_id;
  try {
    removeExitsTargetingNode(nodeId);
    const result = db.prepare("DELETE FROM world_graph WHERE node_id = ?").run(nodeId);
    if (result.changes === 0) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.status(204).end();
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// --- History Ledger ---
type HistoryEntryRow = {
  entry_id: number;
  timestamp: string;
  action_description: string | null;
  node_id: string | null;
  prose_impact: string | null;
  adjectives_old: string | null;
  adjectives_new: string | null;
  system_event: string | null;
};

app.get("/api/history-ledger", (_req: Request, res: Response) => {
  try {
    const rows = db.prepare("SELECT * FROM history_ledger ORDER BY entry_id ASC").all() as HistoryEntryRow[];
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.get("/api/history-ledger/:entry_id", (req: Request, res: Response) => {
  try {
    const id = Number(req.params.entry_id);
    const row = db.prepare("SELECT * FROM history_ledger WHERE entry_id = ?").get(id) as HistoryEntryRow | undefined;
    if (!row) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.put("/api/history-ledger/:entry_id", (req: Request, res: Response) => {
  const entryId = Number(req.params.entry_id);
  const body = req.body as Record<string, unknown>;
  if (!body || typeof body !== "object") {
    res.status(400).json({ error: "JSON body required" });
    return;
  }
  try {
    const existing = db.prepare("SELECT 1 FROM history_ledger WHERE entry_id = ?").get(entryId);
    if (!existing) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const timestamp = (body.timestamp as string) ?? new Date().toISOString();
    const action_description = body.action_description != null ? String(body.action_description) : null;
    const node_id = body.node_id != null ? String(body.node_id) : null;
    const prose_impact = body.prose_impact != null ? String(body.prose_impact) : null;
    const adjectives_old = body.adjectives_old != null ? String(body.adjectives_old) : null;
    const adjectives_new = body.adjectives_new != null ? String(body.adjectives_new) : null;
    const system_event = body.system_event != null ? String(body.system_event) : null;
    db.prepare(
      `UPDATE history_ledger SET timestamp = ?, action_description = ?, node_id = ?, prose_impact = ?, adjectives_old = ?, adjectives_new = ?, system_event = ? WHERE entry_id = ?`
    ).run(timestamp, action_description, node_id, prose_impact, adjectives_old, adjectives_new, system_event, entryId);
    const row = db.prepare("SELECT * FROM history_ledger WHERE entry_id = ?").get(entryId) as HistoryEntryRow;
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.post("/api/history-ledger", (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  if (!body || typeof body !== "object") {
    res.status(400).json({ error: "JSON body required" });
    return;
  }
  try {
    const timestamp = (body.timestamp as string) ?? new Date().toISOString();
    const action_description = body.action_description != null ? String(body.action_description) : null;
    const node_id = body.node_id != null ? String(body.node_id) : null;
    const prose_impact = body.prose_impact != null ? String(body.prose_impact) : null;
    const adjectives_old = body.adjectives_old != null ? String(body.adjectives_old) : null;
    const adjectives_new = body.adjectives_new != null ? String(body.adjectives_new) : null;
    const system_event = body.system_event != null ? String(body.system_event) : null;
    const result = db.prepare(
      `INSERT INTO history_ledger (timestamp, action_description, node_id, prose_impact, adjectives_old, adjectives_new, system_event)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(timestamp, action_description, node_id, prose_impact, adjectives_old, adjectives_new, system_event);
    const id = result.lastInsertRowid as number;
    const row = db.prepare("SELECT * FROM history_ledger WHERE entry_id = ?").get(id) as HistoryEntryRow;
    res.status(201).json(row);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.delete("/api/history-ledger/:entry_id", (req: Request, res: Response) => {
  const entryId = Number(req.params.entry_id);
  try {
    const result = db.prepare("DELETE FROM history_ledger WHERE entry_id = ?").run(entryId);
    if (result.changes === 0) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.status(204).end();
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// --- Vocabulary ---
type VocabularyRow = { adjective: string; rule_description: string; is_starter: number };

app.get("/api/vocabulary", (_req: Request, res: Response) => {
  try {
    const rows = db.prepare("SELECT * FROM vocabulary ORDER BY adjective ASC").all() as VocabularyRow[];
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.get("/api/vocabulary/:adjective", (req: Request, res: Response) => {
  try {
    const adjective = decodeURIComponent(req.params.adjective);
    const row = db.prepare("SELECT * FROM vocabulary WHERE adjective = ?").get(adjective) as VocabularyRow | undefined;
    if (!row) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.put("/api/vocabulary/:adjective", (req: Request, res: Response) => {
  const oldAdj = decodeURIComponent(req.params.adjective);
  const body = req.body as Record<string, unknown>;
  if (!body || typeof body !== "object") {
    res.status(400).json({ error: "JSON body required" });
    return;
  }
  try {
    const existing = db.prepare("SELECT 1 FROM vocabulary WHERE adjective = ?").get(oldAdj);
    if (!existing) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const adjective = (body.adjective as string)?.trim() ?? oldAdj;
    const rule_description = (body.rule_description as string) ?? "";
    const is_starter = body.is_starter != null ? (body.is_starter ? 1 : 0) : 0;
    db.prepare("UPDATE vocabulary SET adjective = ?, rule_description = ?, is_starter = ? WHERE adjective = ?").run(
      adjective,
      rule_description,
      is_starter,
      oldAdj
    );
    const row = db.prepare("SELECT * FROM vocabulary WHERE adjective = ?").get(adjective) as VocabularyRow;
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.post("/api/vocabulary", (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  if (!body || typeof body !== "object") {
    res.status(400).json({ error: "JSON body required" });
    return;
  }
  const adjective = (body.adjective as string)?.trim()?.toLowerCase();
  if (!adjective) {
    res.status(400).json({ error: "adjective required" });
    return;
  }
  try {
    const existing = db.prepare("SELECT 1 FROM vocabulary WHERE adjective = ?").get(adjective);
    if (existing) {
      res.status(409).json({ error: "adjective already exists" });
      return;
    }
    const rule_description = (body.rule_description as string) ?? "";
    const is_starter = body.is_starter != null ? (body.is_starter ? 1 : 0) : 0;
    db.prepare("INSERT INTO vocabulary (adjective, rule_description, is_starter) VALUES (?, ?, ?)").run(
      adjective,
      rule_description,
      is_starter
    );
    const row = db.prepare("SELECT * FROM vocabulary WHERE adjective = ?").get(adjective) as VocabularyRow;
    res.status(201).json(row);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.delete("/api/vocabulary/:adjective", (req: Request, res: Response) => {
  const adjective = decodeURIComponent(req.params.adjective);
  try {
    const result = db.prepare("DELETE FROM vocabulary WHERE adjective = ?").run(adjective);
    if (result.changes === 0) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.status(204).end();
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// Static authoring UI (no API key required to load page; API calls use key from URL)
app.use(express.static(AUTHORING_DIR));
app.get("/", (_req: Request, res: Response) => {
  res.sendFile(path.join(AUTHORING_DIR, "index.html"));
});

app.listen(PORT, HOST, () => {
  console.log(`TaleShed Authoring at http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
  console.log(`  Add ?api=YOUR_KEY to the URL. Database: ${dbPath}`);
});
