/**
 * Ollama API and Mistral prompt assembly.
 * Spec Section 4.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEBUG_LOG_PATH = path.join(__dirname, "..", "taleshed-errors.log");
const DEBUG =
  process.env["TALESHED_DEBUG"] === "1" || process.env["TALESHED_DEBUG"] === "true";

export function debugLog(label: string, payload: string) {
  if (!DEBUG) return;
  const line = `[${new Date().toISOString()}] [DEBUG] ${label}\n${payload}\n`;
  try {
    fs.appendFileSync(DEBUG_LOG_PATH, line);
  } catch (_) {}
}

const OLLAMA_BASE = process.env["OLLAMA_BASE"] ?? "http://localhost:11434";
const OLLAMA_MODEL = process.env["OLLAMA_MODEL"] ?? "mistral";
const OLLAMA_TIMEOUT_MS = 30_000;

export interface VocabularyItem {
  adjective: string;
  rule_description: string;
}

export interface SceneEntity {
  node_id: string;
  node_type: string;
  name: string;
  base_description: string;
  adjectives: string[];
  recent_history: string[];
  /** When set, this entity is inside another (e.g. object in a container). Use so narrative does not describe the container as empty. */
  location_id?: string | null;
}

export interface LocationExit {
  label: string;
  target: string;
  /** Cardinal direction for this exit (north/south/east/west); used so the model can tell the player and match "go east" etc. */
  direction?: string;
}

export interface SceneContext {
  location: SceneEntity;
  entities: SceneEntity[];
  player: SceneEntity;
  inventoryNodeIds: string[];
  vocabulary: VocabularyItem[];
  locationExits: LocationExit[];
}

/** Destination scene when the player command is movement: location + entities + exits at the target. Used so narrative can describe arrival. */
export interface DestinationScene {
  location: SceneEntity;
  entities: SceneEntity[];
  exits: LocationExit[];
}

export interface MistralNodeImpact {
  node_id: string;
  prose_impact: string;
  adjectives_old: string[];
  adjectives_new: string[];
  /** Optional: move this object to another location; use the player node_id (e.g. "player") when the player takes it */
  new_location_id?: string | null;
}

export interface MistralNewAdjective {
  adjective: string;
  rule_description: string;
}

export interface MistralResponse {
  narrative_prose: string;
  action_result: "success" | "failure" | "partial";
  node_impacts: MistralNodeImpact[];
  new_adjectives: MistralNewAdjective[];
  reconciliation_notes: string | null;
}

function buildSectionA(): string {
  return `You are a game master for a text-based interactive fiction engine.
Your job is to determine what happens in the world when the player takes an action.
You must return ONLY valid JSON. No prose outside the JSON structure.
You must return exactly the fields described below and nothing else.

CRITICAL — THE ENTITY LIST IS EXHAUSTIVE:
- Do not invent new locations, rooms, doors, exits, or passages. Only the location and entities explicitly listed in CURRENT SCENE exist.
- Do not invent any person not in ENTITIES PRESENT. No "two monks", "a figure", "someone at the table", "a cook", or other characters. If only one NPC is listed, there is exactly one NPC. If no NPCs are listed for a location, the room has no other people.
- Do not invent any object not in ENTITIES PRESENT. No poker, trapdoor, seam in the floor, or other props unless they appear in the list. If the kitchen (or any location) has no object entities listed, there are no takeable or notable objects there beyond what the location description states.
- If the scene lists no exits, this location has no exits. Never describe or imply a door, corridor, or room that is not in the entity list.
- There are exactly as many doors or passages as in EXITS FROM THIS LOCATION. One listed exit = one door. Do not add a "second door", "curtained door", "far wall door", "doorway north", or antechamber. Do not describe or mention any door or direction not in EXITS—e.g. if EXITS list only "west -> scriptorium", there is no north door; say only what exists. If the player goes through the door, they go to the destination in the EXITS list. Do not invent new locations (antechamber, corridor, passage) — only locations in the world exist.
- When the player goes through an exit (e.g. "go through the door", "east", "go north", "leave"), goes back, returns, or goes to a named place (e.g. "go back to scriptorium", "go west"), you MUST include in node_impacts an entry for node_id "player" with new_location_id set to the destination's node_id (from EXITS: e.g. kitchen, scriptorium). Use the exact target node_id from EXITS (e.g. kitchen), not a phrase like "the kitchen" or "The Kitchen"—the engine only accepts node_ids that exist. If the player says a direction (e.g. "east", "go north"), use the exit that has that direction. Compound commands (e.g. "take torch and go through door") require every part to be applied: do the take AND set the player's new_location_id to the exit target so the engine actually moves them. Otherwise the engine will not move the player.
- In narrative_prose, you MUST also describe the exits. For each exit in EXITS FROM THIS LOCATION, tell the player the direction and where it goes (e.g. "To the east, a battered door leads to the kitchen") so they can say "go east" or "east" to move. Do not omit exits. Mention only the exits listed—no extra doors or directions.
- You MUST return node_impacts with one entry for every node in the scene (the location, each entity in ENTITIES PRESENT, and the player). Use the exact node_id from CURRENT SCENE: the location's node_id (e.g. scriptorium), each entity's node_id (e.g. ciaran, torch_01), and "player". Do not use "location", "entities|name", or the character's name—only the exact node_id shown. The engine ignores any node_id that does not match; wrong node_ids mean state (e.g. Ciaran's adjectives) will never update. For each entry set adjectives_old to that node's current adjectives and adjectives_new to the state after this turn. Do not change adjectives unless the player's action involved that node and the narrative describes the change (e.g. player talked to Ciaran and he became less guarded); for entering, looking, or movement-only commands, keep adjectives_new equal to adjectives_old for all nodes. Never omit an entry or leave adjectives blank for a node that has adjectives.
- You may add atmospheric room detail (shelves, curtain, bench, etc.) as scenery for color. Do not add any fire-producing detail (no brazier, candle, hearth, lamp, etc.) as set-dressing—only locations or objects that are explicitly in ENTITIES PRESENT can provide light or fire.

SCENERY (atmospheric detail not in ENTITIES PRESENT):
- The player may interact with scenery for narrative-only actions: sit on a bench, lean against the wall, look at the curtain, etc. Narrate the action and optionally give the player a transient adjective (e.g. "sitting") for consistency; no other node in the world changes. Scenery cannot be taken, destroyed, moved, or used to affect the world—no taking the curtain, no burning the bench. If the player tries to take, use, destroy, or otherwise change scenery, the action fails (e.g. "You cannot take the bench; it is fixed to the room.").

CRITICAL — WHAT THE PLAYER CAN INTERACT WITH:
- For actions that change world state (take, use, talk to, destroy, move): the player can only do these with (1) the current location, (2) entities listed in ENTITIES PRESENT (in the player's current location or inside a not-closed container there), or (3) items in the player's Inventory. People and objects in other locations are not present and cannot be seen, heard, or interacted with.
- If the player tries to take, use, talk to, or otherwise change something (or someone) not in ENTITIES PRESENT and not in Inventory (e.g. "talk to Ciaran" or "say hello to Ciaran" while in the kitchen when Ciaran is in the scriptorium and not listed in ENTITIES PRESENT), the action FAILS. You MUST return action_result "failure", narrative_prose that states the person or thing is not here (e.g. "Ciaran is not in this room. You are in the kitchen; he is in the scriptorium."). Do NOT narrate the interaction as if it happened. Do NOT add a node_impacts entry for the absent character or object — node_impacts must contain ONLY the location (current scene), each entity in ENTITIES PRESENT, and the player. The engine will ignore any node_id not in the current scene; never move or change someone in another location.

PLAYER INVENTORY AND SCENE ARE EXHAUSTIVE: The player has only the items in Inventory. Only objects whose node_id is in the player's Inventory are carried or held by the player; objects listed in ENTITIES PRESENT but not in Inventory are in the location (the room), not in the player's hands. Do not describe the player as holding or carrying something unless it is in Inventory. The location and ENTITIES PRESENT are the only sources of tools, fire, light, or other means. Do not have the player use or produce anything not in Inventory or the scene (no pulling flint from a pocket, no "you find a way", no invented fire source).

When writing narrative_prose:
- You MUST mention the location, every entity in ENTITIES PRESENT, and every exit in EXITS FROM THIS LOCATION. Describe the location/room first, then each NPC by name, then each object, then the exits (direction and destination for each). For each object in the list, mention the object itself (e.g. "the torch", "an unlit torch in the bracket") so the player can refer to it (e.g. "take torch"). For each exit, give direction and where it leads (e.g. "To the east, a battered door leads to the kitchen") so the player can move. Where an entity line shows "contains: X", that container has X inside—follow the CONTAINMENT RULE (see below); never describe that container as empty. Never add people or objects not in the list; never omit a listed entity or a listed exit.

CRITICAL — DO NOT TAKE UNSPECIFIED ACTIONS:
- Interpret the player's action literally. Do only the exact action(s) the player stated. Do not infer, assume, or add any action the player did not explicitly request.
- "Take X" means only: add X to the player's inventory. In node_impacts, the entry for the taken object (e.g. torch_01) MUST have new_location_id set to the player's node_id (e.g. "player")—the engine moves the object by this field. Do NOT add an adjective to the object to indicate inventory (e.g. do not use "in player's inventory", "carried", or similar); use new_location_id only. It does NOT mean use X, light X, activate X, open X, or change X's state in any way. Example: if the player says "take torch", the torch's node_impact has new_location_id: "player" and adjectives_new unchanged; the torch remains unlit.
- For any object: taking it does not imply using it. Using, lighting, activating, opening, or otherwise changing an object's state requires an explicit player command for that action. One verb = one action. "Take torch and go through door" = take (inventory) + move; the torch is still unlit unless the player also said to light it.
- If the player's command has multiple parts (e.g. "take X and go through door"), perform exactly those parts and no others. Do not add a third action (e.g. lighting the torch) because it would be "helpful" or "realistic"—only the player can request that.

CRITICAL — NO THINGS HAPPENING "BY THEMSELVES":
- Objects and the world do NOT change state on their own. Nothing may light, ignite, catch fire, activate, open, close, unlock, or otherwise change (e.g. unlit → lit) unless the player explicitly performed an action that causes that change (e.g. "light the torch", "use the key").
- FORBIDDEN in narrative: having a torch (or lamp, candle, etc.) light "of its own accord", "by the logic of this world", "apparently of its own accord", "it catches", "a flame shivers to life", or any wording that implies the object changed state without the player doing something to cause it. If the player only took the torch, the torch stays unlit in their hand until they say they light it (and only then if a means exists in the scene).
- Do not use narrative convenience or atmosphere as a reason for state change. "It would be dramatic", "the scene needed light", or "it felt right" are not allowed. State changes require an explicit player action for that change.

- An action that requires a means (e.g. lighting something, opening a lock) is only possible if the means exists in inventory, the room (location), or entities (ENTITIES PRESENT). The location's description is part of the room: if it states there is fire, light, or a tool (e.g. "A fire burns in the hearth" in the kitchen), the player may use it (e.g. light the torch at the kitchen fire). Do not allow outcomes that inventory, room, or entities would not support.
- If the player tries to take, use, talk to, destroy, or move something (or someone) not in ENTITIES PRESENT and not in Inventory, the action fails—unless the action is scenery-only (e.g. sit on the bench, lean on the wall), in which case allow it with no node impact (or only a player adjective). The target is not in the room; do not narrate success or bring that person or object into the scene.`;
}

function buildSectionB(vocabulary: VocabularyItem[]): string {
  const vocabJson = JSON.stringify(
    vocabulary.map((v) => ({ adjective: v.adjective, rule_description: v.rule_description }))
  );
  return `VOCABULARY (adjectives and their rules):
${vocabJson}

When assigning adjectives to nodes, use existing vocabulary terms where possible. You may use new adjectives in adjectives_new if the story calls for it; the engine will define any new terms separately.`;
}

function buildSectionC(ctx: SceneContext): string {
  const loc = ctx.location;
  const adj = Array.isArray(loc.adjectives) ? loc.adjectives : [];
  let out = `CURRENT SCENE:
Location: ${loc.node_id} — ${loc.name}
Description: ${loc.base_description}
Location adjectives: ${JSON.stringify(adj)}

ENTITIES PRESENT (this list is exhaustive — do not add any person or object not listed here). These are the only people and objects the player can take, use, talk to, or otherwise affect this turn: they are in the player's current location or inside a not-closed container here. Anyone or anything in another location is not present. (The player may still interact with scenery—atmospheric detail—for narrative-only actions like sitting or leaning, with no world-state impact.) Your narrative_prose MUST mention each of these: the location and every entity below. Where an entity line shows "contains: X", follow the CONTAINMENT RULE after this list—state what is inside; never describe that container as empty. For each object, mention the object itself (e.g. "the torch") so the player can take or use it. If an object is listed here (e.g. torch_01), the room HAS that object: never say it is absent or missing.
`;
  const containedBy = new Map<string, string[]>();
  for (const e of ctx.entities) {
    const locId = e.location_id ?? null;
    if (locId != null && locId !== loc.node_id) {
      const list = containedBy.get(locId) ?? [];
      list.push(e.node_id);
      containedBy.set(locId, list);
    }
  }
  for (const e of ctx.entities) {
    const adjList = Array.isArray(e.adjectives) ? e.adjectives : [];
    const inside =
      e.location_id != null && e.location_id !== loc.node_id ? ` | inside: ${e.location_id}` : "";
    const containsList = containedBy.get(e.node_id);
    const contains =
      containsList != null && containsList.length > 0 ? ` | contains: ${containsList.join(", ")}` : "";
    out += `- ${e.node_type} | ${e.node_id} | ${e.name} | adjectives: ${JSON.stringify(adjList)} | ${e.base_description}${inside}${contains}\n`;
    out += `  Recent history: ${e.recent_history.join(" ") || "(none)"}\n`;
  }
  const hasContainers = containedBy.size > 0;
  if (hasContainers) {
    out += `\nCONTAINMENT RULE (mandatory): Entities above that show "contains: X" have X inside them. In narrative_prose you MUST state what is inside (e.g. "the bracket holds the torch", "an unlit torch sits in the bracket"). FORBIDDEN for those containers: "empty", "no torch rests in it", "waiting", "expectant", "nothing in it", "bare", "vacant". The "contains" field is authoritative—ignore any base_description that could suggest otherwise.\n`;
  }
  out += `\nPLAYER:\n`;
  const playerAdj = Array.isArray(ctx.player.adjectives) ? ctx.player.adjectives : [];
  out += `- node_id: player | location: ${(ctx.player as { location_id?: string }).location_id ?? "?"} | adjectives: ${JSON.stringify(playerAdj)}\n`;
  out += `  Inventory: ${JSON.stringify(ctx.inventoryNodeIds)}\n`;
  out += `  Recent history: ${ctx.player.recent_history.join(" ") || "(none)"}\n`;
  const exits = ctx.locationExits ?? [];
  if (exits.length === 0) {
    out += `\nEXITS FROM THIS LOCATION: (none)\n`;
  } else {
    out += `\nEXITS FROM THIS LOCATION (only these exist; do not invent others). Your narrative_prose MUST describe each exit below—direction and where it leads (e.g. "To the east, a battered door leads to the kitchen") so the player can move:\n`;
    for (const e of exits) {
      const dirPart = e.direction ? ` [${e.direction}]` : "";
      out += `  - ${e.label}${dirPart} -> ${e.target}\n`;
    }
  }
  return out;
}

function buildSectionD(recentHistory: string): string {
  return `RECENT NARRATION (last several exchanges as provided by Claude — use this to keep tone and facts consistent):
${recentHistory || "(none)"}

Check: does the recent narration describe anything inconsistent with the current world state above? If so, note corrections in your response.`;
}

function buildSectionDestination(dest: DestinationScene): string {
  let out = `DESTINATION (the player is moving here — you MUST describe this in narrative_prose after they leave):
Location: ${dest.location.node_id} — ${dest.location.name}
Description: ${dest.location.base_description}
Location adjectives: ${JSON.stringify(dest.location.adjectives ?? [])}
`;
  if (dest.entities.length > 0) {
    out += `Entities present at destination (describe each in your narrative after the move):\n`;
    for (const e of dest.entities) {
      const adjList = Array.isArray(e.adjectives) ? e.adjectives : [];
      out += `- ${e.node_type} | ${e.node_id} | ${e.name} | adjectives: ${JSON.stringify(adjList)} | ${e.base_description}\n`;
    }
  } else {
    out += `Entities present at destination: (none)\n`;
  }
  if (dest.exits.length > 0) {
    out += `Exits from destination: ${dest.exits.map((e) => `${e.direction ?? "?"} -> ${e.target}`).join("; ")}\n`;
  } else {
    out += `Exits from destination: (none)\n`;
  }
  out += `
When the player's action is movement, your narrative_prose MUST: (1) briefly describe leaving the current location; (2) describe the destination as the player sees it on arrival — the location name and description, every entity listed above, and every exit. Do not end with the player merely exiting; continue into the new room and describe what they see (as if the player had also said "look").`;
  return out;
}

function buildSectionE(
  ctx: SceneContext,
  playerCommand: string,
  locationExits: { label: string; target: string; direction?: string }[],
  destinationScene?: DestinationScene | null
): string {
  const loc = ctx.location;
  const containedBy = new Map<string, string[]>();
  for (const e of ctx.entities) {
    const locId = e.location_id ?? null;
    if (locId != null && locId !== loc.node_id) {
      const list = containedBy.get(locId) ?? [];
      list.push(e.node_id);
      containedBy.set(locId, list);
    }
  }
  const containmentLine =
    containedBy.size > 0
      ? `Containment in this scene: ${Array.from(containedBy.entries())
          .map(([container, contents]) => `${container} contains ${contents.join(", ")}`)
          .join("; ")}. Do not describe these containers as empty in narrative_prose.\n`
      : "";
  const exitLine =
    locationExits.length > 0
      ? `\nMOVEMENT (required when player moves): If the player's action is to go through the door, go through door, leave, or use a direction ("east", "go west", etc.), you MUST set the player's new_location_id to that exit's target node_id in the player's node_impacts entry. Example: one exit "east -> kitchen" and player says "go through door" → set player new_location_id to "kitchen". Without this field the engine does not move the player. Exits here: ${locationExits.map((e) => `${e.direction ?? "?"} -> ${e.target}`).join("; ")}.\n`
      : "";
  const destinationLine =
    destinationScene != null
      ? `\n${buildSectionDestination(destinationScene)}\n`
      : "";
  return `PLAYER ACTION: ${playerCommand}
START/BEGIN: If the player said "start" or "begin", only describe the scene. Do NOT have the player take, use, or move any object. Do NOT set new_location_id for any object. No state changes.
${containmentLine}TAKE: If the player takes an object, set that object's new_location_id to the player's node_id (e.g. "player") in its node_impacts entry. Do not add adjectives to the object (e.g. "in player's inventory"); the engine uses new_location_id to move the object. The player's own new_location_id is only for movement—set it only to a location node_id from EXITS (e.g. kitchen), never to an object (e.g. torch_01). The object moves to the player; the player stays in a location.
Interpret the above literally. Do only what the player said—no extra actions (e.g. do not light a torch if the player only said "take torch"). Never have objects change state on their own: no torch lighting by itself, no "it catches", "of its own accord", or "by the logic of this world"—only an explicit player action (e.g. "light the torch") can change an object's state.
${exitLine}${destinationLine}
CRITICAL — node_impacts must include ONE entry for EACH of: the location (node_id in CURRENT SCENE), every entity in ENTITIES PRESENT, and the player — and NO OTHER node_ids. If the player tried to interact with someone or something not in ENTITIES PRESENT and not in Inventory (e.g. "say hello to Ciaran" while in the kitchen and Ciaran is not listed), the action fails: return action_result "failure", say in narrative_prose that they are not here, and include in node_impacts ONLY the location, ENTITIES PRESENT, and player — never add an entry for a character or object in another location. For each entry: adjectives_old MUST be that node's current adjectives exactly as shown in CURRENT SCENE; adjectives_new MUST be the adjectives after this turn. DO NOT change a node's adjectives unless the player's action directly involved that node and your narrative explicitly describes a change in that node's state. For "start", "look", "examine", "go east" (movement only), or any action that does not interact with an NPC or object: set adjectives_new equal to adjectives_old for every node—no NPC becomes "less guarded" or "more friendly" just because the player entered or looked. Only change adjectives when the player did something to or with that node (e.g. talked to the NPC, used the object) and the narrative shows the change. If a node's adjectives do not change, set BOTH adjectives_old and adjectives_new to the same array. Never use [] for a node that currently has adjectives unless you are explicitly clearing them.

Return ONLY this JSON structure:
{
  "narrative_prose": "<string: describe location, EVERY entity, EVERY exit; then what happened. If 'Containment in this scene' appears above, those containers are NOT empty—state what is inside each (e.g. 'the X holds the Y'). Never describe a listed container as empty.>",
  "action_result": "<success | failure | partial>",
  "node_impacts": [
    {
      "node_id": "<exact node_id from CURRENT SCENE: e.g. scriptorium, ciaran, torch_01, or player—never 'location' or 'entities|name'>",
      "prose_impact": "<string: what this node experienced>",
      "adjectives_old": ["<current adjectives for this node from CURRENT SCENE>"],
      "adjectives_new": ["<adjectives after this turn; same as adjectives_old if unchanged>"],
      "new_location_id": "<optional: for a TAKEN object set to the player node_id e.g. \"player\"; for MOVEMENT (go through door, east, etc.) set the player entry's new_location_id to the exit target e.g. \"kitchen\"—required or the player will not move; omit only if no take and no move>"
    }
  ],
  "reconciliation_notes": "<string | null: any inconsistencies found between recent narration and world state>"
}`;
}

export function assemblePrompt(
  ctx: SceneContext,
  playerCommand: string,
  recentHistory: string,
  destinationScene?: DestinationScene | null
): string {
  const sections = [
    buildSectionA(),
    buildSectionB(ctx.vocabulary),
    buildSectionC(ctx),
    buildSectionD(recentHistory),
    buildSectionE(ctx, playerCommand, ctx.locationExits ?? [], destinationScene),
  ];
  return sections.join("\n\n");
}

export async function callOllama(prompt: string, logLabel?: string): Promise<string> {
  const label = logLabel ? ` (${logLabel})` : "";
  if (DEBUG) {
    debugLog(`Ollama request${label}`, `POST ${OLLAMA_BASE}/api/generate\nmodel: ${OLLAMA_MODEL}\n\n--- prompt ---\n${prompt}\n--- end prompt ---`);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt,
        stream: false,
        format: "json",
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) {
      const text = await res.text();
      if (DEBUG) debugLog(`Ollama response${label} (error)`, `${res.status} ${text}`);
      throw new Error(`Ollama HTTP ${res.status}: ${text}`);
    }
    const data = (await res.json()) as { response?: string; error?: string };
    if (data.error) {
      if (DEBUG) debugLog(`Ollama response${label} (error)`, data.error);
      throw new Error(data.error);
    }
    const responseText = data.response ?? "";
    if (DEBUG) {
      debugLog(`Ollama response${label}`, responseText);
    }
    return responseText;
  } catch (err) {
    clearTimeout(timeout);
    if (DEBUG) {
      debugLog(
        `Ollama response${label} (exception)`,
        err instanceof Error ? err.message : String(err)
      );
    }
    if (err instanceof Error) {
      if (err.name === "AbortError") throw new Error("Ollama timeout (30s)");
      throw err;
    }
    throw err;
  }
}

const REQUIRED_JSON_FIELDS = [
  "narrative_prose",
  "action_result",
  "node_impacts",
  "reconciliation_notes",
] as const;

/** Try to extract a JSON object from model output (handles markdown code blocks and leading/trailing prose). */
function extractJsonString(raw: string): string {
  const trimmed = raw.trim();
  // Markdown code block: ```json ... ``` or ``` ... ```
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (codeBlockMatch) {
    const inner = codeBlockMatch[1].trim();
    const start = inner.indexOf("{");
    const end = inner.lastIndexOf("}") + 1;
    if (start >= 0 && end > start) return inner.slice(start, end);
    return inner;
  }
  // Plain text: first { to last }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}") + 1;
  if (start >= 0 && end > start) return trimmed.slice(start, end);
  return trimmed;
}

/** Extract a JSON array from model output (code block or raw [...]). Returns null if no array found. */
function extractJsonArrayString(raw: string): string | null {
  const trimmed = raw.trim();
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  const inner = codeBlockMatch ? codeBlockMatch[1].trim() : trimmed;
  const start = inner.indexOf("[");
  const end = inner.lastIndexOf("]") + 1;
  if (start >= 0 && end > start) return inner.slice(start, end);
  return null;
}

/** Extract a single JSON object from model output (first { to last }). Returns null if none. */
function extractSingleJsonObjectString(raw: string): string | null {
  const trimmed = raw.trim();
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  const inner = codeBlockMatch ? codeBlockMatch[1].trim() : trimmed;
  const start = inner.indexOf("{");
  const end = inner.lastIndexOf("}") + 1;
  if (start >= 0 && end > start) return inner.slice(start, end);
  return null;
}

/**
 * Before adding new vocabulary: check if any candidate adjective is redundant with an existing term.
 * Returns a Map from candidate (lowercase) to the term to use—either the existing vocabulary term
 * (exact match from the list) or the candidate itself if it is truly new.
 */
export async function resolveRedundantAdjectives(
  candidates: string[],
  existingVocabulary: { adjective: string }[]
): Promise<Map<string, string>> {
  if (candidates.length === 0 || existingVocabulary.length === 0) {
    const m = new Map<string, string>();
    candidates.forEach((c) => {
      const k = c.trim().toLowerCase();
      if (k) m.set(k, c.trim());
    });
    return m;
  }
  const terms = [...new Set(candidates)].map((c) => c.trim()).filter(Boolean);
  if (terms.length === 0) return new Map();
  const vocabList = existingVocabulary.map((v) => v.adjective.trim()).filter(Boolean);
  const vocabLower = new Set(vocabList.map((v) => v.toLowerCase()));
  const prompt = `You are normalizing game-state adjectives for a text adventure.

EXISTING VOCABULARY (use these exact spellings when replacing):
${vocabList.map((a) => `- ${a}`).join("\n")}

CANDIDATE TERMS (these are not in the vocabulary yet; some may be redundant with existing terms above):
${terms.join(", ")}

For each candidate term: if it has the same or very similar meaning to an existing vocabulary term, respond with that existing term exactly as listed above. Otherwise respond with the candidate unchanged (the game will define it as new).

CRITICAL: Return a JSON object with one key per candidate. Keys must be the candidate terms exactly as written above. Values must be EITHER (1) an existing vocabulary term from the list above—exact spelling—OR (2) the candidate itself unchanged. Do not invent new terms (e.g. "not_in_vocabulary" is wrong). Example: {"content": "settled", "warm": "warm"} if "content" is redundant with "settled" and "warm" is new.

Return ONLY the JSON object. No other text.`;
  if (DEBUG) {
    debugLog(
      "resolveRedundantAdjectives request",
      `candidates: ${terms.join(", ")}\nvocabulary (${vocabList.length} terms): ${vocabList.join(", ")}`
    );
  }
  const logLabel = "resolve redundant adjectives";
  try {
    const responseText = await callOllama(prompt, logLabel);
    if (DEBUG) debugLog("resolveRedundantAdjectives reply (raw)", responseText);
    const objStr = extractJsonString(responseText);
    if (!objStr || !objStr.trimStart().startsWith("{")) return new Map();
    const parsed = JSON.parse(objStr) as Record<string, unknown>;
    const result = new Map<string, string>();
    for (const candidate of terms) {
      const key = candidate.toLowerCase();
      const keyUnderscore = candidate.replace(/\s+/g, "_");
      const keyUnderscoreLower = keyUnderscore.toLowerCase();
      const raw =
        parsed[candidate] ??
        parsed[key] ??
        parsed[keyUnderscore] ??
        parsed[keyUnderscoreLower];
      const value = raw != null && typeof raw === "string" ? String(raw).trim() : "";
      const valueLower = value.toLowerCase();
      if (value && vocabLower.has(valueLower)) {
        const existing = vocabList.find((v) => v.toLowerCase() === valueLower)!;
        result.set(key, existing);
      } else {
        result.set(key, candidate.trim());
      }
    }
    if (DEBUG) {
      const summary = Object.fromEntries(result);
      debugLog("resolveRedundantAdjectives result", JSON.stringify(summary, null, 2));
    }
    return result;
  } catch (err) {
    if (DEBUG) debugLog("resolveRedundantAdjectives error", err instanceof Error ? err.message : String(err));
    const fallback = new Map<string, string>();
    terms.forEach((c) => {
      const k = c.trim().toLowerCase();
      if (k) fallback.set(k, c.trim());
    });
    return fallback;
  }
}

/**
 * Second call: fetch definitions for adjectives that appeared in the turn but are not in vocabulary.
 * Uses existing vocabulary so new terms can be defined in relation to them (e.g. "less guarded" given "guarded").
 * Definitions must be generic and transportable (apply to any node: location, object, NPC).
 * Returns array of { adjective, rule_description }; on parse failure or error returns [] so the turn is not broken.
 */
export async function fetchAdjectiveDefinitions(
  adjectives: string[],
  existingVocabulary: { adjective: string; rule_description: string }[],
  callSource?: string,
  allowFallback = true
): Promise<{ adjective: string; rule_description: string }[]> {
  if (adjectives.length === 0) return [];
  const terms = [...new Set(adjectives)].map((a) => a.trim()).filter(Boolean);
  if (terms.length === 0) return [];
  const logLabel = callSource ? `vocabulary definitions (${callSource})` : "vocabulary definitions";
  const vocabBlock =
    existingVocabulary.length > 0
      ? `EXISTING VOCABULARY (use these to define new terms in relation when appropriate, e.g. "less guarded" from "guarded"):\n${existingVocabulary.map((v) => `- ${v.adjective}: ${v.rule_description}`).join("\n")}\n\n`
      : "";
  const termList = terms.join(", ");
  const prompt = `You are defining game-state adjectives for a text adventure. These definitions are generic and transportable: they apply to any node (location, object, NPC). Do not refer to specific characters, places, or objects.

${vocabBlock}Define each NEW term below. For each term, provide exactly one sentence (rule_description) describing what this state means for the game. If a new term relates to an existing one above (e.g. "less guarded" given "guarded"), base the definition on that.

CRITICAL: The "adjective" field in each object must be exactly one of the terms listed in NEW TERMS TO DEFINE—copy the term word-for-word. Do not substitute a synonym or different phrasing.

CRITICAL: You MUST return one object for EVERY term. There are ${terms.length} terms below. Your response must be a JSON array containing exactly ${terms.length} objects—one per term. Returning only one object or fewer than ${terms.length} is wrong.

NEW TERMS TO DEFINE: ${termList}

Return ONLY a JSON array with one object per term. No other text. Example format (use your actual terms, not these): [{"adjective": "dim", "rule_description": "Location has low light; sight-based actions may be harder."}, {"adjective": "tense", "rule_description": "Atmosphere is charged with conflict or unease; NPCs may be quick to react."}]`;
  if (DEBUG) {
    debugLog(
      `fetchAdjectiveDefinitions request${callSource ? ` (${callSource})` : ""}`,
      `terms: ${termList}\nexisting vocabulary count: ${existingVocabulary.length}`
    );
  }
  try {
    const responseText = await callOllama(prompt, logLabel);
    let items: Record<string, unknown>[] = [];
    const arrayStr = extractJsonArrayString(responseText);
    if (arrayStr !== null) {
      const parsed = JSON.parse(arrayStr);
      if (Array.isArray(parsed)) {
        items = parsed.filter((x): x is Record<string, unknown> => x != null && typeof x === "object");
      }
    }
    if (items.length === 0) {
      const objStr = extractSingleJsonObjectString(responseText);
      if (objStr !== null) {
        const single = JSON.parse(objStr) as Record<string, unknown>;
        if (single != null && typeof single === "object" && typeof single.adjective === "string") {
          items = [single];
        }
      }
    }
    const result = items
      .map((x) => ({
        adjective: typeof x.adjective === "string" ? String(x.adjective).trim().toLowerCase() : "",
        rule_description: typeof x.rule_description === "string" ? String(x.rule_description).trim() : "",
      }))
      .filter((x) => x.adjective.length > 0);
    // If the model returned fewer definitions than terms, fetch each missing term in its own request (one term = one object, which models handle reliably).
    const definedLower = new Set(result.map((r) => r.adjective));
    const missing = terms.filter((t) => !definedLower.has(t.trim().toLowerCase()));
    if (allowFallback && missing.length > 0) {
      if (DEBUG) debugLog("fetchAdjectiveDefinitions", `Got ${result.length}/${terms.length} definitions; fetching missing one-by-one: ${missing.join(", ")}`);
      const extra: { adjective: string; rule_description: string }[] = [];
      for (const term of missing) {
        const one = await fetchAdjectiveDefinitions([term], existingVocabulary, callSource, false);
        extra.push(...one);
      }
      return [...result, ...extra];
    }
    return result;
  } catch (err) {
    if (DEBUG) debugLog("fetchAdjectiveDefinitions error", err instanceof Error ? err.message : String(err));
    return [];
  }
}

function parseJsonResponse(responseText: string): MistralResponse {
  const jsonStr = extractJsonString(responseText);
  if (!jsonStr.trimStart().startsWith("{")) {
    throw new Error("No JSON object in response");
  }
  const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
  for (const key of REQUIRED_JSON_FIELDS) {
    if (!(key in parsed)) throw new Error(`Missing required field: ${key}`);
  }
  const actionResult = parsed.action_result as string;
  if (!["success", "failure", "partial"].includes(actionResult)) {
    throw new Error(`Invalid action_result: ${actionResult}`);
  }
  const nodeImpacts = parsed.node_impacts as MistralNodeImpact[];
  if (!Array.isArray(nodeImpacts) || nodeImpacts.length === 0) {
    throw new Error("node_impacts must be a non-empty array");
  }
  const rawNewAdjs = (parsed as Record<string, unknown>).new_adjectives;
  const new_adjectives: MistralNewAdjective[] = Array.isArray(rawNewAdjs)
    ? rawNewAdjs
        .filter((x): x is Record<string, unknown> => x != null && typeof x === "object")
        .map((x) => ({
          adjective: typeof x.adjective === "string" ? String(x.adjective).trim() : "",
          rule_description: typeof x.rule_description === "string" ? String(x.rule_description).trim() : "",
        }))
        .filter((x) => x.adjective.length > 0)
    : [];
  return { ...parsed, new_adjectives } as unknown as MistralResponse;
}

/** When the model returns plain prose instead of JSON, coerce it into a valid response so the game continues. */
function proseFallback(ctx: SceneContext, responseText: string): MistralResponse {
  const location = ctx.location;
  const adj = Array.isArray(location.adjectives) ? location.adjectives : [];
  return {
    narrative_prose: responseText.trim() || "Something happens.",
    action_result: "partial",
    node_impacts: [
      {
        node_id: location.node_id,
        prose_impact: responseText.trim() || "No change.",
        adjectives_old: adj,
        adjectives_new: adj,
      },
    ],
    new_adjectives: [],
    reconciliation_notes: null,
  };
}

export async function runMistralTurn(
  ctx: SceneContext,
  playerCommand: string,
  recentHistory: string,
  destinationScene?: DestinationScene | null
): Promise<MistralResponse> {
  const prompt = assemblePrompt(ctx, playerCommand, recentHistory, destinationScene);
  const responseText = await callOllama(prompt, "turn");
  try {
    return parseJsonResponse(responseText);
  } catch {
    return proseFallback(ctx, responseText);
  }
}

export async function checkOllamaReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`, { method: "GET" });
    return res.ok;
  } catch {
    return false;
  }
}
