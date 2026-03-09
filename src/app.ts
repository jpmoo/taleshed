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
  handleListBookmarks,
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
  node_id: z.string().describe("Exact node_id of the entity (use IDs from take_turn's scene_node_ids: e.g. torch_01, ciaran, player). Use only vocabulary terms. To indicate a state no longer applies, omit that term from the list; do not add negation terms (e.g. unlit, unlocked)."),
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
        "The core game loop. Pass the player's command exactly as the player typed it. You may send compound commands as one phrase (e.g. 'take the torch and go through the door') or as separate take_turn calls (e.g. 'take torch', then 'go through door', then 'east'); the engine handles both. When available, pass recent_history (or suggested_recent_history from the previous response). Returns result, prose, suggested_recent_history, and scene_node_ids (exact entity IDs for this scene—use these for update_node_adjectives, e.g. torch_01, ciaran). When presenting the engine's prose to the player: be verbose.",
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

  const bookmarkDescriptionParam = z
    .string()
    .min(1)
    .max(120)
    .optional()
    .describe(
      "Optional but recommended. A concise, evocative one-line description of what is happening in this moment: where the player is, what they hold, and/or what they just did (e.g. 'Kitchen, fire in the hearth, torch in hand' or 'Scriptorium, Ciaran looks up from his manuscript'). This becomes the bookmark label in list_bookmarks. If omitted, the engine generates a label from recent history."
    );
  const BookmarkSchema = z.object({ description: bookmarkDescriptionParam });
  server.registerTool(
    "bookmark",
    {
      title: "Bookmark",
      description:
        "Saves the current world state as a restore point. When calling this tool, if you can, pass the description parameter with a concise, evocative one-line summary of what's happening in this moment (where the player is, what they hold, what they just did). That label is shown in list_bookmarks and when restoring. If the tool is called without parameters, the engine generates a label from recent history. The player can return to any bookmark later with restore_to_bookmark (use list_bookmarks first to see numbers).",
      inputSchema: { description: bookmarkDescriptionParam },
    },
    async (args: unknown) => {
      const parsed = BookmarkSchema.safeParse(args ?? {});
      const data = parsed.success ? parsed.data : { description: undefined };
      const desc = typeof data?.description === "string" && data.description.trim() ? data.description.trim() : null;
      const out = handleBookmark(db, { description: desc });
      return { content: [{ type: "text" as const, text: JSON.stringify(out) }] };
    }
  );

  server.registerTool(
    "list_bookmarks",
    {
      title: "List Bookmarks",
      description:
        "Lists all saved bookmarks by number and description. Call this before restore_to_bookmark so you can tell the player which numbers exist and ask which one to restore to. No parameters.",
      inputSchema: z.object({}),
    },
    async () => {
      const out = handleListBookmarks(db);
      return { content: [{ type: "text" as const, text: JSON.stringify(out) }] };
    }
  );

  const RestoreToBookmarkSchema = z.object({
    bookmark_number: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Which bookmark to restore to (1-based number from list_bookmarks). If omitted, the tool returns an error suggesting the caller use list_bookmarks."),
    confirm: z
      .boolean()
      .optional()
      .describe("Set to true to perform the restore. First call without confirm returns a warning; then call again with confirm: true to proceed."),
  });

  server.registerTool(
    "restore_to_bookmark",
    {
      title: "Restore to Bookmark",
      description:
        "Rolls the world back to a chosen bookmark. You must specify bookmark_number (use list_bookmarks to see numbers). Restoring wipes out all progress and bookmarks after that point. First call returns a confirmation warning; call again with confirm: true to perform the restore. If the player says 'restore' or 'go back' without specifying which bookmark, return an error and suggest they run list_bookmarks and choose a number.",
      inputSchema: RestoreToBookmarkSchema,
    },
    async (args: unknown) => {
      const parsed = RestoreToBookmarkSchema.safeParse(args ?? {});
      const data = parsed.success ? parsed.data : {};
      const bookmarkNumber = data.bookmark_number;
      const confirm = data.confirm === true;
      const out = handleRestoreToBookmark(db, bookmarkNumber, confirm);
      return { content: [{ type: "text" as const, text: JSON.stringify(out) }] };
    }
  );

  server.registerTool(
    "update_node_adjectives",
    {
      title: "Update Node Adjectives",
      description:
        "When your narration implies a state or disposition change for an NPC or entity (e.g. Ciaran becomes less guarded, torch extinguished), call this to sync the engine so future turns see the updated state. Use the exact node_id from the last take_turn response's scene_node_ids (e.g. torch_01, ciaran, player)—not display names like 'torch'. Pass the full list of adjectives that now describe that entity. New adjectives get definitions automatically.",
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
