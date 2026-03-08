/**
 * MCP tool handlers: take_turn, bookmark, restore_to_bookmark, update_node_adjectives.
 */

import type Database from "better-sqlite3";
import { takeTurnWithRetry } from "./turn.js";
import { createBookmark, listBookmarks, restoreToBookmark } from "./bookmark.js";
import {
  getNode,
  updateWorldGraphAdjectives,
  getFullVocabulary,
  insertVocabulary,
  writeHistoryLedger,
} from "./db/database.js";
import { fetchAdjectiveDefinitions, resolveRedundantAdjectives, debugLog } from "./ollama.js";

export interface TakeTurnArgs {
  player_command: string;
  recent_history?: string;
}

export interface TakeTurnOutput {
  result: "success" | "failure" | "partial" | "error";
  prose: string;
  error?: string;
}

export interface UpdateNodeAdjectivesArgs {
  node_id: string;
  adjectives: string[];
}

export interface UpdateNodeAdjectivesOutput {
  success: boolean;
  error?: string;
}

function parseAdjectives(val: string | undefined | null): string[] {
  try {
    if (typeof val === "string" && val.trim()) {
      const parsed = JSON.parse(val);
      return Array.isArray(parsed) ? parsed.map((x) => String(x)) : [];
    }
    return [];
  } catch {
    return [];
  }
}

export async function handleUpdateNodeAdjectives(
  db: Database.Database,
  args: UpdateNodeAdjectivesArgs
): Promise<UpdateNodeAdjectivesOutput> {
  debugLog("update_node_adjectives request", JSON.stringify(args, null, 2));
  const nodeId = (args.node_id ?? "").trim();
  if (!nodeId) {
    const out: UpdateNodeAdjectivesOutput = { success: false, error: "node_id is required" };
    debugLog("update_node_adjectives response", JSON.stringify(out));
    return out;
  }
  const node = getNode(db, nodeId);
  if (!node) {
    const out: UpdateNodeAdjectivesOutput = { success: false, error: `No active node with node_id "${nodeId}"` };
    debugLog("update_node_adjectives response", JSON.stringify(out));
    return out;
  }
  const rawAdjectives = Array.isArray(args.adjectives) ? args.adjectives : [];
  let adjectives = [...new Set(rawAdjectives.map((a) => String(a).trim()).filter(Boolean))];
  const vocabulary = getFullVocabulary(db);
  const vocabLower = new Set(vocabulary.map((v) => v.adjective.toLowerCase()));
  const candidatesNotInVocab = adjectives.filter((a) => !vocabLower.has(a.toLowerCase()));
  if (candidatesNotInVocab.length > 0) {
    const resolveMap = await resolveRedundantAdjectives(candidatesNotInVocab, vocabulary);
    adjectives = [...new Set(adjectives.map((a) => resolveMap.get(a.toLowerCase()) ?? a))];
  }
  const currentAdj = parseAdjectives(node.adjectives);
  const newJson = JSON.stringify(adjectives);
  const currentJson = JSON.stringify(currentAdj);
  if (newJson === currentJson) {
    const out: UpdateNodeAdjectivesOutput = { success: true };
    debugLog("update_node_adjectives response", JSON.stringify(out));
    return out;
  }
  db.transaction(() => {
    updateWorldGraphAdjectives(db, nodeId, newJson);
    writeHistoryLedger(db, [
      {
        timestamp: new Date().toISOString(),
        action_description: "narrator_adjective_sync",
        node_id: nodeId,
        prose_impact: null,
        adjectives_old: currentJson,
        adjectives_new: newJson,
        system_event: null,
      },
    ]);
  })();
  const missing = adjectives.filter((a) => !vocabLower.has(a.toLowerCase()));
  if (missing.length > 0) {
    debugLog("update_node_adjectives fetching definitions", JSON.stringify({ terms: missing }));
    const definitions = await fetchAdjectiveDefinitions(missing, vocabulary, "update_node_adjectives");
    if (definitions.length > 0) {
      db.transaction(() => {
        for (const d of definitions) {
          if (d.adjective) {
            insertVocabulary(db, d.adjective, d.rule_description || "(No description)", 0);
          }
        }
      })();
    }
  }
  const out: UpdateNodeAdjectivesOutput = { success: true };
  debugLog("update_node_adjectives response", JSON.stringify(out));
  return out;
}

export function handleTakeTurn(db: Database.Database, args: TakeTurnArgs): Promise<TakeTurnOutput> {
  return takeTurnWithRetry(db, args.player_command, args.recent_history ?? "");
}

export function handleBookmark(db: Database.Database): { prose: string; entry_id: number; number: number; description: string } {
  return createBookmark(db);
}

export function handleListBookmarks(db: Database.Database): { bookmarks: { number: number; entry_id: number; description: string }[]; prose: string } {
  return listBookmarks(db);
}

export function handleRestoreToBookmark(
  db: Database.Database,
  bookmarkNumber: number | undefined,
  confirm: boolean
): { prose: string; success: boolean; needs_confirm?: boolean } {
  return restoreToBookmark(db, bookmarkNumber, confirm);
}
