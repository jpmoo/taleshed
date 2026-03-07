/**
 * Shared MCP server setup: tool registration.
 * Used by both stdio (index.ts) and HTTP (http.ts) entry points.
 */

import { McpServer } from "./sdk-shim.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import {
  handleTakeTurn,
  handleBookmark,
  handleRestoreToBookmark,
  handleUpdateNodeAdjectives,
} from "./tools.js";

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
  player_command: z
    .string()
    .describe(
      "The player's exact command, verbatim. Pass the full phrase the player typed. Do not simplify: e.g. if the player said 'take the torch and go through the door', pass exactly that—not 'east' or a single action. Do not add or assume actions: e.g. if they said 'take torch', pass that—do not expand to 'take torch and light it'."
    ),
  recent_history: z
    .string()
    .optional()
    .describe(
      "Recommended. Prose summary or transcript of the last 4–8 exchanges (or more). Include what the player did and what was narrated. Up to ~2000 characters helps the engine keep narration consistent. Pass the suggested_recent_history from the previous take_turn result when available."
    ),
});

const UpdateNodeAdjectivesSchema = z.object({
  node_id: z.string().describe("The node_id of the entity to update (e.g. 'ciaran', 'player'). Must exist in the world."),
  adjectives: z
    .array(z.string())
    .describe("Full list of adjectives that now describe this entity. Replace the previous set; new terms get definitions automatically."),
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
        "The core game loop. Pass the player's command exactly as the player typed it. You may send compound commands as one phrase (e.g. 'take the torch and go through the door') or as separate take_turn calls (e.g. 'take torch', then 'go through door', then 'east'); the engine handles both. Each single command (e.g. 'go through door', 'east') must be processed correctly. When available, pass recent_history (or suggested_recent_history from the previous response). Returns result, prose for narration, and suggested_recent_history. When presenting the engine's prose to the player: be verbose.",
      inputSchema: TakeTurnSchema,
    },
    async (args: unknown) => {
      const parsed = TakeTurnSchema.safeParse(args);
      if (!parsed.success) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ result: "error", prose: "", error: parsed.error.message }) }],
        };
      }
      try {
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
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                result: "error",
                prose: "",
                error: message,
              }),
            },
          ],
        };
      }
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

  server.registerTool(
    "update_node_adjectives",
    {
      title: "Update Node Adjectives",
      description:
        "When your narration implies a state or disposition change for an NPC or entity (e.g. Ciaran becomes less guarded, a room feels tense), call this to sync the engine so future turns see the updated state. Pass the node_id (e.g. 'ciaran') and the full list of adjectives that now describe that entity. New adjectives get definitions automatically. Use after presenting prose where you expanded with disposition or atmosphere changes.",
      inputSchema: UpdateNodeAdjectivesSchema,
    },
    async (args: unknown) => {
      const parsed = UpdateNodeAdjectivesSchema.safeParse(args);
      if (!parsed.success) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: false, error: parsed.error.message }),
            },
          ],
        };
      }
      const out = await handleUpdateNodeAdjectives(db, parsed.data);
      return { content: [{ type: "text" as const, text: JSON.stringify(out) }] };
    }
  );

  return server;
}
