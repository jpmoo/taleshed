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
/** Model name used for Ollama generate calls; exported so startup log can show it when DEBUG=1. */
export const OLLAMA_MODEL = process.env["OLLAMA_MODEL"] ?? "mistral-nemo";
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
  /** Direction for this exit (north/south/east/west/up/down etc.); used so the model can tell the player and match "go east", "down", etc. */
  direction?: string;
}

export interface SceneContext {
  location: SceneEntity;
  entities: SceneEntity[];
  player: SceneEntity;
  inventoryNodeIds: string[];
  /** Inventory items with adjectives so the model can preserve state (e.g. lit torch). */
  inventoryEntities?: SceneEntity[];
  vocabulary: VocabularyItem[];
  locationExits: LocationExit[];
  /** When true, location is dark with no light; prompt must show only darkness and the entrance exit (if any). */
  darkActive?: boolean;
}

/** Destination scene when the player command is movement: location + entities + exits at the target. Used so narrative can describe arrival. */
export interface DestinationScene {
  location: SceneEntity;
  entities: SceneEntity[];
  exits: LocationExit[];
  /** When true, destination is dark with no light; prompt must describe only darkness and the single exit (way back). */
  darkActive?: boolean;
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

The entities, exits, and adjectives listed below are the authoritative world state. Do not infer or invent entities not listed. You are encouraged to flesh out story and scenery—atmospheric detail, sensory description, narrative flourish—within those bounds.

Do not invent items that can provide light or fire. Only ENTITIES PRESENT may contain lamps, oil lamps, candles, torches, tapers, hearths, or braziers—never add them as scenery (even "unlit" or "cold"). Scenery you may add: furniture, decorations, sensory detail (e.g. table, bench, curtain, dust, parchment, inkwell) that cannot be lit and are not in ENTITIES PRESENT.

CRITICAL — THE ENTITY LIST IS EXHAUSTIVE:
- Do not invent new locations, rooms, doors, exits, or passages. Only the location and entities explicitly listed in CURRENT SCENE exist.
- Do not invent any person not in ENTITIES PRESENT. No "two monks", "a figure", "someone at the table", "a cook", or other characters. If only one NPC is listed, there is exactly one NPC. If no NPCs are listed for a location, the room has no other people.
- Do not invent any object not in ENTITIES PRESENT. No poker, trapdoor, seam in the floor, oil lamp, candle, torch, or other props unless they appear in the list. If the kitchen (or any location) has no object entities listed, there are no takeable or notable objects there beyond what the location description states.
- In Location and entity descriptions, only **bold** text denotes game entities (objects, NPCs, exits). Everything not in bold is scenery—atmospheric detail only. Do not treat non-bold mentions (e.g. bookshelf, table, papers, candle, door in prose) as entities; the only entities that exist are those listed in ENTITIES PRESENT by node_id. Bold in descriptions marks what is an entity; non-bold is never takeable or usable.
- If the scene lists no exits, this location has no exits. Never describe or imply a door, corridor, or room that is not in the entity list.
- There are exactly as many doors or passages as in EXITS FROM THIS LOCATION. One listed exit = one door. Do not add a "second door", "curtained door", "far wall door", "doorway north", or antechamber. Do not describe or mention any door or direction not in EXITS—e.g. if EXITS list only "west -> scriptorium", there is no north door; say only what exists. If the player goes through the door, they go to the destination in the EXITS list. Do not invent new locations (antechamber, corridor, passage) — only locations in the world exist.
- When the player goes through an exit (e.g. "go through the door", "east", "go north", "leave"), goes back, returns, or goes to a named place (e.g. "go back to scriptorium", "go west"), you MUST include in node_impacts an entry for node_id "player" with new_location_id set to the destination's node_id (from EXITS: e.g. kitchen, scriptorium). CURRENT SCENE is where the player is now; the exit target is where they go. Your narrative must describe leaving the current location and arriving at the destination—do not reverse (e.g. do not say they leave the destination or arrive in the current location). Use the exact target node_id from EXITS (e.g. kitchen), not a phrase like "the kitchen" or "The Kitchen"—the engine only accepts node_ids that exist. If the player says a direction (e.g. "east", "go north"), use the exit that has that direction. Compound commands (e.g. "take torch and go through door") apply only when the player actually said both parts: then do the take AND set the player's new_location_id to the exit target. If the player only said one part (e.g. just "east" or just "take torch"), do only that one—do not add a take because they moved, and do not add a move because they took something. Otherwise the engine will not move the player.
- In narrative_prose, you MUST explicitly describe EVERY exit in EXITS FROM THIS LOCATION (at least label and direction; you need not state the destination/target) so the player can move—except when the location has the \"dark\" adjective and there is no light source: then you may describe ONLY the single exit used to enter (the way back); do not describe other exits. When not dark, it is an error to omit, summarize, or hint at an exit instead of naming it. The location Description may mention doors in passing (e.g. "a battered door leads out"); the authoritative source for which door goes which direction and where is EXITS FROM THIS LOCATION—use only the exit list. Each exit line is "label [direction] -> target": in your narrative include at least the label and direction; including the target (e.g. "to the kitchen") is optional. For example, if the list has "battered door [east] -> kitchen" and "heavy wooden door braced in iron [north] -> cloister", then the battered door leads east to the kitchen and the heavy door leads north to the cloister—do not swap labels with directions (e.g. do not say the battered door leads north). You MUST mention each one—never say "no exits" or "no obvious exits" if the list has exits. Describe every exit in the list, including exits with direction \"up\" or \"down\" (e.g. steps down to the cellar); do not omit an exit because the destination might be dark or because it is a vertical direction. When the current room is not dark, all listed exits are visible and must be described. Mention only the listed exits—no extra doors or directions.
- You MUST return node_impacts with one entry for the location, each entity in ENTITIES PRESENT, each item in Inventory (see PLAYER/Inventory—preserve adjectives unless this turn changes them), and the player. Use the exact node_id from CURRENT SCENE: the location's node_id (e.g. scriptorium), each entity's node_id (e.g. ciaran, torch_01), each inventory node_id, and "player". Do not use "location", "entities|name", or the character's name—only the exact node_id shown. The engine ignores any node_id that does not match; wrong node_ids mean state (e.g. Ciaran's adjectives) will never update. For each entry set adjectives_old to that node's current adjectives and adjectives_new to the state after this turn. Never omit an entry or leave adjectives blank for a node that has adjectives.
- adjectives_old and adjectives_new must contain ONLY persistent, game-affecting qualities (disposition: guarded, hostile; object/location state: lit, closed, locked). Never use a location name as an adjective. FORBIDDEN in adjectives_new: momentary actions, one-off observations, or transient states (e.g. "noticed looking up", "looking up", "observed", "currently observing", "engrossed in work", "noticed the player")—put these in prose_impact only. Adjectives must be from VOCABULARY and must describe how the node persistently interacts with the player or world; if the only change is a momentary action (looked up, nodded), keep adjectives_new equal to adjectives_old. Do not invent new adjective phrases—use only existing vocabulary terms.
- When your narrative explicitly describes a change in an NPC's disposition or attitude (e.g. they warm up, smile, become less guarded, show trust, relax), you MUST set that NPC's adjectives_new to reflect that state. If you describe them as no longer guarded, remove "guarded" from adjectives_new or add an appropriate term; if you describe them as pleased or open, add or adjust adjectives accordingly. The engine only persists what you put in adjectives_new—so if your prose says Ciaran "allows himself a faint smile" and "is genuinely pleased" but you leave adjectives_new as ["guarded"], the next turn will still show him as guarded. adjectives_new must match the state your narrative describes. For entering, looking, or movement-only commands (no interaction with an NPC or object), keep adjectives_new equal to adjectives_old for all nodes.
- For NPCs, dispositional adjectives (e.g. guarded, hostile) must not be dropped when you add physical or other descriptive adjectives (e.g. portly, rosy-cheeked). Keep all dispositional adjectives from adjectives_old in adjectives_new unless your narrative explicitly describes a change in disposition (e.g. they warm up and are no longer guarded). Adding appearance or other traits is fine; do not do it at the expense of existing disposition.
- You may add atmospheric scenery: furniture, decorations, and lively detail (e.g. shelves, curtain, bench, dust motes, worn stone) that do not allow substantive interaction—no taking, using, or affecting world state. Scenery is for color only; the player can reference it for narrative-only actions (sit on a bench, lean on the wall). DEFINITIVELY FORBIDDEN in scenery or narrative: any light source, fire, or flame not listed in ENTITIES PRESENT. Do not add a hearth, brazier, candle, lamp, oil lamp, taper, torch (unless in the list), or any glowing/burning thing; only entities explicitly in ENTITIES PRESENT may be candles, torches, or lamps—do not invent one "as scenery" even if you describe it as unlit or cold. Only entities in ENTITIES PRESENT may provide light or fire. If the location has no such entity, the room has no invented light—describe grey light from windows, dimness, or darkness as the location allows, but never invent a fire, lamp, or candle.
- FORBIDDEN in narrative_prose: mentioning fire, flame, or any light source (hearth, brazier, candle, lamp, oil lamp, etc.) unless that object is listed in ENTITIES PRESENT. If the current location has no such entity, do not write that the room has a fire, a lamp, or that something "casts light"—only entities in ENTITIES PRESENT can be light sources.
- Object light state is from adjectives only. For any object that can be lit (torch, candle, lamp, taper, etc.): if its adjectives do NOT include "lit", you MUST describe it as unlit—not burning, not providing light, not "burns brightly" or "casting light". Only if the entity's adjectives include "lit" may you describe it as burning, lit, or providing light.

SCENERY (atmospheric detail not in ENTITIES PRESENT):
- Scenery is only non-light, non-takeable detail: furniture, decorations, sensory detail (e.g. bench, curtain, bookcase, armchair, dust, cold tea, pens, parchment) that the player cannot take or use to affect world state. You may add only such scenery. FORBIDDEN as scenery: any lamp, oil lamp, candle, torch, taper, hearth, brazier, or other light-capable or fire-capable object—only ENTITIES PRESENT may contain those; do not add one "as scenery" even if unlit or cold. Flesh out the scene with story and sensory detail within that limit; only **bold** text in Location/entity descriptions marks entities. Non-bold is scenery. Narrative-only interaction with scenery is fine (sit, lean, look). If the player tries to take or use scenery, the action fails (e.g. "You cannot take the bench; it is fixed to the room.").

CRITICAL — WHAT THE PLAYER CAN INTERACT WITH:
- The player can only take, use, talk to, destroy, or move (1) the current location, (2) entities in ENTITIES PRESENT, or (3) items in Inventory. People and objects elsewhere are not present. If the player tries to interact with something or someone not in ENTITIES PRESENT and not in Inventory, the action FAILS: return action_result "failure", narrative_prose stating they are not here (e.g. "Ciaran is not in this room."). Do NOT narrate the interaction as if it happened; do not narrate success or bring the absent person or object into the scene. node_impacts must contain the location, each entity in ENTITIES PRESENT, each item in Inventory, and the player—no entry for an absent character or object (the engine ignores any other node_id). Exception: scenery-only actions (e.g. sit on a bench, lean on the wall) are allowed with no or minimal node impact.

PLAYER INVENTORY AND SCENE ARE EXHAUSTIVE: The player has only the items in Inventory. Only objects whose node_id is in the player's Inventory are carried or held by the player; objects listed in ENTITIES PRESENT but not in Inventory are in the location (the room), not in the player's hands. Do not describe the player as holding or carrying something unless it is in Inventory. The location and ENTITIES PRESENT are the only sources of tools, fire, light, or other means. Do not have the player use or produce anything not in Inventory or the scene (no pulling flint from a pocket, no "you find a way", no invented fire source).

DARK (location adjective, authoring-only—never add in game): "dark" is set at authoring; when there is no light source on the player or in the room, the engine makes it a completely overriding condition (ENTITIES PRESENT empty, only the entrance exit). If you see "dark" on the location and ENTITIES PRESENT is empty (or the prompt says "DARK SCENE"), describe ONLY impenetrable darkness and that single visible exit. Do not describe or imply the room, other exits, people, or objects—the scene cannot support that; the player sees nothing. Never add or remove "dark" from the location's adjectives_new; the engine preserves it and negates it only when a light source is present.

When writing narrative_prose:
- Describe the location (use its Description), every entity in ENTITIES PRESENT (you MUST name each NPC and mention each object—e.g. Brother Ciarán, the torch bracket, the torch), and every exit. You may add non-interactive scenery (furniture, decorations, lively detail) for atmosphere; scenery cannot be taken or used to affect world state. DEFINITIVELY FORBIDDEN: any fire, flame, or light source not in ENTITIES PRESENT (no oil lamp, candle, hearth, brazier, or "the room is lit by X" unless X is in the list). For objects that can be lit (torch, candle, lamp): if the entity's adjectives do not include "lit", describe them as unlit only—never as burning or providing light. Do not replace or omit the listed entities with a different scene. Do not add candles, torches, or lamps that are not in ENTITIES PRESENT (no "unlit candle on the wall" or similar invented light-capable objects). Describe only what exists; do not use narrative self-corrections (e.g. "X flickers — no, wait, it doesn't") for invented details—if it's not in ENTITIES PRESENT, do not mention it at all.
- You MUST mention the location, every entity in ENTITIES PRESENT, and every exit in EXITS FROM THIS LOCATION—except when the location is dark with no light source (DARK SCENE), in which case describe only the single exit used to enter (the way back). Describe the location/room first, then each NPC by name, then each object, then the exits (label and direction for each; destination/target optional). Every NPC in ENTITIES PRESENT must be named and appear in your narrative—never omit a character who is present. If ENTITIES PRESENT lists only the location (no other entities), do not describe any people or objects—there are none here; describe only the location and every exit. For "look", "start", or "begin", give a full scene description that includes each person and object by name. For each object in the list, mention the object itself (e.g. "the torch", "an unlit torch in the bracket") so the player can refer to it (e.g. "take torch"). For each exit, use the exact label and direction from the list: e.g. if the list says "battered door [east] -> kitchen", describe that as the battered door leading east to the kitchen; if it says "heavy wooden door braced in iron [north] -> cloister", describe that as the heavy door leading north to the cloister. Do not swap or mix up which door goes which direction. Where an entity line shows "contains: X", that container has X inside—follow the CONTAINMENT RULE (see below); never describe that container as empty. Never add people or objects not in the list; never omit a listed entity or a listed exit.

CRITICAL — LITERAL ACTIONS ONLY (no extra, no implied):
- Do only the exact action(s) the player stated. Do not infer, add, or assume actions (e.g. do not light something if the player only said "take X"; do not open/give if they only offered "shall I?" or "want me to?"). Compound commands (e.g. "take X and go through door") = perform exactly those parts when the player said both; no third action—do not add one (e.g. lighting the torch) because it would be "helpful" or "realistic". If the player only said one action (e.g. just "east" or just "take torch"), do only that one; only the player can request that.
- Offering or asking is not doing. If the player only offers or asks (e.g. "offer to light the torch", "shall I open the door?"), narrate the offer and the response only; do NOT perform the action or change any object's/location's state (lit, open, unlocked, etc.)—only an explicit command does that.
- Movement is NOT a take. When the player only moves (e.g. "east", "go through the door", "north", "leave", "go to kitchen"), do NOT set new_location_id to "player" for any object; do NOT write "The player now holds the X" or "Taken by player." for any object; objects stay where they are. The player only acquires an object when they explicitly said to take it (e.g. "take torch", "get the key").
- "Take X" = add X to inventory only. Set new_location_id to "player" in the **taken object's** entry ONLY when the player's command was explicitly to take that object (e.g. "take torch", "get the torch")—do NOT set it for look, examine, apologize, talk, movement only, or because your narrative describes the player holding something; only an explicit take command moves an object. When the player takes something that is inside a container (e.g. "take torch" when the torch is in a bracket), set new_location_id to "player" only for the taken object (the torch), not for the container (the bracket); the container stays in place. If the player did not say to take an object (e.g. they said "apologize to Ciaran", "look", "go east", "east", "go through the door"), do NOT set new_location_id on any object; objects stay where they are. Without new_location_id on the taken object the engine will not move it. Do NOT put new_location_id on the player entry for a take (the player's new_location_id is only for movement to a location). Do NOT add an adjective to the object; use new_location_id only. Do NOT set new_location_id when the narrative has the object stay in place (e.g. lighting the torch in its bracket). Taking does not imply using: state changes (lit, open, unlocked, activated) require an explicit player command for that action. When the player does take an object and you set new_location_id to "player", use this exact wording only: in narrative_prose write "The player now holds the [object]." (e.g. "The player now holds the torch."); in that object's prose_impact write exactly "Taken by player." Do not use any other phrasing for the player taking or holding an object. If the player did NOT say to take something (e.g. they only talked, asked a question, looked, apologized, or only moved), do NOT write "The player now holds the [object]" or set prose_impact "Taken by player." for any object; leave new_location_id unset and do not imply a take in narrative.
- "Drop X" / "put down X" = set the dropped object's new_location_id to the **current location** (the location's node_id, e.g. kitchen). The object ends up in the room, on the ground. Do NOT set new_location_id to another entity (hearth, fire, table); only the current location is valid for a drop.
- "Put X in Y" / "place X in Y" = when the player puts an object (from Inventory) into a container (in ENTITIES PRESENT, e.g. a torch bracket), set that **object's** (X's) new_location_id to the **container's** node_id (e.g. bracket_01). The object leaves the player's inventory. Do NOT set the container's new_location_id to "player". Include an entry for the object (e.g. torch_01) with new_location_id set to the container (e.g. bracket_01); the container keeps its own entry with no new_location_id.
- NPCs cannot take or receive the player's items unless the player explicitly gives that item to that NPC (e.g. "give carrot to Ciaran", "give Ciaran the carrot"). If the player only talks about, offers, or mentions the item, the NPC may respond but does not take it; do NOT set that object's new_location_id to the NPC. Only an explicit give command moves the item to the NPC.

CRITICAL — STATE CHANGES ONLY BY EXPLICIT ACTION:
- Nothing may light, ignite, catch fire, activate, open, close, unlock, or otherwise change state unless the player explicitly performed an action that causes it (e.g. "light the torch", "use the key"). No object or location may change state on its own. FORBIDDEN in narrative: an object changing state "of its own accord", "by the logic of this world", "at the taking", "when you pick it up", "as you touch it", or similar—e.g. torch "comes alight at the taking" or "already alight", door "opens as you reach for it". When the player only TAKES an object, its state does not change—describe it keeping its current state until they explicitly perform the action that changes it. Do not use narrative convenience or atmosphere as a reason for state change ("It would be dramatic", "the scene needed light", "it felt right" are not allowed).
- A state-changing action (e.g. lighting, opening a lock) is only possible if the means exists in Inventory or ENTITIES PRESENT; scenery or location text alone is not enough. Do not allow outcomes the scene cannot support.
- When an entity's or another entity's description states a rule for what happens when something is used on it, placed in it, or otherwise interacts (e.g. \"if X then Y\"), apply that rule to the affected node: set adjectives_new to the full resulting state—remove any adjectives that no longer apply and add any that do. Use only vocabulary terms. Represent \"no longer X\" by omitting X from adjectives_new, not by adding a negation term (e.g. do not add \"unlit\").`;
}

function buildSectionB(vocabulary: VocabularyItem[]): string {
  const vocabJson = JSON.stringify(
    vocabulary.map((v) => ({ adjective: v.adjective, rule_description: v.rule_description }))
  );
  return `Prefer adjectives that already appear in the scene above or in the list below; propose new adjectives only when no existing term fits.

VOCABULARY (adjectives and their rules):
${vocabJson}

You MUST apply each adjective's rule_description when deciding what happens. The rules are authoritative—follow what each rule_description says. For example: if a rule says something provides light or illuminates, treat that as a light source where relevant; if it blocks passage or interaction until a key or action, treat it as blocking; if it describes an NPC's disposition, let that guide their behavior; if it describes object or location state, apply that. When assigning adjectives to nodes, use only vocabulary terms (or new terms the engine will define). Represent \"no longer X\" by omitting X from adjectives_new, not by adding a negation (e.g. do not add \"unlit\" or \"unlocked\").`;
}

function buildSectionC(ctx: SceneContext): string {
  const loc = ctx.location;
  const adj = Array.isArray(loc.adjectives) ? loc.adjectives : [];
  const locationDescription = ctx.darkActive
    ? "Impenetrable darkness. You can see nothing."
    : loc.base_description;
  let out = `CURRENT SCENE:
Location: ${loc.node_id} — ${loc.name}
Description: ${locationDescription}
Location adjectives: ${JSON.stringify(adj)}

ENTITIES PRESENT (authoritative world state for this turn; exhaustive — do not add any person or object not listed here). Only things in **bold** in the Location Description and in entity descriptions above are entities; everything else in those descriptions is scenery, not in this list. These are the only people and objects the player can take, use, talk to, or otherwise affect this turn: they are in the player's current location or inside a not-closed container here. Anyone or anything in another location is not present. (The player may still interact with scenery—atmospheric detail, non-bold text—for narrative-only actions like sitting or leaning, with no world-state impact.) Your narrative_prose MUST mention each of these: the location and every entity below. Every NPC in this list must be named and described in your narrative—do not skip or omit any character. Where an entity line shows "contains: X", follow the CONTAINMENT RULE after this list—state what is inside; never describe that container as empty. For each object, mention the object itself (e.g. "the torch") so the player can take or use it. If an object is listed here (e.g. torch_01), the room HAS that object: never say it is absent or missing.
`;
  if (ctx.darkActive) {
    out += `DARK SCENE (no light source): There are no entities visible. You MUST describe ONLY impenetrable darkness and the single visible exit (the way they entered). Do NOT describe the room, any objects, any other exits, or any detail—the scene cannot support that; the player sees nothing.\n`;
  }
  const containedBy = new Map<string, string[]>();
  for (const e of ctx.entities) {
    const locId = e.location_id ?? null;
    if (locId != null && locId !== loc.node_id) {
      const list = containedBy.get(locId) ?? [];
      list.push(e.node_id);
      containedBy.set(locId, list);
    }
  }
  const lightCapablePattern = /\b(torch|candle|lamp|taper)\b/i;
  for (const e of ctx.entities) {
    const adjList = Array.isArray(e.adjectives) ? e.adjectives : [];
    const locId = e.location_id ?? loc.node_id;
    const containsList = containedBy.get(e.node_id);
    const contains =
      containsList != null && containsList.length > 0 ? ` | contains: ${containsList.join(", ")}` : "";
    const isLightCapable = e.node_type === "object" && (lightCapablePattern.test(e.name) || lightCapablePattern.test(e.base_description ?? ""));
    const hasLit = adjList.some((a) => String(a).trim().toLowerCase() === "lit");
    const unlitHint = isLightCapable && !hasLit ? " [UNLIT—describe as unlit only; do NOT say burning, lit, or that it provides light]" : "";
    out += `- ${e.node_type} | ${e.node_id} | ${e.name} | location_id: ${locId} | adjectives: ${JSON.stringify(adjList)} | ${e.base_description}${contains}${unlitHint}\n`;
    out += `  Recent history: ${e.recent_history.join(" ") || "(none)"}\n`;
  }
  const hasContainers = containedBy.size > 0;
  if (hasContainers) {
    out += `\nCONTAINMENT RULE (mandatory): Entities above that show "contains: X" have X inside them. The "contains" and location_id fields are authoritative: if torch_01 has location_id: bracket_01 and bracket_01 shows contains: torch_01, the torch IS in the bracket—never say the bracket is empty, the torch is missing/invisible, or that the bracket contains nothing. In narrative_prose you MUST state what is inside (e.g. "the bracket holds the torch", "an unlit torch sits in the bracket"). FORBIDDEN for those containers: "empty", "an empty bracket", "empty torch bracket", "no torch rests in it", "waiting", "waiting for flame", "expectant", "nothing in it", "bare", "vacant", "containing nothing". Do not describe a container that has "contains:" as empty in any wording—state what is inside. Containers and their contents have separate descriptions: never apply the contained object's description or state to the container, and never apply the container's description to the contents. Each entity is described only by its own line in ENTITIES PRESENT.\n`;
  }
  out += `\nPLAYER:\n`;
  const playerAdj = Array.isArray(ctx.player.adjectives) ? ctx.player.adjectives : [];
  const playerLocId = (ctx.player as { location_id?: string }).location_id ?? "?";
  out += `- node_id: player | location_id: ${playerLocId} | adjectives: ${JSON.stringify(playerAdj)}\n`;
  if (ctx.inventoryEntities && ctx.inventoryEntities.length > 0) {
    out += `  Inventory (location_id: player; each item's adjectives must be preserved in node_impacts unless this turn changes them): ${ctx.inventoryEntities.map((e) => `${e.node_id} ${JSON.stringify(e.adjectives ?? [])}`).join("; ")}\n`;
  } else {
    out += `  Inventory (location_id: player): ${JSON.stringify(ctx.inventoryNodeIds)}\n`;
  }
  out += `  Recent history: ${ctx.player.recent_history.join(" ") || "(none)"}\n`;
  const exits = ctx.locationExits ?? [];
  if (exits.length === 0) {
    out += `\nEXITS FROM THIS LOCATION: (none)\n`;
  } else {
    out += `\nEXITS FROM THIS LOCATION (only these exist; do not invent others). Ignore any door or exit mentioned in the location Description above—this list is authoritative. Describe every exit below (at least label and direction; destination/target optional). Include up/down (e.g. steps down to cellar) when listed. Each line is "label [direction] -> target". Your narrative_prose MUST describe each exit (label and direction at minimum):\n`;
    for (const e of exits) {
      const dirPart = e.direction ? ` [${e.direction}]` : "";
      out += `  - ${e.label}${dirPart} -> ${e.target}\n`;
    }
    const exitList = exits.map((e) => `${e.label} ${e.direction ?? "?"}`).join("; ");
    out += `REQUIRED: Your narrative_prose must mention every exit above (at least label and direction for each; target/destination optional). Include at least: ${exitList}.\n`;
  }
  return out;
}

function buildSectionD(recentHistory: string): string {
  return `RECENT NARRATION (last several exchanges as provided by Claude — use this to keep tone and facts consistent):
${recentHistory || "(none)"}

Check: does the recent narration describe anything inconsistent with the current world state above? If so, note corrections in your response.`;
}

function buildSectionDestination(dest: DestinationScene): string {
  if (dest.darkActive) {
    let out = `DESTINATION is DARK (no light source). The player will see only impenetrable darkness and the single exit they came by.
You MUST describe ONLY: (1) briefly leaving the current location; (2) impenetrable darkness — they can see nothing; (3) the one visible exit (the way back). Do NOT describe the room, any objects, any other exits, or any detail that would require light to see.
`;
    if (dest.exits.length > 0) {
      out += `The only visible exit: ${dest.exits.map((e) => `${e.direction ?? "?"} to ${e.target}`).join("; ")}\n`;
    }
    return out;
  }
  let out = `DESTINATION (the player is moving HERE — they leave CURRENT SCENE and arrive here; narrate leaving the current location then describe this place; do not say they leave this destination or arrive in the current location):
Location: ${dest.location.node_id} — ${dest.location.name}
Description: ${dest.location.base_description}
Location adjectives: ${JSON.stringify(dest.location.adjectives ?? [])}
`;
  if (dest.entities.length > 0) {
    out += `Entities present at destination (describe each in your narrative after the move):\n`;
    for (const e of dest.entities) {
      const adjList = Array.isArray(e.adjectives) ? e.adjectives : [];
      const locId = e.location_id ?? dest.location.node_id;
      out += `- ${e.node_type} | ${e.node_id} | ${e.name} | location_id: ${locId} | adjectives: ${JSON.stringify(adjList)} | ${e.base_description}\n`;
    }
  } else {
    out += `Entities present at destination: (none)\n`;
  }
  if (dest.exits.length > 0) {
    out += `Exits from destination (label [direction] -> target; use exact pairing when describing): ${dest.exits.map((e) => `${e.label} [${e.direction ?? "?"}] -> ${e.target}`).join("; ")}\n`;
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
  const requiredNodeIds = [
    ...ctx.entities.map((e) => e.node_id),
    ...(ctx.inventoryNodeIds ?? []),
    "player",
  ].join(", ");
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
  const movementReminder =
    destinationScene != null
      ? `\n*** MOVEMENT — DO NOT REVERSE: The player is currently in ${loc.name} (CURRENT SCENE above). They are moving TO ${destinationScene.location.name}. Your narrative MUST describe (1) leaving ${loc.name}, then (2) arriving in ${destinationScene.location.name} and describe what they see there. Set the player's new_location_id to "${destinationScene.location.node_id}". Do NOT say they leave ${destinationScene.location.name} or arrive in ${loc.name}; that reverses the move. ***\n`
      : "";
  const exitLine =
    locationExits.length > 0
      ? `\nMOVEMENT (required when player moves): Set the player's new_location_id to the exit's target. If the player gives a direction (e.g. "east", "go north"), use the exit with that direction. If the player names a door (e.g. "go through battered door"), use the exit with that exact label—e.g. battered door -> kitchen, heavy wooden door -> cloister—do NOT use the other door's target. Without this field the engine does not move the player. Exits (label [direction] -> target): ${locationExits.map((e) => `${e.label ?? "?"} [${e.direction ?? "?"}] -> ${e.target}`).join("; ")}.\n`
      : "";
  const destinationLine =
    destinationScene != null
      ? `\n${buildSectionDestination(destinationScene)}\n`
      : "";
  const cmd = playerCommand.trim().toLowerCase();
  const isOfferOrQuestion = /^\s*(offer to|may i\b|shall i\b|would you like me to|want me to|can i get you|I could\b|I can get you\b|how about i\b)/i.test(playerCommand.trim());
  const isDescribeOnly = /^\s*(look|examine|l|x|start|begin)(\s+around|\s+at|\s+here)?\s*$/i.test(playerCommand.trim()) || cmd === "l" || cmd === "x";
  const isInventoryOnly = cmd === "i" || cmd === "inventory";
  const offerBlock = isOfferOrQuestion
    ? `\n*** OFFER/QUESTION DETECTED: The player ONLY offered or asked—they did NOT give a command to do it. You must NOT perform the action (do not light, open, unlock, give, or change any object/location state). Do NOT set adjectives_new to "lit", "open", or any state change for any node. Narrate ONLY the offer and the NPC's or world's response (e.g. Ciaran says he would welcome light, or nods). The torch does NOT get lit; no object or location changes state this turn. ***\n\n`
    : "";
  const describeOnlyBlock = !isOfferOrQuestion && isDescribeOnly
    ? `\n*** DESCRIBE-ONLY: The player only asked to look or describe the scene. Do NOT perform any action (do not take, use, open, or move any object). Do NOT set new_location_id for any object or for the player. Describe the FULL scene: the location and every entity in ENTITIES PRESENT—name each NPC and mention each object. Do not skip any character or object. ***\n\n`
    : "";
  const inventoryOnlyBlock = !isOfferOrQuestion && isDescribeOnly === false && isInventoryOnly
    ? `\n*** INVENTORY: The player asked for their inventory (e.g. "i" or "inventory"). Describe ONLY what the player is carrying—the items listed in the PLAYER/Inventory line above (location_id: player). Do NOT describe the location, ENTITIES PRESENT, exits, or anything else. List only those items. If Inventory is empty, say they are carrying nothing. Do NOT set new_location_id for any object or for the player. ***\n\n`
    : "";
  return `PLAYER ACTION: ${playerCommand}
Perform ONLY the action the player asked for. Do not take, use, or move any object unless the player's words explicitly request it (e.g. "take torch", "light the torch"). Dialogue and questions are not commands to take or use.
${offerBlock}${describeOnlyBlock}${inventoryOnlyBlock}START/BEGIN: If the player said "start" or "begin", describe the full scene including every NPC and object in ENTITIES PRESENT by name. Do NOT set new_location_id for any object. No state changes.
${containmentLine}TAKE: Set new_location_id to "player" in the **taken object's** entry only when the player explicitly said to take that object (e.g. "take torch")—never when the player only moved (e.g. "east", "go through the door"). Without new_location_id on the taken object, the object will not move to the player. Omit new_location_id for that object if it stays in place (e.g. lighting it in its bracket). When you do set new_location_id to "player" for an object: in narrative_prose use exactly "The player now holds the [object]." (e.g. "The player now holds the torch."); in that object's prose_impact use exactly "Taken by player." FORBIDDEN when the player did not say to take an object: writing "The player now holds the X" or "Taken by player." for that object, or setting that object's new_location_id to "player". Movement alone is never a take—do not take or narrate taking any object when the player only moved.
DROP/PUT DOWN: When the player drops or puts down an object (e.g. "drop torch", "put down the torch"), set that object's new_location_id to the **current location** (the location's node_id, e.g. kitchen)—the object ends up in the room, on the ground. Do NOT set new_location_id to another entity (hearth, fire, table, brazier); the object must go to the current location only. Describe the drop in narrative_prose (e.g. "You set the torch down." or "The torch lies on the floor."); in that object's prose_impact use e.g. "Dropped by player."
PUT IN CONTAINER: When the player puts an object into a container (e.g. "put the torch in the bracket"), set that **object's** new_location_id to the **container's** node_id (e.g. bracket_01). Do NOT set the container's new_location_id to "player". Include the object in node_impacts with new_location_id set to the container.
GIVE TO NPC: NPCs do not take the player's items unless the player explicitly gives (e.g. "give carrot to Ciaran"). If the player only offers or mentions the item, do NOT set that object's new_location_id to the NPC; the item stays in inventory.
Reminder: Literal actions only; offers/questions do not perform the action; objects do not change state on their own or when taken.
${movementReminder}${exitLine}${destinationLine}
CRITICAL — node_impacts: ENTITIES PRESENT above is the world state (what exists). Your node_impacts must include exactly one entry for each of these node_ids: ${requiredNodeIds}. No other node_ids. If the player targeted someone/something not present, action fails but node_impacts still lists every id above. For each entry: adjectives_old = that node's current adjectives from CURRENT SCENE or Inventory; adjectives_new = state after this turn. Use only vocabulary terms for persistent state (disposition, lit/closed). Never add transient or narrative-only phrases (e.g. "noticed looking up", "observed")—use prose_impact for those. When your narrative describes an NPC or object state change (e.g. NPC warms up), set adjectives_new to match or the engine will not update. For NPCs, retain all dispositional adjectives (guarded, hostile, etc.) when adding physical or other adjectives—do not replace disposition with appearance. For start, look, examine, or movement-only (no interaction with an NPC or object): set adjectives_new equal to adjectives_old for every node. No other change → adjectives_new equal to adjectives_old. Never use [] for a node that has adjectives unless explicitly clearing. Use reconciliation_notes if you see a mismatch (e.g. "Narrative showed Ciaran warming up; I should have updated ciaran adjectives_new").

Return ONLY this JSON structure:
{
  "narrative_prose": "<string: describe location, EVERY entity (name each NPC and mention each object), then EVERY exit (at least label and direction for each; destination optional—e.g. battered door east; steps down); then what happened. Never omit an NPC, object, or exit. If 'Containment in this scene' or 'contains: X' appears above, those containers have X inside—say so (e.g. 'the bracket holds the torch'); never say the container is empty or the object is missing/invisible. Any object marked [UNLIT] or with no 'lit' in adjectives (e.g. torch, candle) must be described as unlit—never as burning, lit, or providing light.>",
  "action_result": "<success | failure | partial>",
  "node_impacts": [
    {
      "node_id": "<exact node_id from CURRENT SCENE: e.g. scriptorium, ciaran, torch_01, or player—never 'location' or 'entities|name'>",
      "prose_impact": "<string: what this node experienced; use exactly 'Taken by player.' only for an object the player explicitly took this turn (e.g. said 'take torch'); otherwise do not use that phrase>",
      "adjectives_old": ["<current adjectives for this node from CURRENT SCENE>"],
      "adjectives_new": ["<adjectives after this turn; MUST match the state your narrative describes for that node—e.g. if narrative says NPC warmed up, remove \"guarded\" or add appropriate term; same as adjectives_old only if narrative shows no change>"],
      "new_location_id": "<optional: for a TAKEN object put new_location_id: \"player\" in THAT OBJECT'S entry ONLY when the player explicitly said to take it (e.g. 'take torch')—never on look, movement only (e.g. east, go through door), or narrative; for MOVEMENT set the player entry's new_location_id to the exit target e.g. \"kitchen\"; omit only if no take and no move. Only write 'The player now holds the [object].' and 'Taken by player.' when you are actually setting that object's new_location_id to \"player\"; if the player did not say to take it, omit and do not use those phrases>"
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
    buildSectionC(ctx),
    buildSectionB(ctx.vocabulary),
    buildSectionD(recentHistory),
    buildSectionE(ctx, playerCommand, ctx.locationExits ?? [], destinationScene),
  ];
  return sections.join("\n\n");
}

/** Cache: adjective (lowercase) -> whether it is engine-covered (containment/placement/possession). Persists for process lifetime. */
const engineCoveredCache = new Map<string, boolean>();

/**
 * Parse a YES/NO response from Ollama. Only returns true when the answer is explicitly YES.
 * Handles JSON like { "answer": "NO" } or { "Yes": "" } — the latter must NOT be treated as YES (empty value).
 */
function parseYesNoResponse(
  responseText: string,
  _logLabel: string,
  _adjective: string,
  _debug: boolean
): boolean {
  const raw = (responseText || "").trim();
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const val = parsed.answer ?? parsed.Answer ?? parsed.response ?? parsed.Yes ?? parsed.yes;
    const s = String(val ?? "").trim().toUpperCase();
    return s === "YES";
  } catch {
    const upper = raw.toUpperCase();
    return upper === "YES" || /^YES[\s.,]*$/.test(upper);
  }
}

/**
 * Returns true if this adjective's rule describes only containment/placement/possession (where something is, who holds it, or whether a container has contents).
 * The engine handles those via location_id; such adjectives must not be added to vocabulary or applied to nodes.
 * Result is cached by adjective (lowercase) so we only call the LLM once per term per process.
 */
export async function isEngineCoveredByDefinition(
  adjective: string,
  ruleDescription: string
): Promise<boolean> {
  const key = String(adjective).trim().toLowerCase();
  if (!key) return false;
  const cached = engineCoveredCache.get(key);
  if (cached !== undefined) {
    if (DEBUG) debugLog("engine-covered check (cached)", `adjective: ${adjective} -> engine_covered: ${cached}`);
    return cached;
  }
  const rule = String(ruleDescription).trim() || "(no description)";
  const prompt = `Answer with only YES or NO.

Does the following adjective and its rule describe ONLY (1) where something is located, (2) who possesses or holds it, or (3) whether a container has contents or is empty? The game engine already handles (1)–(3) via location_id and containment, so such adjectives must not be used. Do NOT treat "open" or "closed" as engine-covered—those are valid state adjectives (container open vs closed), not descriptions of whether the container has contents.

Adjective: ${adjective}
Rule: ${rule}

Answer:`;
  try {
    if (DEBUG) {
      debugLog("engine-covered check request", `adjective: ${adjective}\nrule: ${rule}`);
    }
    const responseText = await callOllama(prompt, "engine-covered check");
    const yes = parseYesNoResponse(responseText, "engine-covered check", adjective, DEBUG);
    engineCoveredCache.set(key, yes);
    if (DEBUG) {
      debugLog("engine-covered check result", `adjective: ${adjective}\nraw response: ${responseText || "(empty)"}\nengine_covered: ${yes}`);
    }
    return yes;
  } catch (err) {
    engineCoveredCache.set(key, false);
    if (DEBUG) {
      debugLog("engine-covered check error", `${adjective}: ${err instanceof Error ? err.message : String(err)} -> treating as not covered`);
    }
    return false;
  }
}

/**
 * Filter a list of adjectives: remove any that are in vocabulary and whose rule is engine-covered (containment/placement/possession).
 * Adjectives not in vocabulary are left in (they are gated when we fetch their definition).
 */
export async function filterEngineCoveredAdjectives(
  adjectives: string[],
  vocabulary: { adjective: string; rule_description: string }[]
): Promise<string[]> {
  if (adjectives.length === 0) return [];
  const vocabByLower = new Map(vocabulary.map((v) => [v.adjective.trim().toLowerCase(), v]));
  const result: string[] = [];
  for (const a of adjectives) {
    const key = String(a).trim().toLowerCase();
    if (!key) continue;
    const v = vocabByLower.get(key);
    if (!v) {
      result.push(a);
      continue;
    }
    const covered = await isEngineCoveredByDefinition(v.adjective, v.rule_description);
    if (!covered) result.push(a);
  }
  if (DEBUG) {
    const removed = adjectives.filter((a) => !result.includes(a));
    debugLog(
      "filterEngineCoveredAdjectives",
      `input: [${adjectives.join(", ")}]\noutput: [${result.join(", ")}]${removed.length > 0 ? `\nremoved (engine-covered): [${removed.join(", ")}]` : ""}`
    );
  }
  return result;
}

/** Cache: adjective (lowercase) -> whether it is transient/narrative-only (momentary action or observation, not persistent game state). */
const transientAdjectiveCache = new Map<string, boolean>();
const transientByTermCache = new Map<string, boolean>();
const locationOnlyByTermCache = new Map<string, boolean>();

/**
 * Returns true if this phrase describes only where something is located or placed (e.g. "in cellar", "in kitchen", "in inventory").
 * Location and containment are tracked by the engine (location_id), not by adjectives. Result is cached by term (lowercase).
 */
export async function isLocationOrContainmentOnlyByTerm(term: string): Promise<boolean> {
  const key = String(term).trim().toLowerCase();
  if (!key) return false;
  const cached = locationOnlyByTermCache.get(key);
  if (cached !== undefined) {
    if (DEBUG) debugLog("location-only-by-term check (cached)", `term: ${term} -> locationOnly: ${cached}`);
    return cached;
  }
  const prompt = `Answer with only YES or NO.

Does the following phrase describe ONLY where something is located or placed (e.g. "in cellar", "in kitchen", "in inventory", "on table", "in the scriptorium")? The game engine tracks location and containment; such phrases must NOT be used as adjectives. If the phrase is purely a location or placement, answer YES.

Phrase: ${term}

Answer:`;
  try {
    if (DEBUG) debugLog("location-only-by-term check request", `term: ${term}`);
    const responseText = await callOllama(prompt, "location-only-by-term check");
    const yes = parseYesNoResponse(responseText, "location-only-by-term check", term, DEBUG);
    locationOnlyByTermCache.set(key, yes);
    if (DEBUG) debugLog("location-only-by-term check result", `term: ${term} -> locationOnly: ${yes}`);
    return yes;
  } catch (err) {
    locationOnlyByTermCache.set(key, false);
    if (DEBUG) debugLog("location-only-by-term check error", `${term}: ${err instanceof Error ? err.message : String(err)} -> treating as not location-only`);
    return false;
  }
}

/**
 * Returns true if this phrase (a candidate adjective not yet in vocabulary) describes only a momentary action,
 * one-off observation, or something with no substantive impact on game state/flow. Used to reject terms like
 * "copying a manuscript" before we try to define them. Result is cached by term (lowercase).
 */
export async function isTransientOrNarrativeOnlyByTerm(term: string): Promise<boolean> {
  const key = String(term).trim().toLowerCase();
  if (!key) return false;
  const cached = transientByTermCache.get(key);
  if (cached !== undefined) {
    if (DEBUG) debugLog("transient-by-term check (cached)", `term: ${term} -> transient: ${cached}`);
    return cached;
  }
  const prompt = `Answer with only YES or NO.

Does the following phrase describe ONLY a momentary action, one-off observation, or something with NO substantive impact on game state or flow (e.g. "copying a manuscript", "looking up", "noticed", "currently observing")? Substantive impact = persistent disposition (guarded, hostile), object/location state (lit, closed, locked), or other qualities that last and affect future turns. If the phrase is just an activity or fleeting moment with no lasting game effect, answer YES.

Phrase: ${term}

Answer:`;
  try {
    if (DEBUG) debugLog("transient-by-term check request", `term: ${term}`);
    const responseText = await callOllama(prompt, "transient-by-term check");
    const yes = parseYesNoResponse(responseText, "transient-by-term check", term, DEBUG);
    transientByTermCache.set(key, yes);
    if (DEBUG) debugLog("transient-by-term check result", `term: ${term} -> transient: ${yes}`);
    return yes;
  } catch (err) {
    transientByTermCache.set(key, false);
    if (DEBUG) debugLog("transient-by-term check error", `${term}: ${err instanceof Error ? err.message : String(err)} -> treating as not transient`);
    return false;
  }
}

/**
 * Returns true if this adjective's rule describes only a momentary action, one-off observation, or transient state
 * that does not persistently affect how the node interacts with the player or world. Such terms must not be added
 * to vocabulary or applied to nodes—use prose_impact instead. Result is cached by adjective (lowercase).
 */
export async function isTransientOrNarrativeOnlyByDefinition(
  adjective: string,
  ruleDescription: string
): Promise<boolean> {
  const key = String(adjective).trim().toLowerCase();
  if (!key) return false;
  const cached = transientAdjectiveCache.get(key);
  if (cached !== undefined) {
    if (DEBUG) debugLog("transient-adjective check (cached)", `adjective: ${adjective} -> transient: ${cached}`);
    return cached;
  }
  const rule = String(ruleDescription).trim() || "(no description)";
  const prompt = `Answer with only YES or NO.

Does the following adjective and its rule describe ONLY a momentary action, one-off observation, or transient state (e.g. "looked up", "noticed", "currently observing", "observed doing X") that does NOT persistently affect how the node interacts with the player or the world? Persistent game state = disposition (guarded, hostile), object state (lit, closed, locked), or other qualities that last and affect future turns. If the term is only a fleeting moment or observation, answer YES—such terms must not be used as adjectives; put them in prose_impact only.

Adjective: ${adjective}
Rule: ${rule}

Answer:`;
  try {
    if (DEBUG) debugLog("transient-adjective check request", `adjective: ${adjective}\nrule: ${rule}`);
    const responseText = await callOllama(prompt, "transient-adjective check");
    const yes = parseYesNoResponse(responseText, "transient-adjective check", adjective, DEBUG);
    transientAdjectiveCache.set(key, yes);
    if (DEBUG) debugLog("transient-adjective check result", `adjective: ${adjective}\nraw: ${responseText || "(empty)"}\ntransient: ${yes}`);
    return yes;
  } catch (err) {
    transientAdjectiveCache.set(key, false);
    if (DEBUG) debugLog("transient-adjective check error", `${adjective}: ${err instanceof Error ? err.message : String(err)} -> treating as not transient`);
    return false;
  }
}

/**
 * Filter adjectives: remove any that are in vocabulary and whose rule is transient/narrative-only (momentary action or observation).
 */
export async function filterTransientAdjectives(
  adjectives: string[],
  vocabulary: { adjective: string; rule_description: string }[]
): Promise<string[]> {
  if (adjectives.length === 0) return [];
  const vocabByLower = new Map(vocabulary.map((v) => [v.adjective.trim().toLowerCase(), v]));
  const result: string[] = [];
  for (const a of adjectives) {
    const key = String(a).trim().toLowerCase();
    if (!key) continue;
    const v = vocabByLower.get(key);
    if (!v) {
      result.push(a);
      continue;
    }
    const transient = await isTransientOrNarrativeOnlyByDefinition(v.adjective, v.rule_description);
    if (!transient) result.push(a);
  }
  if (DEBUG) {
    const removed = adjectives.filter((a) => !result.includes(a));
    debugLog(
      "filterTransientAdjectives",
      `input: [${adjectives.join(", ")}]\noutput: [${result.join(", ")}]${removed.length > 0 ? `\nremoved (transient/narrative-only): [${removed.join(", ")}]` : ""}`
    );
  }
  return result;
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
function isNegationOrDiminution(candidate: string, vocabTerm: string): boolean {
  const c = candidate.trim().toLowerCase();
  const v = vocabTerm.trim().toLowerCase();
  if (!v) return false;
  const vUnderscore = v.replace(/\s+/g, "_");
  if (c === v || c === vUnderscore) return false;
  const diminutionPrefixes = ["less ", "less_", "more ", "more_", "no longer ", "no_longer_", "not ", "not_", "un", "no "];
  for (const prefix of diminutionPrefixes) {
    const rest = c.startsWith(prefix) ? c.slice(prefix.length).trim().replace(/\s+/g, "_") : "";
    if (rest && (rest === v || rest === vUnderscore || v === rest || vUnderscore === rest)) return true;
  }
  return false;
}

/** Disposition terms (NPC attitude); do not map object/location state phrases to these or vice versa. */
const DISPOSITION_LIKE = new Set(
  ["guarded", "less guarded", "hostile", "curious", "confiding", "watchful", "engaged", "scholarly", "sacred"].map((s) => s.toLowerCase())
);
function isObjectStateVsDisposition(candidate: string, vocabTerm: string): boolean {
  const c = candidate.trim().toLowerCase();
  const v = vocabTerm.trim().toLowerCase();
  const candidateIsObjectState =
    /\b(waiting|flame|spark|unlit|lit|illuminated|illumination|dark|bright|burning|glow|inventory|player's)\b/i.test(candidate) ||
    /in player's inventory|better illuminated|waiting for/i.test(c);
  const valueIsDisposition = DISPOSITION_LIKE.has(v);
  if (candidateIsObjectState && valueIsDisposition) return true;
  const valueIsObjectState =
    /\b(lit|dark|broken|closed|locked|open|sealed)\b/.test(v);
  const candidateLooksDisposition = DISPOSITION_LIKE.has(c) || /guard|curious|hostile|watchful|confiding|engaged|scholarly/i.test(candidate);
  if (valueIsObjectState && candidateLooksDisposition) return true;
  return false;
}

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

CANDIDATE TERMS (these are not in the vocabulary yet; some may be true synonyms of existing terms):
${terms.join(", ")}

For each candidate: if it has the SAME meaning as an existing vocabulary term (true synonym), respond with that term exactly as listed; otherwise respond with the candidate unchanged. Only map when the two mean the same thing (e.g. "mad" -> "hostile"). Do NOT map when: (1) the candidate is a negation, opposite, or lessening of a vocabulary term (e.g. un+X, "not X", "less X")—return the candidate unchanged and do not map it to any other term; (2) the candidate is object/location state and the term is NPC disposition, or vice versa. Return those candidates unchanged.

CRITICAL: Return a JSON object with one key per candidate. Keys must be the candidate terms exactly as written above. Values must be EITHER (1) an existing vocabulary term from the list—exact spelling—only when it is a true synonym, OR (2) the candidate itself unchanged. Example: {"content": "settled", "less_guarded": "less_guarded"} if "content" is a synonym for "settled" and "less_guarded" is a distinct state (not a synonym for "guarded").

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
        if (isNegationOrDiminution(candidate, existing) || isObjectStateVsDisposition(candidate, existing)) {
          result.set(key, candidate.trim());
        } else {
          result.set(key, existing);
        }
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
 * Returns { definitions, requestedToCanonical }. definitions = array to insert/check; requestedToCanonical maps each
 * requested term (lowercase) to the canonical adjective to use (may be the model's suggestion, e.g. "copied" for "copying a manuscript").
 * On parse failure or error returns { definitions: [], requestedToCanonical: new Map() } so the turn is not broken.
 */
export type FetchAdjectiveDefinitionsResult = {
  definitions: { adjective: string; rule_description: string }[];
  requestedToCanonical: Map<string, string>;
};

export async function fetchAdjectiveDefinitions(
  adjectives: string[],
  existingVocabulary: { adjective: string; rule_description: string }[],
  callSource?: string,
  allowFallback = true
): Promise<FetchAdjectiveDefinitionsResult> {
  const empty = { definitions: [], requestedToCanonical: new Map<string, string>() };
  if (adjectives.length === 0) return empty;
  const terms = [...new Set(adjectives)].map((a) => a.trim()).filter(Boolean);
  if (terms.length === 0) return empty;
  const logLabel = callSource ? `vocabulary definitions (${callSource})` : "vocabulary definitions";
  const vocabBlock =
    existingVocabulary.length > 0
      ? `EXISTING VOCABULARY (use these to define new terms in relation when appropriate, e.g. "less guarded" from "guarded"):\n${existingVocabulary.map((v) => `- ${v.adjective}: ${v.rule_description}`).join("\n")}\n\n`
      : "";
  const termList = terms.join(", ");
  const prompt = `You are defining game-state adjectives for a text adventure. These definitions are generic and transportable: they apply to any node (location, object, NPC). Do not refer to specific characters, places, or objects.

${vocabBlock}Define each NEW term below. For each term, provide exactly one sentence (rule_description) describing what this state means for the game. If a new term relates to an existing one above (e.g. "less guarded" given "guarded"), base the definition on that.

Prefer copying the term word-for-word in the "adjective" field. If a term is verbose or action-like (e.g. "copying a manuscript"), you MAY return a shorter canonical adjective (e.g. "copied") that best captures the persistent state; the engine will use your adjective.

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
    const termsLowerSet = new Set(terms.map((t) => t.trim().toLowerCase()));
    const parsedItems = items
      .map((x) => ({
        adjective: typeof x.adjective === "string" ? String(x.adjective).trim() : "",
        rule_description: typeof x.rule_description === "string" ? String(x.rule_description).trim() : "",
      }))
      .filter((x) => x.adjective.length > 0);

    const result: { adjective: string; rule_description: string }[] = [];
    const requestedToCanonical = new Map<string, string>();

    // Exact matches: response adjective is one of the requested terms
    const matchedTermIndices = new Set<number>();
    for (const r of parsedItems) {
      const idx = terms.findIndex((t) => t.trim().toLowerCase() === r.adjective.toLowerCase());
      if (idx !== -1) {
        matchedTermIndices.add(idx);
        const canonical = terms[idx]!.trim();
        result.push({ adjective: canonical, rule_description: r.rule_description });
        requestedToCanonical.set(canonical.toLowerCase(), canonical);
      }
    }

    // Pair unconsumed response items (model suggested a different adjective) with terms that have no definition yet
    const missingIndices = terms.map((_, i) => i).filter((i) => !matchedTermIndices.has(i));
    const unconsumed = parsedItems.filter((r) => !termsLowerSet.has(r.adjective.toLowerCase()));
    for (let i = 0; i < missingIndices.length && i < unconsumed.length; i++) {
      const term = terms[missingIndices[i]!]!.trim();
      const item = unconsumed[i]!;
      result.push({ adjective: item.adjective, rule_description: item.rule_description });
      requestedToCanonical.set(term.toLowerCase(), item.adjective);
    }

    const missing = terms.filter((t) => !requestedToCanonical.has(t.trim().toLowerCase()));

    if (allowFallback && missing.length > 0) {
      if (DEBUG) debugLog("fetchAdjectiveDefinitions", `Got ${result.length}/${terms.length} definitions; fetching missing one-by-one: ${missing.join(", ")}`);
      for (const term of missing) {
        const one = await fetchAdjectiveDefinitions([term], existingVocabulary, callSource, false);
        const def = one.definitions[0];
        if (def) {
          result.push({ adjective: def.adjective, rule_description: def.rule_description });
          requestedToCanonical.set(term.trim().toLowerCase(), def.adjective);
        }
        for (const [k, v] of one.requestedToCanonical) requestedToCanonical.set(k, v);
      }
    }

    return { definitions: result, requestedToCanonical };
  } catch (err) {
    if (DEBUG) debugLog("fetchAdjectiveDefinitions error", err instanceof Error ? err.message : String(err));
    return empty;
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

export type OllamaCheckResult =
  | { ok: true }
  | { ok: false; error: "unreachable" }
  | { ok: false; error: "model_not_found" };

/** Verifies Ollama is reachable and OLLAMA_MODEL exists in the local model list. */
export async function checkOllamaReachable(): Promise<OllamaCheckResult> {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`, { method: "GET" });
    if (!res.ok) return { ok: false, error: "unreachable" };
    const data = (await res.json()) as { models?: { name: string }[] };
    const models = data?.models ?? [];
    const want = OLLAMA_MODEL.trim();
    const found = models.some(
      (m) => m.name === want || m.name.startsWith(want + ":")
    );
    return found ? { ok: true } : { ok: false, error: "model_not_found" };
  } catch {
    return { ok: false, error: "unreachable" };
  }
}
