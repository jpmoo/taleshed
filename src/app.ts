/**
 * Shared MCP server setup: tool registration.
 * Used by both stdio (index.ts) and HTTP (http.ts) entry points.
 */

import { McpServer } from "./sdk-shim.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import { handleTakeTurn, handleBookmark, handleRestoreToBookmark } from "./tools.js";

const MAX_SUGGESTED_HISTORY_CHARS = 2800;

/** Build a history string for Claude to pass back on the next take_turn call. */
function buildSuggestedRecentHistory(
  recentHistory: string | undefined,
  playerCommand: string,
  prose: string
): string | null {
  const prev = (recentHistory ?? "").trim();
  const exchange = `Player: ${playerCommand.trim()}\n\n${(prose ?? "").trim()}`.trim();
  if (!exchange) return null;
  const combined = prev ? `${prev}\n\n---\n\n${exchange}` : exchange;
  if (combined.length <= MAX_SUGGESTED_HISTORY_CHARS) return combined;
  return "…\n\n" + combined.slice(-(MAX_SUGGESTED_HISTORY_CHARS - 2));
}

const TakeTurnSchema = z.object({
  player_command: z.string().describe("The raw text input from the player, e.g. 'ask Ciarán about the manuscript' or 'pick up the torch'"),
  recent_history: z
    .string()
    .optional()
    .describe(
      "Recommended. Prose summary or transcript of the last 4–8 exchanges (or more). Include what the player did and what was narrated. Up to ~2000 characters helps the engine keep narration consistent. Pass the suggested_recent_history from the previous take_turn result when available."
    ),
});

export function createTaleshedServer(db: Database.Database): McpServer {
  const server = new McpServer(
    { name: "taleshed", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.registerTool(
    "take_turn",
    {
      title: "Take Turn",
      description:
        "The core game loop. Pass the player's command and, when available, recent_history (or suggested_recent_history from the previous response) so the engine can keep narration consistent. Returns result, prose for narration, and suggested_recent_history to pass back on the next call. Optional error if the tool failed.",
      inputSchema: TakeTurnSchema,
    },
    async (args: unknown) => {
      const parsed = TakeTurnSchema.safeParse(args);
      if (!parsed.success) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ result: "error", prose: "", error: parsed.error.message }) }],
        };
      }
      const out = await handleTakeTurn(db, parsed.data);
      const suggested = buildSuggestedRecentHistory(
        parsed.data.recent_history,
        parsed.data.player_command,
        out.prose
      );
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              suggested != null ? { ...out, suggested_recent_history: suggested } : out
            ),
          },
        ],
      };
    }
  );

  server.registerTool(
    "bookmark",
    {
      title: "Bookmark",
      description: "Saves the current world state as a restore point. The player can return to this point later with restore_to_bookmark. No parameters.",
      inputSchema: z.object({}),
    },
    async () => {
      const out = handleBookmark(db);
      return { content: [{ type: "text" as const, text: JSON.stringify(out) }] };
    }
  );

  server.registerTool(
    "restore_to_bookmark",
    {
      title: "Restore to Bookmark",
      description: "Rolls the world back to the most recent bookmark. Returns success and confirmation prose. No parameters.",
      inputSchema: z.object({}),
    },
    async () => {
      const out = handleRestoreToBookmark(db);
      return { content: [{ type: "text" as const, text: JSON.stringify(out) }] };
    }
  );

  return server;
}
