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
import {
  fetchAdjectiveDefinitions,
  resolveRedundantAdjectives,
  isEngineCoveredByDefinition,
  filterEngineCoveredAdjectives,
  isTransientOrNarrativeOnlyByDefinition,
  filterTransientAdjectives,
  debugLog,
} from "./ollama.js";

export interface TakeTurnArgs {
  player_command: string;
  recent_history?: string;
}

export interface TakeTurnOutput {
  result: "success" | "failure" | "partial" | "error";
  prose: string;
  error?: string;
  reconciliation_notes?: string | null;
  /** Node IDs in the scene this turn (location, entities present, inventory, player). Use these exact IDs for update_node_adjectives. */
  scene_node_ids?: string[];
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
  const nodeIdRaw = (args.node_id ?? "").trim();
  if (!nodeIdRaw) {
    const out: UpdateNodeAdjectivesOutput = { success: false, error: "node_id is required" };
    debugLog("update_node_adjectives response", JSON.stringify(out));
    return out;
  }
  let node = getNode(db, nodeIdRaw);
  let nodeId = nodeIdRaw;
  if (!node) {
    for (const suffix of ["_01", "_1"]) {
      const candidate = nodeIdRaw + suffix;
      const n = getNode(db, candidate);
      if (n) {
        node = n;
        nodeId = candidate;
        break;
      }
    }
  }
  if (!node) {
    const out: UpdateNodeAdjectivesOutput = {
      success: false,
      error: `No active node with node_id "${nodeIdRaw}". Use the exact node_id from the scene (e.g. torch_01, not "torch").`,
    };
    debugLog("update_node_adjectives response", JSON.stringify(out));
    return out;
  }
  const rawAdjectives = Array.isArray(args.adjectives) ? args.adjectives : [];
  let adjectives = [...new Set(rawAdjectives.map((a) => String(a).trim()).filter(Boolean))];
  const vocabulary = getFullVocabulary(db);
  /* Strip adjectives that are engine-covered (containment/placement/possession) or transient/narrative-only. */
  adjectives = await filterEngineCoveredAdjectives(adjectives, vocabulary);
  adjectives = await filterTransientAdjectives(adjectives, vocabulary);
  /* States are represented by vocabulary terms only. Negations (e.g. unlit, unlocked, "not X") mean "omit the positive term"—strip the negation term and the corresponding positive term from the list. */
  const vocabLower = new Set(vocabulary.map((v) => v.adjective.trim().toLowerCase()).filter(Boolean));
  const toRemove = new Set<string>();
  for (const a of adjectives) {
    const lower = a.toLowerCase();
    for (const v of vocabLower) {
      if (lower === "un" + v || lower === "not " + v) {
        toRemove.add(a);
        toRemove.add(vocabulary.find((x) => x.adjective.toLowerCase() === v)?.adjective ?? v);
        break;
      }
    }
  }
  if (toRemove.size > 0) {
    const removeLower = new Set([...toRemove].map((x) => x.toLowerCase()));
    adjectives = adjectives.filter((x) => !removeLower.has(x.toLowerCase()));
  }
  const candidatesNotInVocab = adjectives.filter((a) => !vocabLower.has(a.toLowerCase()));
  if (candidatesNotInVocab.length > 0) {
    const resolveMap = await resolveRedundantAdjectives(candidatesNotInVocab, vocabulary);
    adjectives = [...new Set(adjectives.map((a) => resolveMap.get(a.toLowerCase()) ?? a))];
  }
  /* For adjectives not in vocab, fetch definitions and strip any that are engine-covered before writing to node. */
  const missing = adjectives.filter((a) => !vocabLower.has(a.toLowerCase()));
  let vocabToInsert: { adjective: string; rule_description: string }[] = [];
  if (missing.length > 0) {
    const definitionsForMissing = await fetchAdjectiveDefinitions(missing, vocabulary, "update_node_adjectives");
    const rejectedNew = new Set<string>();
    for (const d of definitionsForMissing) {
      if (!d.adjective) continue;
      const key = d.adjective.trim().toLowerCase();
      const covered = await isEngineCoveredByDefinition(d.adjective, d.rule_description || "(No description)");
      if (covered) rejectedNew.add(key);
      const transient = await isTransientOrNarrativeOnlyByDefinition(d.adjective, d.rule_description || "(No description)");
      if (transient) rejectedNew.add(key);
      if (!covered && !transient) vocabToInsert.push({ adjective: d.adjective, rule_description: d.rule_description || "(No description)" });
    }
    if (rejectedNew.size > 0) {
      adjectives = adjectives.filter((a) => !rejectedNew.has(a.toLowerCase()));
    }
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
  if (vocabToInsert.length > 0) {
    db.transaction(() => {
      for (const d of vocabToInsert) {
        insertVocabulary(db, d.adjective, d.rule_description, 0);
      }
    })();
  }
  const out: UpdateNodeAdjectivesOutput = { success: true };
  debugLog("update_node_adjectives response", JSON.stringify(out));
  return out;
}

export function handleTakeTurn(db: Database.Database, args: TakeTurnArgs): Promise<TakeTurnOutput> {
  return takeTurnWithRetry(db, args.player_command, args.recent_history ?? "");
}

export interface BookmarkArgs {
  description?: string | null;
}

export function handleBookmark(
  db: Database.Database,
  args?: BookmarkArgs
): { prose: string; entry_id: number; number: number; description: string } {
  return createBookmark(db, args?.description);
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
