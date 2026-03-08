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
  deleteHistoryAfterEntryId,
  getLatestAdjectivesNewPerNode,
  getDistinctNodeIdsFromLedger,
  bookmark as dbBookmark,
  writeRestoreEvent,
  updateWorldGraphAdjectives,
} from "./db/database.js";

const BOOKMARK_DESCRIPTION_MAX_LEN = 60;

/** Build a short unique description from recent history (prose_impact or action_description). */
function buildBookmarkDescription(db: Database.Database): string {
  const recent = getRecentHistoryForDescription(db, 5);
  for (const e of recent) {
    const text = (e.prose_impact ?? e.action_description ?? "").trim();
    if (text) {
      const oneLine = text.replace(/\s+/g, " ").slice(0, BOOKMARK_DESCRIPTION_MAX_LEN);
      return oneLine + (oneLine.length >= BOOKMARK_DESCRIPTION_MAX_LEN ? "…" : "");
    }
  }
  return "Saved point";
}

export interface BookmarkResult {
  prose: string;
  entry_id: number;
  number: number;
  description: string;
}

export function createBookmark(db: Database.Database): BookmarkResult {
  const existing = getAllBookmarks(db);
  const number = existing.length + 1;
  const fromHistory = buildBookmarkDescription(db);
  const description = `${number}: ${fromHistory}`;
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
