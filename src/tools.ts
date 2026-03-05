/**
 * MCP tool handlers: take_turn, bookmark, restore_to_bookmark.
 */

import type Database from "better-sqlite3";
import { takeTurnWithRetry } from "./turn.js";
import { createBookmark, restoreToBookmark } from "./bookmark.js";

export interface TakeTurnArgs {
  player_command: string;
  recent_history?: string;
}

export interface TakeTurnOutput {
  result: "success" | "failure" | "partial" | "error";
  prose: string;
  error?: string;
}

export function handleTakeTurn(db: Database.Database, args: TakeTurnArgs): Promise<TakeTurnOutput> {
  return takeTurnWithRetry(db, args.player_command, args.recent_history ?? "");
}

export function handleBookmark(db: Database.Database): { prose: string; entry_id: number } {
  return createBookmark(db);
}

export function handleRestoreToBookmark(db: Database.Database): { prose: string; success: boolean } {
  return restoreToBookmark(db);
}
