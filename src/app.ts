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
  handleVersion,
  handleGetScene,
  handleSetNodeAdjectives,
  handleMoveEntity,
  handleSealPassage,
  handleEvaluateConsequences,
  handleCreateNode,
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
    "version",
    {
      title: "Version",
      description:
        "Returns TaleShed build/version information: package semver and the timestamp of the latest git commit (committer date, ISO 8601)—a practical stand-in for last push when the server runs from a clone. No parameters.",
      inputSchema: z.object({}),
    },
    async () => {
      const out = handleVersion();
      return { content: [{ type: "text" as const, text: JSON.stringify(out) }] };
    }
  );

  server.registerTool(
    "take_turn",
    {
      title: "Take Turn",
      description:
        "DEPRECATED — do not call this tool for new turns. Use the new turn sequence instead: get_scene → narrate → set_node_adjectives / move_entity → evaluate_consequences (optional). take_turn remains available only for legacy fallback; prefer the new tools for all gameplay.",
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
        "DEPRECATED — use set_node_adjectives instead. set_node_adjectives is a direct replacement with the same semantics but with dark-location protection, proper history ledgering, and vocabulary integration built in. Do not call update_node_adjectives for new turns.",
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

  server.registerTool(
    "set_node_adjectives",
    {
      title: "Set Node Adjectives",
      description: `Replaces the complete adjective list for any node. Call this after every adjective change your narrative creates — the new list becomes the authoritative state for that node.

Pass the full intended list, not a delta. Omitting an adjective removes it; including a new one adds it.

Use node_ids exactly as returned by get_scene (entities[], inventory[], or "player").

VOCABULARY: Every adjective you set should appear in get_scene's vocabulary[] or be a term you are introducing via evaluate_consequences. Follow each adjective's rule_description — the rules are authoritative.

PROTECTION: "dark" on location nodes is authoring-only. The server silently preserves or omits it regardless of what you pass — never attempt to add or remove "dark" from a location.

NEGATION: To remove a state, omit the adjective — do not add negation terms (e.g. pass [] to clear "locked", not ["unlocked"]).`,
      inputSchema: z.object({
        node_id: z.string().describe("Exact node_id of the entity to update (e.g. door_01, ciaran, torch_01, player)."),
        adjectives: z.array(z.string()).describe("Complete new adjective list for this node. Replaces the previous list entirely."),
      }),
    },
    async (args: unknown) => {
      const schema = z.object({ node_id: z.string(), adjectives: z.array(z.string()) });
      const parsed = schema.safeParse(args);
      if (!parsed.success) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: parsed.error.message }) }] };
      }
      const out = handleSetNodeAdjectives(db, parsed.data);
      return { content: [{ type: "text" as const, text: JSON.stringify(out) }] };
    }
  );

  server.registerTool(
    "move_entity",
    {
      title: "Move Entity",
      description: `Moves any non-location entity to a new parent node. Handles all transfers:

- Player moves between locations: entity_id "player", destination = location node_id
- Taking an object: entity_id = object node_id, destination = "player"
- Dropping an object: entity_id = object node_id, destination = current location node_id
- Putting in a container: entity_id = object node_id, destination = container node_id
- Giving to an NPC: entity_id = object node_id, destination = NPC node_id

Both entity_id and destination_id must be valid node_ids in the world_graph. The player may only be moved to location nodes. Locations themselves cannot be moved.

When moving the player, the server automatically records the previous location so dark-room entrance tracking works correctly.`,
      inputSchema: z.object({
        entity_id: z.string().describe("node_id of the entity to move. Must not be a location. Use 'player' to move the player."),
        destination_id: z.string().describe("node_id of the destination — a location, container object, NPC, or 'player' for inventory. Must exist in the world_graph."),
      }),
    },
    async (args: unknown) => {
      const schema = z.object({ entity_id: z.string(), destination_id: z.string() });
      const parsed = schema.safeParse(args);
      if (!parsed.success) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: parsed.error.message }) }] };
      }
      const out = handleMoveEntity(db, parsed.data);
      return { content: [{ type: "text" as const, text: JSON.stringify(out) }] };
    }
  );

  server.registerTool(
    "seal_passage",
    {
      title: "Seal Passage",
      description: `Permanently removes an exit from a location's topology. Use only when a passage is physically and irreversibly destroyed — a tunnel collapse, a wall bricked over, a doorway sealed with stone.

This is permanent within the current game session. It cannot be undone except by restoring a bookmark.

To block a passage temporarily (locked door, portcullis, jammed gate), use set_node_adjectives on the door object instead — the exit stays in the topology, only the door's state changes.

exit_target is the node_id of the destination the exit connects to (e.g. "kitchen"). Use the target values from get_scene's location.exits[].`,
      inputSchema: z.object({
        location_id: z.string().describe("node_id of the location whose exit should be removed."),
        exit_target: z.string().describe("node_id of the destination the exit connects to. Must match a target in that location's exits list."),
      }),
    },
    async (args: unknown) => {
      const schema = z.object({ location_id: z.string(), exit_target: z.string() });
      const parsed = schema.safeParse(args);
      if (!parsed.success) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: parsed.error.message }) }] };
      }
      const out = handleSealPassage(db, parsed.data);
      return { content: [{ type: "text" as const, text: JSON.stringify(out) }] };
    }
  );

  server.registerTool(
    "evaluate_consequences",
    {
      title: "Evaluate Consequences",
      description: `Call this after committing primary state changes (set_node_adjectives, move_entity) to ask Mistral whether anything else in the scene should change as a result, and to define any new vocabulary terms.

Mistral receives a short focused prompt — the action description, the current scene state, and the existing vocabulary. It returns cascade adjective changes for other entities and definitions for new terms. Both are automatically applied and ledgered before this tool returns.

WHEN TO CALL:
- After lighting or extinguishing a light source (other entities may react)
- After significant NPC interactions where mood or disposition might ripple
- After environmental changes that could affect other entities (door broken, passage sealed)
- When introducing a new adjective term that needs a vocabulary definition
- You do NOT need to call this for simple movement, taking, or dropping unless there is a clear reason something else would change

action_description: a plain English summary of what just happened and what primary changes were committed. Be specific — this is the only context Mistral has.
affected_node_ids: optional list of node_ids that were directly changed. Helps Mistral focus on what to cascade from.
proposed_adjectives: optional new adjective terms you want defined and added to vocabulary. Mistral writes the rule; the server inserts it.

The primary action is already committed before this is called. If Mistral is unavailable, this returns empty results and the turn continues normally.`,
      inputSchema: z.object({
        action_description: z
          .string()
          .describe("Plain English summary of what just happened and what primary state changes were committed. E.g. 'Player lit the torch. torch_01 adjectives set to [lit]. The scriptorium is now illuminated.'"),
        affected_node_ids: z
          .array(z.string())
          .optional()
          .describe("node_ids that were directly changed this turn (e.g. ['torch_01', 'scriptorium']). Helps Mistral focus cascade reasoning."),
        proposed_adjectives: z
          .array(z.string())
          .optional()
          .describe("New adjective terms to define and add to vocabulary (e.g. ['grateful', 'illuminated']). Mistral writes a one-sentence rule for each; the server inserts them."),
      }),
    },
    async (args: unknown) => {
      const schema = z.object({
        action_description: z.string(),
        affected_node_ids: z.array(z.string()).optional(),
        proposed_adjectives: z.array(z.string()).optional(),
      });
      const parsed = schema.safeParse(args);
      if (!parsed.success) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ cascade_changes_applied: [], vocabulary_added: [], error: parsed.error.message }) }],
        };
      }
      const out = await handleEvaluateConsequences(db, parsed.data);
      return { content: [{ type: "text" as const, text: JSON.stringify(out) }] };
    }
  );

  server.registerTool(
    "get_scene",
    {
      title: "Get Scene",
      description: `Returns the complete authoritative world state for the current player location. Call this at the start of every player turn before narrating or deciding anything.

TURN SEQUENCE — follow this order every turn:
1. Call get_scene. Read everything it returns before you write a single word of narration.
2. Narrate the result of the player's action, grounded entirely in what get_scene returned.
3. Commit all changes: call set_node_adjectives for every adjective change, move_entity for every movement or object transfer. The rule is absolute — if your narrative created or changed something, it must be written back before the turn ends.
4. Optionally call evaluate_consequences if the action could ripple outward (a torch lit, a door broken, an NPC's mood shifted). Skip it for simple movement or object transfers with no side effects.

RESPONSE FIELDS:
- location: where the player is, with adjectives and exits
- entities[]: every NPC and object present — EXHAUSTIVE. What is not listed does not exist this turn.
- player: current adjectives and location
- inventory[]: what the player is carrying, with adjectives
- vocabulary[]: every adjective in the world and its rule — these rules are authoritative
- recent_history[]: last few player commands
- darkness_active: true when the location has the authored "dark" adjective AND no lit object is present in the room or inventory. "dark" is set only in the authoring tool — it means this location has no ambient light and cannot be described without a light source. Never add or remove "dark" from a location via set_node_adjectives. When darkness_active is true, narrate only impenetrable darkness and the exit the player came from; nothing else is visible.

GROUND RULES:
- Entity list is exhaustive: do not invent people, objects, or exits not in entities[].
- Adjectives are the governing language of world state. Read them to know what is true; write them back to make changes permanent.
- Vocabulary rules are authoritative: when an adjective applies to a node, follow what its rule_description says.
- Creative liberties are welcome when narratively plausible and grounded in world state. A locked door may yield to termite-infested wood; a key cannot appear from nowhere.
- Whatever your narrative creates or changes must be committed. Narrating a change without writing it back is a contract violation.`,
      inputSchema: z.object({}),
    },
    async () => {
      const out = handleGetScene(db);
      return { content: [{ type: "text" as const, text: JSON.stringify(out) }] };
    }
  );

  server.registerTool(
    "create_node",
    {
      title: "Create Node",
      description: `Creates a new object or NPC node in the world graph and immediately places it in the scene. Use this when your narrative genuinely introduces a new entity — an apple that falls from a cloister tree, a rat that scurries from a broken wall, a note a monk produces from his robe.

Do NOT create nodes for things already in get_scene's entities[] or inventory[]. The entity must be narratively motivated: if you didn't just describe it appearing or being produced, it shouldn't be created.

After creation the node exists immediately. Call set_node_adjectives to set its state or move_entity to transfer it (e.g. into the player's inventory). It will appear in the next get_scene call.

node_type: "object" or "npc" only — locations are authored, not created mid-game.
name: display name (e.g. "Bruised Apple", "Frightened Rat").
base_description: one sentence used when describing the entity (e.g. "A small green apple, bruised from the fall.").
adjectives: initial adjectives — follow vocabulary rules. Never pass "dark".
location_id: where to place it. Defaults to the player's current location if omitted.
node_id: preferred node_id (e.g. "apple_01"). Server appends a suffix if it conflicts.`,
      inputSchema: z.object({
        node_type: z
          .enum(["object", "npc"])
          .describe('"object" or "npc". Locations cannot be created mid-game.'),
        name: z
          .string()
          .min(1)
          .describe('Display name for the new entity (e.g. "Bruised Apple", "Frightened Rat").'),
        base_description: z
          .string()
          .min(1)
          .describe("A short descriptive sentence for this entity, used when the scene describes it."),
        adjectives: z
          .array(z.string())
          .optional()
          .describe("Initial adjectives for the new node. Follow vocabulary rules."),
        location_id: z
          .string()
          .optional()
          .describe("node_id of where to place the entity. Defaults to the player's current location."),
        node_id: z
          .string()
          .optional()
          .describe('Preferred node_id (e.g. "apple_01"). A suffix is added automatically if it conflicts.'),
      }),
    },
    async (args: unknown) => {
      const schema = z.object({
        node_type: z.enum(["object", "npc"]),
        name: z.string().min(1),
        base_description: z.string().min(1),
        adjectives: z.array(z.string()).optional(),
        location_id: z.string().optional(),
        node_id: z.string().optional(),
      });
      const parsed = schema.safeParse(args);
      if (!parsed.success) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: parsed.error.message }) }],
        };
      }
      const out = handleCreateNode(db, parsed.data);
      return { content: [{ type: "text" as const, text: JSON.stringify(out) }] };
    }
  );

  return server;
}
