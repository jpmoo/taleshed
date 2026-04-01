/**
 * TaleShed database queries and helpers.
 */

import type Database from "better-sqlite3";
import type { WorldNode, HistoryEntry, VocabularyRow } from "./schema.js";

const ISO_NOW = () => new Date().toISOString();

export function getPlayer(db: Database.Database): WorldNode | undefined {
  return db.prepare("SELECT * FROM world_graph WHERE node_id = 'player' AND is_active = 1").get() as WorldNode | undefined;
}

/** Player meta may store { came_from_location_id: string }. Returns that location id or null. */
export function getPlayerCameFromLocationId(db: Database.Database): string | null {
  const player = getPlayer(db);
  if (!player || !player.meta || typeof player.meta !== "string") return null;
  try {
    const obj = JSON.parse(player.meta) as Record<string, unknown>;
    const id = obj?.came_from_location_id;
    return typeof id === "string" && id.trim() ? id.trim() : null;
  } catch {
    return null;
  }
}

export function getNode(db: Database.Database, nodeId: string): WorldNode | undefined {
  return db.prepare("SELECT * FROM world_graph WHERE node_id = ? AND is_active = 1").get(nodeId) as WorldNode | undefined;
}

export function getLocation(db: Database.Database, locationId: string): WorldNode | undefined {
  return getNode(db, locationId);
}

/** All location node_ids (lowercase) for filtering—e.g. never use a location name as an adjective. */
export function getLocationNodeIds(db: Database.Database): Set<string> {
  const rows = db
    .prepare("SELECT node_id FROM world_graph WHERE node_type = 'location' AND is_active = 1")
    .all() as { node_id: string }[];
  return new Set(rows.map((r) => r.node_id.trim().toLowerCase()));
}

/** Resolve a location by exact node_id or by case-insensitive node_id/name (e.g. "the kitchen" -> kitchen). Returns canonical node_id or null. */
export function resolveLocationNodeId(db: Database.Database, idOrName: string): string | null {
  const trimmed = (idOrName ?? "").trim();
  if (!trimmed) return null;
  const node = getNode(db, trimmed);
  if (node) return node.node_id;
  const lower = trimmed.toLowerCase();
  const locations = db
    .prepare("SELECT node_id, name FROM world_graph WHERE node_type = 'location' AND is_active = 1")
    .all() as { node_id: string; name: string }[];
  for (const loc of locations) {
    if (loc.node_id.toLowerCase() === lower) return loc.node_id;
    if (loc.name && loc.name.toLowerCase() === lower) return loc.node_id;
  }
  return null;
}

export function getEntitiesInLocation(db: Database.Database, locationId: string): WorldNode[] {
  return db
    .prepare("SELECT * FROM world_graph WHERE location_id = ? AND is_active = 1")
    .all(locationId) as WorldNode[];
}

/** Follow location_id until a location node; return that node_id or null. Used to ensure we only show entities whose containment chain ends at the current room. */
export function getRootLocationId(db: Database.Database, nodeId: string): string | null {
  const seen = new Set<string>();
  let current = getNode(db, nodeId);
  while (current) {
    if (seen.has(current.node_id)) return null;
    seen.add(current.node_id);
    if (current.node_type === "location") return current.node_id;
    if (!current.location_id || !current.location_id.trim()) return null;
    current = getNode(db, current.location_id.trim());
  }
  return null;
}

/** Entities in a location, plus entities contained in objects in that location (one level). Contents are only included if the container is not closed. Order: each direct entity then its contents. */
export function getEntitiesInLocationIncludingContents(db: Database.Database, locationId: string): WorldNode[] {
  const direct = getEntitiesInLocation(db, locationId);
  const result: WorldNode[] = [];
  for (const node of direct) {
    result.push(node);
    if (node.node_type === "object") {
      const adjectives = parseAdjectives(node.adjectives);
      if (!adjectives.includes("closed")) {
        const contents = getEntitiesInLocation(db, node.node_id);
        for (const c of contents) result.push(c);
      }
    }
  }
  return result;
}

function parseAdjectives(adjectivesJson: string): string[] {
  if (!adjectivesJson || adjectivesJson.trim() === "") return [];
  try {
    const arr = JSON.parse(adjectivesJson) as unknown;
    return Array.isArray(arr) ? arr.filter((a): a is string => typeof a === "string") : [];
  } catch {
    return [];
  }
}

/** Containment is uniform: any node (player, NPC, or object) can contain others via location_id. Player inventory = entities whose location_id is the player node; same for NPCs; objects in a bracket have location_id = that bracket's node_id. */
export function getPlayerInventory(db: Database.Database): WorldNode[] {
  const player = getPlayer(db);
  if (!player) return [];
  return getEntitiesInLocation(db, player.node_id);
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

export interface BookmarkRow {
  entry_id: number;
  timestamp: string;
  action_description: string | null;
}

/** All bookmarks in chronological order (entry_id ASC). Number in list is 1-based index. */
export function getAllBookmarks(db: Database.Database): BookmarkRow[] {
  return db
    .prepare(
      "SELECT entry_id, timestamp, action_description FROM history_ledger WHERE system_event = 'BOOKMARK' ORDER BY entry_id ASC"
    )
    .all() as BookmarkRow[];
}

/** Get bookmark by 1-based number (1 = first bookmark). Returns undefined if number out of range. */
export function getBookmarkByNumber(db: Database.Database, number: number): BookmarkRow | undefined {
  const all = getAllBookmarks(db);
  const index = number >= 1 ? number - 1 : -1;
  return all[index];
}

/** Recent history entries (excluding BOOKMARK/RESTORE) for building bookmark description. entry_id DESC, limit N. */
export function getRecentHistoryForDescription(db: Database.Database, limit: number): HistoryEntry[] {
  return db
    .prepare(
      `SELECT * FROM history_ledger
       WHERE system_event IS NULL OR system_event NOT IN ('BOOKMARK', 'RESTORE')
       ORDER BY entry_id DESC LIMIT ?`
    )
    .all(limit) as HistoryEntry[];
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

export function updateWorldGraphLocation(db: Database.Database, nodeId: string, locationId: string | null): void {
  db.prepare("UPDATE world_graph SET location_id = ? WHERE node_id = ?").run(locationId, nodeId);
}

export function updateWorldGraphMeta(db: Database.Database, nodeId: string, metaJson: string | null): void {
  db.prepare("UPDATE world_graph SET meta = ? WHERE node_id = ?").run(metaJson, nodeId);
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

export function bookmark(db: Database.Database, description: string | null): number {
  const now = ISO_NOW();
  const result = db
    .prepare(
      "INSERT INTO history_ledger (timestamp, action_description, node_id, prose_impact, adjectives_old, adjectives_new, system_event) VALUES (?, ?, 'SYSTEM', NULL, NULL, NULL, 'BOOKMARK')"
    )
    .run(now, description ?? null);
  return result.lastInsertRowid as number;
}

export function writeRestoreEvent(db: Database.Database): void {
  const now = ISO_NOW();
  db.prepare(
    "INSERT INTO history_ledger (timestamp, action_description, node_id, prose_impact, adjectives_old, adjectives_new, system_event) VALUES (?, 'RESTORE', 'SYSTEM', NULL, NULL, NULL, 'RESTORE')"
  ).run(now);
}

/** Returns true if a node with the given node_id exists (active or inactive). */
export function nodeIdExists(db: Database.Database, nodeId: string): boolean {
  return db.prepare("SELECT 1 FROM world_graph WHERE node_id = ?").get(nodeId) != null;
}

/** Insert a new world_graph node. Caller is responsible for uniqueness of node_id. */
export function createWorldGraphNode(
  db: Database.Database,
  nodeId: string,
  nodeType: string,
  name: string,
  baseDescription: string,
  adjectivesJson: string,
  locationId: string | null
): void {
  db.prepare(
    `INSERT INTO world_graph
       (node_id, node_type, name, base_description, adjectives, location_id, is_active, meta, exits)
     VALUES (?, ?, ?, ?, ?, ?, 1, NULL, '[]')`
  ).run(nodeId, nodeType, name, baseDescription, adjectivesJson, locationId);
}
