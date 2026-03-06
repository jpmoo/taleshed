/**
 * TaleShed SQLite schema and initialization.
 * Spec Section 2: world_graph, history_ledger, vocabulary.
 */

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

const DEFAULT_DB_PATH = path.join(process.cwd(), "taleshed.db");

export function getDbPath(): string {
  return process.env["TALESHED_DB_PATH"] ?? DEFAULT_DB_PATH;
}

export function initDatabase(dbPath?: string): Database.Database {
  const raw = dbPath ?? getDbPath();
  const target = path.resolve(raw);
  const dir = path.dirname(target);
  if (dir !== ".") {
    fs.mkdirSync(dir, { recursive: true });
  }
  try {
    var db = new Database(target);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`TaleShed could not open database at ${target}: ${msg}`);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS world_graph (
      node_id TEXT PRIMARY KEY,
      node_type TEXT NOT NULL,
      name TEXT NOT NULL,
      base_description TEXT NOT NULL DEFAULT '',
      adjectives TEXT NOT NULL DEFAULT '[]',
      location_id TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      meta TEXT,
      exits TEXT NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS history_ledger (
      entry_id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      action_description TEXT,
      node_id TEXT,
      prose_impact TEXT,
      adjectives_old TEXT,
      adjectives_new TEXT,
      system_event TEXT
    );

    CREATE TABLE IF NOT EXISTS vocabulary (
      adjective TEXT PRIMARY KEY,
      rule_description TEXT NOT NULL DEFAULT '',
      is_starter INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_history_node_id ON history_ledger(node_id);
    CREATE INDEX IF NOT EXISTS idx_history_system_event ON history_ledger(system_event);
    CREATE INDEX IF NOT EXISTS idx_world_location ON world_graph(location_id);
    CREATE INDEX IF NOT EXISTS idx_world_active ON world_graph(is_active);
  `);

  // Migration: add exits column if missing (existing DBs)
  const hasExits = db.prepare("SELECT 1 FROM pragma_table_info('world_graph') WHERE name = 'exits'").get();
  if (!hasExits) {
    db.exec("ALTER TABLE world_graph ADD COLUMN exits TEXT NOT NULL DEFAULT '[]'");
  }

  return db;
}

export type NodeType = "location" | "object" | "npc" | "player";

export interface WorldNode {
  node_id: string;
  node_type: NodeType;
  name: string;
  base_description: string;
  adjectives: string; // JSON array
  location_id: string | null;
  is_active: number;
  meta: string | null;
  /** JSON array of { label: string, target: string } for location nodes; default '[]' */
  exits?: string;
}

export interface HistoryEntry {
  entry_id: number;
  timestamp: string;
  action_description: string | null;
  node_id: string | null;
  prose_impact: string | null;
  adjectives_old: string | null;
  adjectives_new: string | null;
  system_event: string | null;
}

export interface VocabularyRow {
  adjective: string;
  rule_description: string;
  is_starter: number;
}
