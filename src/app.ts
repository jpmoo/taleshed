/**
 * Shared MCP server setup: tool registration.
 * Used by both stdio (index.ts) and HTTP (http.ts) entry points.
 */

import { McpServer } from "./sdk-shim.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import { handleTakeTurn, handleBookmark, handleRestoreToBookmark } from "./tools.js";

const TakeTurnSchema = z.object({
  player_command: z.string().describe("The raw text input from the player, e.g. 'ask Ciarán about the manuscript' or 'pick up the torch'"),
  recent_history: z.string().optional().describe("Optional. A short prose summary or transcript of the last 2–4 exchanges, for reconciliation context."),
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
      description: "The core game loop. Pass the player's command and optional recent prose history. Returns result (success/failure/partial), prose for narration, and optional error if the tool failed.",
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
      return { content: [{ type: "text" as const, text: JSON.stringify(out) }] };
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
