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
- There are exactly as many doors or passages as in EXITS FROM THIS LOCATION. One listed exit = one door. Do not add a "second door", "curtained door", "far wall door", or antechamber. If the player goes through the door, they go to the destination in the EXITS list (e.g. battered door -> kitchen). Do not invent new locations (antechamber, corridor, passage) — only locations in the world exist.
- When the player goes through an exit (e.g. "go through the door", "east", "go north", "leave"), you MUST include in node_impacts an entry for node_id "player" with new_location_id set to that exit's target. Use the exact target node_id from EXITS (e.g. kitchen), not a phrase like "the kitchen" or "The Kitchen"—the engine only accepts node_ids that exist. If the player says a direction (e.g. "east", "go north"), use the exit that has that direction. Otherwise the engine will not move the player.
- In narrative_prose, when describing the current location, tell the player the direction of each exit (e.g. "To the east, a battered door leads to the kitchen") so they can say "go east" or "east" to move.
- You MUST return node_impacts with one entry for every node in the scene (the location, each entity in ENTITIES PRESENT, and the player). For each entry set adjectives_old to that node's current adjectives and adjectives_new to the state after this turn; if unchanged, set both to the same array. Never omit an entry or leave adjectives blank for a node that has adjectives.
- You may add atmospheric room detail (shelves, curtain, etc.) for color, but such details are not manipulable: the player cannot take, use, or interact with anything that is not in ENTITIES PRESENT. Do not add any fire-producing detail (no brazier, candle, hearth, lamp, etc.) as set-dressing—only locations or objects that are explicitly in ENTITIES PRESENT can provide light or fire. Invented details are set-dressing only.

PLAYER INVENTORY AND SCENE ARE EXHAUSTIVE: The player has only the items in Inventory. The location and ENTITIES PRESENT are the only sources of tools, fire, light, or other means. Do not have the player use or produce anything not in Inventory or the scene (no pulling flint from a pocket, no "you find a way", no invented fire source).

When writing narrative_prose:
- Describe the location/room first, then who is here (only NPCs from the list, by name), then notable objects (only objects from the list). Every NPC in ENTITIES PRESENT must be mentioned; never add extra people.
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

When assigning adjectives to nodes, use existing vocabulary terms where possible.
When the player's action causes a new state that has no existing vocabulary term, you MUST add it to new_adjectives so the engine can track it (e.g. something becomes lit, broken, open, wet, locked, extinguished — add {"adjective": "<word>", "rule_description": "<brief rule>"} for each such new term). new_adjectives may be [] only when nothing new is introduced; otherwise include every new state word you use in node_impacts.`;
}

function buildSectionC(ctx: SceneContext): string {
  const loc = ctx.location;
  const adj = Array.isArray(loc.adjectives) ? loc.adjectives : [];
  let out = `CURRENT SCENE:
Location: ${loc.node_id} — ${loc.name}
Description: ${loc.base_description}
Location adjectives: ${JSON.stringify(adj)}

ENTITIES PRESENT (this list is exhaustive — do not add any person or object not listed here):
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
    out += `\nEXITS FROM THIS LOCATION (only these exist; do not invent others). Each has an optional direction: use it to match "go east"/"north" and tell the player in your narration:\n`;
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
      ? `\nIf the player goes through a door/exit or says a direction (e.g. "east", "go north"), set node_impacts entry for node_id "player" with new_location_id set to the exact target from EXITS (e.g. "kitchen" not "the kitchen"). Match "east"/"go east" to the exit that has direction east. Without this the player will not move.\n`
      : "";
  return `PLAYER ACTION: ${playerCommand}
${exitLine}
CRITICAL — node_impacts must include ONE entry for EACH of: the location (node_id in CURRENT SCENE), every entity in ENTITIES PRESENT, and the player. For each entry: adjectives_old MUST be that node's current adjectives exactly as shown in CURRENT SCENE; adjectives_new MUST be the adjectives after this turn. If a node's adjectives do not change, set both to the same array (e.g. scriptorium stays ["dark"] → adjectives_old: ["dark"], adjectives_new: ["dark"]). Never leave adjectives_old or adjectives_new as [] for a node that currently has adjectives unless you are explicitly removing them (then adjectives_old = current, adjectives_new = []).

Return ONLY this JSON structure:
{
  "narrative_prose": "<string: prose description of what happened, for Claude to use>",
  "action_result": "<success | failure | partial>",
  "node_impacts": [
    {
      "node_id": "<string: location node_id, or entity node_id, or \"player\">",
      "prose_impact": "<string: what this node experienced>",
      "adjectives_old": ["<current adjectives for this node from CURRENT SCENE>"],
      "adjectives_new": ["<adjectives after this turn; same as adjectives_old if unchanged>"],
      "new_location_id": "<optional: \"player_inventory\" when player takes an object; when player goes through an exit MUST be the exit destination node_id; omit only if no move>"
    }
  ],
  "new_adjectives": [
    {"adjective": "<lowercase word>", "rule_description": "<one sentence rule for this state>"}
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

export async function callOllama(prompt: string): Promise<string> {
  if (DEBUG) {
    debugLog("Ollama request", `POST ${OLLAMA_BASE}/api/generate\nmodel: ${OLLAMA_MODEL}\n\n--- prompt ---\n${prompt}\n--- end prompt ---`);
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
      if (DEBUG) debugLog("Ollama response (error)", `${res.status} ${text}`);
      throw new Error(`Ollama HTTP ${res.status}: ${text}`);
    }
    const data = (await res.json()) as { response?: string; error?: string };
    if (data.error) {
      if (DEBUG) debugLog("Ollama response (error)", data.error);
      throw new Error(data.error);
    }
    const responseText = data.response ?? "";
    if (DEBUG) {
      debugLog("Ollama response", responseText);
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
  "new_adjectives",
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
  return parsed as unknown as MistralResponse;
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
