/**
 * Bookmark and restore_to_bookmark logic.
 * Spec Section 3.2, 3.3, 6.6.
 */

import type Database from "better-sqlite3";
import {
  getMostRecentBookmark,
  deleteHistoryAfterEntryId,
  getLatestAdjectivesNewPerNode,
  getDistinctNodeIdsFromLedger,
  bookmark as dbBookmark,
  writeRestoreEvent,
  updateWorldGraphAdjectives,
} from "./db/database.js";

export interface BookmarkResult {
  prose: string;
  entry_id: number;
}

export function createBookmark(db: Database.Database): BookmarkResult {
  const entryId = dbBookmark(db);
  return {
    prose: "Your progress has been saved.",
    entry_id: Number(entryId),
  };
}

export interface RestoreResult {
  prose: string;
  success: boolean;
}

const NO_BOOKMARK_PROSE = "There is no saved point to return to.";

export function restoreToBookmark(db: Database.Database): RestoreResult {
  const bm = getMostRecentBookmark(db);
  if (!bm) {
    return { prose: NO_BOOKMARK_PROSE, success: false };
  }
  const entryId = bm.entry_id;
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
    prose: "The world has returned to your last saved point.",
    success: true,
  };
}
