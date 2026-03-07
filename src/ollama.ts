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

function debugLog(label: string, payload: string) {
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

export interface MistralNodeImpact {
  node_id: string;
  prose_impact: string;
  adjectives_old: string[];
  adjectives_new: string[];
  /** Optional: move this object to another location; use "player_inventory" when the player takes it */
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
- You MUST return node_impacts with one entry for every node in the scene (the location, each entity in ENTITIES PRESENT, and the player). Use the exact node_id from CURRENT SCENE: the location's node_id (e.g. scriptorium), each entity's node_id (e.g. ciaran, torch_01), and "player". Do not use "location", "entities|name", or the character's name—only the exact node_id shown. The engine ignores any node_id that does not match; wrong node_ids mean state (e.g. Ciaran's adjectives) will never update. For each entry set adjectives_old to that node's current adjectives and adjectives_new to the state after this turn; if unchanged, set both to the same array. Never omit an entry or leave adjectives blank for a node that has adjectives. Keep narrative and state in sync: if your narrative_prose describes an NPC's disposition or attitude changing (e.g. "his guarded quality shifts", "something adjacent to warmth"), you MUST set that NPC's adjectives_new to reflect it (e.g. ["less guarded"]) so the engine state matches the story.
- You may add atmospheric room detail (shelves, curtain, etc.) for color, but such details are not manipulable: the player cannot take, use, or interact with anything that is not in ENTITIES PRESENT. Do not add any fire-producing detail (no brazier, candle, hearth, lamp, etc.) as set-dressing—only locations or objects that are explicitly in ENTITIES PRESENT can provide light or fire. Invented details are set-dressing only.

PLAYER INVENTORY AND SCENE ARE EXHAUSTIVE: The player has only the items in Inventory. The location and ENTITIES PRESENT are the only sources of tools, fire, light, or other means. Do not have the player use or produce anything not in Inventory or the scene (no pulling flint from a pocket, no "you find a way", no invented fire source).

When writing narrative_prose:
- You MUST mention the location, every entity in ENTITIES PRESENT, and every exit in EXITS FROM THIS LOCATION. Describe the location/room first, then each NPC by name, then each object, then the exits (direction and destination for each). For each object in the list, mention the object itself (e.g. "the torch", "an unlit torch in the bracket") so the player can refer to it (e.g. "take torch"). For each exit, give direction and where it leads (e.g. "To the east, a battered door leads to the kitchen") so the player can move. Do not describe only a container or fixture (e.g. "an empty torch bracket") when the entity list includes that object—if The Torch is listed, say where the torch is or that it is there, not only the bracket. Never add people or objects not in the list; never omit a listed entity or a listed exit.
- Do only what the user asked. Do not take extra actions on any item or object unless the user explicitly says to. If the user says "take X", only add X to inventory—do not also use it, light it, activate it, or otherwise change its state unless the user explicitly asks for that. If the user says "take X and go through door", do exactly those two things and nothing more.
- An action that requires a means (e.g. lighting something, opening a lock) is only possible if the means exists in inventory, the room (location), or entities (ENTITIES PRESENT). Do not allow outcomes that inventory, room, or entities would not support.
- If the player tries to take or use something not in ENTITIES PRESENT, the action fails.`;
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

ENTITIES PRESENT (this list is exhaustive — do not add any person or object not listed here). Your narrative_prose MUST mention each of these: the location and every entity below. For each object, mention the object itself (e.g. "the torch") so the player can take or use it—not only a fixture like "empty bracket" when the object (e.g. The Torch) is in the list.
`;
  for (const e of ctx.entities) {
    const adjList = Array.isArray(e.adjectives) ? e.adjectives : [];
    out += `- ${e.node_type} | ${e.node_id} | ${e.name} | adjectives: ${JSON.stringify(adjList)} | ${e.base_description}\n`;
    out += `  Recent history: ${e.recent_history.join(" ") || "(none)"}\n`;
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

function buildSectionE(playerCommand: string, locationExits: { label: string; target: string; direction?: string }[]): string {
  const exitLine =
    locationExits.length > 0
      ? `\nMOVEMENT: If the player goes through a door/exit, says a direction ("east", "go west"), or says they go back/return to a place ("go back to scriptorium"), set the player's new_location_id to the exact target node_id from EXITS (e.g. "kitchen", "scriptorium"). Apply every part of a compound command. Without the player's new_location_id the engine will not move them.\n`
      : "";
  return `PLAYER ACTION: ${playerCommand}
${exitLine}
CRITICAL — node_impacts must include ONE entry for EACH of: the location (node_id in CURRENT SCENE), every entity in ENTITIES PRESENT, and the player. For each entry: adjectives_old MUST be that node's current adjectives exactly as shown in CURRENT SCENE; adjectives_new MUST be the adjectives after this turn. If a node's adjectives do not change, set BOTH adjectives_old and adjectives_new to the same array (e.g. ciaran has ["guarded"] and stays guarded → adjectives_old: ["guarded"], adjectives_new: ["guarded"]). Never use [] for a node that currently has adjectives unless you are explicitly clearing them (then adjectives_old = current, adjectives_new = []). Empty [] when the node has adjectives will be ignored by the engine. If your narrative describes an NPC's demeanor or attitude shifting (e.g. less guarded, more receptive), set that NPC's adjectives_new to match (e.g. ["less guarded"]) so the engine state and the story stay in sync.

Return ONLY this JSON structure:
{
  "narrative_prose": "<string: describe location, EVERY entity (each NPC, each object e.g. the torch), EVERY exit (direction and destination); then what happened>",
  "action_result": "<success | failure | partial>",
  "node_impacts": [
    {
      "node_id": "<exact node_id from CURRENT SCENE: e.g. scriptorium, ciaran, torch_01, or player—never 'location' or 'entities|name'>",
      "prose_impact": "<string: what this node experienced>",
      "adjectives_old": ["<current adjectives for this node from CURRENT SCENE>"],
      "adjectives_new": ["<adjectives after this turn; same as adjectives_old if unchanged>"],
      "new_location_id": "<optional: \"player_inventory\" when player takes an object; when player goes through an exit MUST be the exit destination node_id; omit only if no move>"
    }
  ],
  "reconciliation_notes": "<string | null: any inconsistencies found between recent narration and world state>"
}`;
}

export function assemblePrompt(ctx: SceneContext, playerCommand: string, recentHistory: string): string {
  const sections = [
    buildSectionA(),
    buildSectionB(ctx.vocabulary),
    buildSectionC(ctx),
    buildSectionD(recentHistory),
    buildSectionE(playerCommand, ctx.locationExits ?? []),
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
 * Second call: fetch definitions for adjectives that appeared in the turn but are not in vocabulary.
 * Uses existing vocabulary so new terms can be defined in relation to them (e.g. "less guarded" given "guarded").
 * Definitions must be generic and transportable (apply to any node: location, object, NPC).
 * Returns array of { adjective, rule_description }; on parse failure or error returns [] so the turn is not broken.
 */
export async function fetchAdjectiveDefinitions(
  adjectives: string[],
  existingVocabulary: { adjective: string; rule_description: string }[]
): Promise<{ adjective: string; rule_description: string }[]> {
  if (adjectives.length === 0) return [];
  const terms = [...new Set(adjectives)].map((a) => a.trim()).filter(Boolean);
  if (terms.length === 0) return [];
  const vocabBlock =
    existingVocabulary.length > 0
      ? `EXISTING VOCABULARY (use these to define new terms in relation when appropriate, e.g. "less guarded" from "guarded"):\n${existingVocabulary.map((v) => `- ${v.adjective}: ${v.rule_description}`).join("\n")}\n\n`
      : "";
  const prompt = `You are defining game-state adjectives for a text adventure. These definitions are generic and transportable: they apply to any node (location, object, NPC). Do not refer to specific characters, places, or objects.

${vocabBlock}Define each NEW term below. For each term, provide exactly one sentence (rule_description) describing what this state means for the game. If a new term relates to an existing one above (e.g. "less guarded" given "guarded"), base the definition on that. Return ONLY a JSON array with one object per term. No other text.

NEW TERMS TO DEFINE: ${terms.join(", ")}

Return a JSON array. Example for two terms: [{"adjective": "dim", "rule_description": "Location has low light; sight-based actions may be harder."}, {"adjective": "less guarded", "rule_description": "NPC is somewhat cautious but more open than fully guarded; may share limited information."}]`;
  try {
    const responseText = await callOllama(prompt, "vocabulary definitions");
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
    return items
      .map((x) => ({
        adjective: typeof x.adjective === "string" ? String(x.adjective).trim().toLowerCase() : "",
        rule_description: typeof x.rule_description === "string" ? String(x.rule_description).trim() : "",
      }))
      .filter((x) => x.adjective.length > 0);
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
  recentHistory: string
): Promise<MistralResponse> {
  const prompt = assemblePrompt(ctx, playerCommand, recentHistory);
  const responseText = await callOllama(prompt);
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
