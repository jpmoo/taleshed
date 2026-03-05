/**
 * TaleShed database queries and helpers.
 */

import type Database from "better-sqlite3";
import type { WorldNode, HistoryEntry, VocabularyRow } from "./schema.js";

const ISO_NOW = () => new Date().toISOString();

export function getPlayer(db: Database.Database): WorldNode | undefined {
  return db.prepare("SELECT * FROM world_graph WHERE node_id = 'player' AND is_active = 1").get() as WorldNode | undefined;
}

export function getNode(db: Database.Database, nodeId: string): WorldNode | undefined {
  return db.prepare("SELECT * FROM world_graph WHERE node_id = ? AND is_active = 1").get(nodeId) as WorldNode | undefined;
}

export function getLocation(db: Database.Database, locationId: string): WorldNode | undefined {
  return getNode(db, locationId);
}

export function getEntitiesInLocation(db: Database.Database, locationId: string): WorldNode[] {
  return db
    .prepare("SELECT * FROM world_graph WHERE location_id = ? AND is_active = 1")
    .all(locationId) as WorldNode[];
}

export function getPlayerInventory(db: Database.Database): WorldNode[] {
  return getEntitiesInLocation(db, "player_inventory");
}

export function getRecentHistoryForNode(db: Database.Database, nodeId: string, limit: number): HistoryEntry[] {
  const rows = db
    .prepare(
      "SELECT * FROM history_ledger WHERE node_id = ? AND system_event IS NULL ORDER BY entry_id DESC LIMIT ?"
    )
    .all(nodeId, limit) as HistoryEntry[];
  return rows.reverse();
}

export function getFullVocabulary(db: Database.Database): VocabularyRow[] {
  return db.prepare("SELECT * FROM vocabulary ORDER BY adjective ASC").all() as VocabularyRow[];
}

export function getMostRecentBookmark(db: Database.Database): HistoryEntry | undefined {
  return db
    .prepare("SELECT * FROM history_ledger WHERE system_event = 'BOOKMARK' ORDER BY entry_id DESC LIMIT 1")
    .get() as HistoryEntry | undefined;
}

export function writeHistoryLedger(
  db: Database.Database,
  entries: {
    timestamp: string;
    action_description: string | null;
    node_id: string | null;
    prose_impact: string | null;
    adjectives_old: string | null;
    adjectives_new: string | null;
    system_event: string | null;
  }[]
): void {
  const stmt = db.prepare(`
    INSERT INTO history_ledger (timestamp, action_description, node_id, prose_impact, adjectives_old, adjectives_new, system_event)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const now = ISO_NOW();
  for (const e of entries) {
    stmt.run(
      e.timestamp || now,
      e.action_description ?? null,
      e.node_id ?? null,
      e.prose_impact ?? null,
      e.adjectives_old ?? null,
      e.adjectives_new ?? null,
      e.system_event ?? null
    );
  }
}

export function updateWorldGraphAdjectives(db: Database.Database, nodeId: string, adjectivesJson: string): void {
  db.prepare("UPDATE world_graph SET adjectives = ? WHERE node_id = ?").run(adjectivesJson, nodeId);
}

export function deleteHistoryAfterEntryId(db: Database.Database, entryId: number): void {
  db.prepare("DELETE FROM history_ledger WHERE entry_id > ?").run(entryId);
}

export function getDistinctNodeIdsFromLedger(db: Database.Database): string[] {
  const rows = db.prepare("SELECT DISTINCT node_id FROM history_ledger WHERE node_id IS NOT NULL").all() as {
    node_id: string;
  }[];
  return rows.map((r) => r.node_id);
}

export function getLatestAdjectivesNewPerNode(db: Database.Database): Map<string, string> {
  const rows = db
    .prepare(
      `SELECT node_id, adjectives_new FROM history_ledger
       WHERE node_id IS NOT NULL AND adjectives_new IS NOT NULL
       ORDER BY entry_id DESC`
    )
    .all() as { node_id: string; adjectives_new: string }[];
  const map = new Map<string, string>();
  for (const r of rows) {
    if (!map.has(r.node_id)) map.set(r.node_id, r.adjectives_new);
  }
  return map;
}

export function insertVocabulary(
  db: Database.Database,
  adjective: string,
  ruleDescription: string,
  isStarter: number
): void {
  db.prepare(
    "INSERT OR IGNORE INTO vocabulary (adjective, rule_description, is_starter) VALUES (?, ?, ?)"
  ).run(adjective.toLowerCase(), ruleDescription, isStarter);
}

export function bookmark(db: Database.Database): number {
  const now = ISO_NOW();
  const result = db
    .prepare(
      "INSERT INTO history_ledger (timestamp, action_description, node_id, prose_impact, adjectives_old, adjectives_new, system_event) VALUES (?, NULL, 'SYSTEM', NULL, NULL, NULL, 'BOOKMARK')"
    )
    .run(now);
  return result.lastInsertRowid as number;
}

export function writeRestoreEvent(db: Database.Database): void {
  const now = ISO_NOW();
  db.prepare(
    "INSERT INTO history_ledger (timestamp, action_description, node_id, prose_impact, adjectives_old, adjectives_new, system_event) VALUES (?, 'RESTORE', 'SYSTEM', NULL, NULL, NULL, 'RESTORE')"
  ).run(now);
}
