/**
 * Bookmark and restore_to_bookmark logic.
 * Spec Section 3.2, 3.3, 6.6.
 * Bookmarks are numbered (1-based) and have a short description from recent history.
 */

import type Database from "better-sqlite3";
import {
  getAllBookmarks,
  getBookmarkByNumber,
  getRecentHistoryForDescription,
  getPlayer,
  getNode,
  deleteHistoryAfterEntryId,
  getLatestAdjectivesNewPerNode,
  getDistinctNodeIdsFromLedger,
  bookmark as dbBookmark,
  writeRestoreEvent,
  updateWorldGraphAdjectives,
} from "./db/database.js";

const BOOKMARK_DESCRIPTION_MAX_LEN = 80;

/** Phrases we treat as uninformative for a bookmark label; use location fallback instead. */
const UNINFORMATIVE = new Set([
  "no change.",
  "nothing happens.",
  "nothing.",
  "no change",
  "nothing happens",
  "nothing",
]);

const MOVEMENT_DIRECTIONS = [
  "north", "south", "east", "west", "northeast", "northwest", "southeast", "southwest", "up", "down",
  "n", "s", "e", "w", "ne", "nw", "se", "sw", "u", "d",
];

function looksLikeMovement(actionDescription: string | null): boolean {
  if (!actionDescription || !actionDescription.trim()) return false;
  const cmd = actionDescription.trim().toLowerCase();
  if (MOVEMENT_DIRECTIONS.some((d) => cmd === d || cmd === "go " + d)) return true;
  if (cmd.startsWith("go ") || cmd === "leave" || cmd === "exit" || cmd === "go out") return true;
  if (cmd.startsWith("go through") || cmd.startsWith("through ")) return true;
  return false;
}

/** Build a short descriptive phrase for the moment (e.g. "You have just moved into the kitchen" or "You are in the scriptorium"). */
function buildLocationFallback(db: Database.Database): string {
  const player = getPlayer(db);
  if (!player?.location_id) return "Saved point";
  const loc = getNode(db, player.location_id.trim());
  if (!loc) return "Saved point";
  const name = (loc.name ?? loc.node_id ?? "").trim();
  if (!name) return "Saved point";
  const recent = getRecentHistoryForDescription(db, 1);
  const lastAction = recent[0]?.action_description ?? null;
  const justMoved = looksLikeMovement(lastAction);
  const withArticle = name.toLowerCase().startsWith("the ") ? name : `the ${name}`;
  const phrase = justMoved
    ? `You have just moved into ${withArticle}`
    : `You are in ${withArticle}`;
  return phrase.length > BOOKMARK_DESCRIPTION_MAX_LEN ? phrase.slice(0, BOOKMARK_DESCRIPTION_MAX_LEN - 1) + "…" : phrase;
}

/** Build a short unique description from recent history (prose_impact or action_description), or current location if history is uninformative. */
function buildBookmarkDescription(db: Database.Database): string {
  const recent = getRecentHistoryForDescription(db, 5);
  for (const e of recent) {
    const text = (e.prose_impact ?? e.action_description ?? "").trim();
    if (text) {
      const oneLine = text.replace(/\s+/g, " ").slice(0, BOOKMARK_DESCRIPTION_MAX_LEN);
      const result = oneLine + (oneLine.length >= BOOKMARK_DESCRIPTION_MAX_LEN ? "…" : "");
      if (!UNINFORMATIVE.has(result.toLowerCase())) return result;
    }
  }
  return buildLocationFallback(db);
}

export interface BookmarkResult {
  prose: string;
  entry_id: number;
  number: number;
  description: string;
}

export function createBookmark(db: Database.Database, llmDescription?: string | null): BookmarkResult {
  const existing = getAllBookmarks(db);
  const number = existing.length + 1;
  const llmTrimmed = typeof llmDescription === "string" ? llmDescription.trim() : "";
  const fromLlm = llmTrimmed.length > 0;
  const raw = fromLlm
    ? llmTrimmed.replace(/\s+/g, " ").slice(0, BOOKMARK_DESCRIPTION_MAX_LEN)
    : buildBookmarkDescription(db);
  const truncated = fromLlm && raw.length >= BOOKMARK_DESCRIPTION_MAX_LEN;
  const description = `${number}: ${raw}` + (truncated ? "…" : "");
  const entryId = dbBookmark(db, description);
  return {
    prose: "Your progress has been saved.",
    entry_id: Number(entryId),
    number,
    description,
  };
}

export interface ListBookmarksResult {
  bookmarks: { number: number; entry_id: number; description: string }[];
  prose: string;
}

export function listBookmarks(db: Database.Database): ListBookmarksResult {
  const rows = getAllBookmarks(db);
  const bookmarks = rows.map((r, i) => ({
    number: i + 1,
    entry_id: r.entry_id,
    description: r.action_description ?? `Bookmark ${i + 1}`,
  }));
  if (bookmarks.length === 0) {
    return { bookmarks: [], prose: "There are no bookmarks yet. Use the bookmark tool to save a restore point." };
  }
  const lines = bookmarks.map((b) => `${b.number}. (entry ${b.entry_id}) ${b.description}`).join("\n");
  return {
    bookmarks,
    prose: `Available bookmarks:\n${lines}\n\nTo restore, use restore_to_bookmark with bookmark_number set to the number (e.g. ${bookmarks[0].number}). You will be asked to confirm.`,
  };
}

export interface RestoreResult {
  prose: string;
  success: boolean;
  /** When success is false and confirmation is needed, prompt for confirm: true. */
  needs_confirm?: boolean;
}

const NO_BOOKMARK_PROSE = "There is no saved point to return to.";
const SPECIFY_NUMBER_PROSE =
  "You must specify which bookmark by number. Use the list_bookmarks tool to see available bookmarks, then call restore_to_bookmark with bookmark_number set to the chosen number (e.g. bookmark_number: 2).";

export function restoreToBookmark(
  db: Database.Database,
  bookmarkNumber: number | undefined,
  confirm: boolean
): RestoreResult {
  if (bookmarkNumber === undefined || bookmarkNumber == null) {
    return { prose: SPECIFY_NUMBER_PROSE, success: false };
  }
  const bm = getBookmarkByNumber(db, bookmarkNumber);
  if (!bm) {
    return {
      prose: `There is no bookmark with number ${bookmarkNumber}. Use the list_bookmarks tool to see available bookmarks.`,
      success: false,
    };
  }
  const entryId = bm.entry_id;
  if (!confirm) {
    return {
      prose: `Restoring to bookmark ${bookmarkNumber} ("${bm.action_description ?? "saved point"}") will permanently remove all progress and all bookmarks created after it. To confirm, call restore_to_bookmark again with bookmark_number: ${bookmarkNumber} and confirm: true.`,
      success: false,
      needs_confirm: true,
    };
  }
  db.transaction(() => {
    deleteHistoryAfterEntryId(db, entryId);
    const latest = getLatestAdjectivesNewPerNode(db);
    const nodeIds = getDistinctNodeIdsFromLedger(db);
    for (const nodeId of nodeIds) {
      const adj = latest.get(nodeId);
      if (adj) updateWorldGraphAdjectives(db, nodeId, adj);
    }
    writeRestoreEvent(db);
  })();
  return {
    prose: `The world has returned to bookmark ${bookmarkNumber} (${bm.action_description ?? "saved point"}). All progress and bookmarks after that point have been removed.`,
    success: true,
  };
}
