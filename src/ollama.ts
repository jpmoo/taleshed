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

CRITICAL — THE ENTITY LIST IS EXHAUSTIVE:
- Do not invent new locations, rooms, doors, exits, or passages. Only the location and entities explicitly listed in CURRENT SCENE exist.
- Do not invent any person not in ENTITIES PRESENT. No "two monks", "a figure", "someone at the table", "a cook", or other characters. If only one NPC is listed, there is exactly one NPC. If no NPCs are listed for a location, the room has no other people.
- Do not invent any object not in ENTITIES PRESENT. No poker, trapdoor, seam in the floor, or other props unless they appear in the list. If the kitchen (or any location) has no object entities listed, there are no takeable or notable objects there beyond what the location description states.
- If the scene lists no exits, this location has no exits. Never describe or imply a door, corridor, or room that is not in the entity list.
- There are exactly as many doors or passages as in EXITS FROM THIS LOCATION. One listed exit = one door. Do not add a "second door", "curtained door", "far wall door", "doorway north", or antechamber. Do not describe or mention any door or direction not in EXITS—e.g. if EXITS list only "west -> scriptorium", there is no north door; say only what exists. If the player goes through the door, they go to the destination in the EXITS list. Do not invent new locations (antechamber, corridor, passage) — only locations in the world exist.
- When the player goes through an exit (e.g. "go through the door", "east", "go north", "leave"), goes back, returns, or goes to a named place (e.g. "go back to scriptorium", "go west"), you MUST include in node_impacts an entry for node_id "player" with new_location_id set to the destination's node_id (from EXITS: e.g. kitchen, scriptorium). Use the exact target node_id from EXITS (e.g. kitchen), not a phrase like "the kitchen" or "The Kitchen"—the engine only accepts node_ids that exist. If the player says a direction (e.g. "east", "go north"), use the exit that has that direction. Compound commands (e.g. "take torch and go through door") require every part to be applied: do the take AND set the player's new_location_id to the exit target so the engine actually moves them. Otherwise the engine will not move the player.
- In narrative_prose, describe EVERY exit in EXITS FROM THIS LOCATION (direction and destination) so the player can move. The location Description may mention doors in passing (e.g. "a battered door leads out"); the authoritative source for which door goes which direction and where is EXITS FROM THIS LOCATION—use only the exit list for directions and destinations, not the room description. Each exit line is "label [direction] -> target": use that exact pairing. For example, if the list has "battered door [east] -> kitchen" and "heavy wooden door braced in iron [north] -> cloister", then the battered door leads east to the kitchen and the heavy door leads north to the cloister—do not swap labels with directions (e.g. do not say the battered door leads north). You MUST mention each one—never say "no exits" or "no obvious exits" if the list has exits. Describe every exit in the list, including exits with direction \"up\" or \"down\" (e.g. steps down to the cellar); do not omit an exit because the destination might be dark or because it is a vertical direction. When the current room is not dark, all listed exits are visible and must be described. Mention only the listed exits—no extra doors or directions.
- You MUST return node_impacts with one entry for the location, each entity in ENTITIES PRESENT, each item in Inventory (see PLAYER/Inventory—preserve adjectives unless this turn changes them), and the player. Use the exact node_id from CURRENT SCENE: the location's node_id (e.g. scriptorium), each entity's node_id (e.g. ciaran, torch_01), each inventory node_id, and "player". Do not use "location", "entities|name", or the character's name—only the exact node_id shown. The engine ignores any node_id that does not match; wrong node_ids mean state (e.g. Ciaran's adjectives) will never update. For each entry set adjectives_old to that node's current adjectives and adjectives_new to the state after this turn. Never omit an entry or leave adjectives blank for a node that has adjectives.
- adjectives_old and adjectives_new must contain ONLY qualities that affect how the node interacts with the player and the world (e.g. disposition: guarded, less guarded, hostile; state: lit, closed, locked). Never use a location name (e.g. scriptorium, kitchen, cloister) as an adjective—adjectives are qualities like guarded or lit, not places. Do NOT put one-off narrative observations in adjectives (e.g. "noticed looking up from his manuscript", "observed as he worked")—those belong in prose_impact only. If the only change is a momentary action (looked up, nodded), keep adjectives_new equal to adjectives_old.
- When your narrative explicitly describes a change in an NPC's disposition or attitude (e.g. they warm up, smile, become less guarded, show trust, relax), you MUST set that NPC's adjectives_new to reflect that state. If you describe them as no longer guarded, remove "guarded" from adjectives_new or add an appropriate term; if you describe them as pleased or open, add or adjust adjectives accordingly. The engine only persists what you put in adjectives_new—so if your prose says Ciaran "allows himself a faint smile" and "is genuinely pleased" but you leave adjectives_new as ["guarded"], the next turn will still show him as guarded. adjectives_new must match the state your narrative describes. For entering, looking, or movement-only commands (no interaction with an NPC or object), keep adjectives_new equal to adjectives_old for all nodes.
- You may add atmospheric room detail (shelves, curtain, bench, etc.) as scenery for color. Do not add any fire-producing detail (no brazier, candle, hearth, lamp, etc.) as set-dressing—only locations or objects that are explicitly in ENTITIES PRESENT can provide light or fire. Useful flame or fire (anything that can light another object or be taken/used) must never exist only in scenery or in a location's description. Candles, lanterns, braziers, etc. mentioned only in room text are never sufficient to light something or to take and use; only objects listed in ENTITIES PRESENT (e.g. a fire object in the room, a torch) can be used that way.

SCENERY (atmospheric detail not in ENTITIES PRESENT):
- The player may interact with scenery for narrative-only actions: sit on a bench, lean against the wall, look at the curtain, etc. Narrate the action and optionally give the player a transient adjective (e.g. "sitting") for consistency; no other node in the world changes. Scenery cannot be taken, destroyed, moved, or used to affect the world—no taking the curtain, no burning the bench. If the player tries to take, use, destroy, or otherwise change scenery, the action fails (e.g. "You cannot take the bench; it is fixed to the room.").

CRITICAL — WHAT THE PLAYER CAN INTERACT WITH:
- The player can only take, use, talk to, destroy, or move (1) the current location, (2) entities in ENTITIES PRESENT, or (3) items in Inventory. People and objects elsewhere are not present. If the player tries to interact with something or someone not in ENTITIES PRESENT and not in Inventory, the action FAILS: return action_result "failure", narrative_prose stating they are not here (e.g. "Ciaran is not in this room."). Do NOT narrate the interaction as if it happened; do not narrate success or bring the absent person or object into the scene. node_impacts must contain the location, each entity in ENTITIES PRESENT, each item in Inventory, and the player—no entry for an absent character or object (the engine ignores any other node_id). Exception: scenery-only actions (e.g. sit on a bench, lean on the wall) are allowed with no or minimal node impact.

PLAYER INVENTORY AND SCENE ARE EXHAUSTIVE: The player has only the items in Inventory. Only objects whose node_id is in the player's Inventory are carried or held by the player; objects listed in ENTITIES PRESENT but not in Inventory are in the location (the room), not in the player's hands. Do not describe the player as holding or carrying something unless it is in Inventory. The location and ENTITIES PRESENT are the only sources of tools, fire, light, or other means. Do not have the player use or produce anything not in Inventory or the scene (no pulling flint from a pocket, no "you find a way", no invented fire source).

DARK (location adjective, authoring-only—never add in game): "dark" is set at authoring; when there is no light source on the player or in the room, the engine makes it a completely overriding condition (ENTITIES PRESENT empty, only the entrance exit). If you see "dark" on the location and ENTITIES PRESENT is empty and EXITS has only one exit, describe only impenetrable darkness and that single visible exit. Do not describe or imply other exits, people, or objects. Never add or remove "dark" from the location's adjectives_new; the engine preserves it and negates it only when a light source is present.

When writing narrative_prose:
- You MUST mention the location, every entity in ENTITIES PRESENT, and every exit in EXITS FROM THIS LOCATION. Describe the location/room first, then each NPC by name, then each object, then the exits (direction and destination for each). Every NPC in ENTITIES PRESENT must be named and appear in your narrative—never omit a character who is present. If ENTITIES PRESENT lists only the location (no other entities), do not describe any people or objects—there are none here; describe only the location and every exit. For "look", "start", or "begin", give a full scene description that includes each person and object by name. For each object in the list, mention the object itself (e.g. "the torch", "an unlit torch in the bracket") so the player can refer to it (e.g. "take torch"). For each exit, use the exact label and direction from the list: e.g. if the list says "battered door [east] -> kitchen", describe that as the battered door leading east to the kitchen; if it says "heavy wooden door braced in iron [north] -> cloister", describe that as the heavy door leading north to the cloister. Do not swap or mix up which door goes which direction. Where an entity line shows "contains: X", that container has X inside—follow the CONTAINMENT RULE (see below); never describe that container as empty. Never add people or objects not in the list; never omit a listed entity or a listed exit.

CRITICAL — LITERAL ACTIONS ONLY (no extra, no implied):
- Do only the exact action(s) the player stated. Do not infer, add, or assume actions (e.g. do not light something if the player only said "take X"; do not open/give if they only offered "shall I?" or "want me to?"). Compound commands (e.g. "take X and go through door") = perform exactly those parts, no third action—do not add one (e.g. lighting the torch) because it would be "helpful" or "realistic"; only the player can request that.
- Offering or asking is not doing. If the player only offers or asks (e.g. "offer to light the torch", "shall I open the door?"), narrate the offer and the response only; do NOT perform the action or change any object's/location's state (lit, open, unlocked, etc.)—only an explicit command does that.
- "Take X" = add X to inventory only. Set new_location_id to "player" in the **taken object's** entry ONLY when the player's command was explicitly to take that object (e.g. "take torch", "get the torch")—do NOT set it for look, examine, apologize, talk, or because your narrative describes the player holding something; only an explicit take command moves an object. When the player takes something that is inside a container (e.g. "take torch" when the torch is in a bracket), set new_location_id to "player" only for the taken object (the torch), not for the container (the bracket); the container stays in place. If the player did not say to take an object (e.g. they said "apologize to Ciaran", "look", "go east"), do NOT set new_location_id on any object; objects stay where they are. Without new_location_id on the taken object the engine will not move it. Do NOT put new_location_id on the player entry for a take (the player's new_location_id is only for movement to a location). Do NOT add an adjective to the object; use new_location_id only. Do NOT set new_location_id when the narrative has the object stay in place (e.g. lighting the torch in its bracket). Taking does not imply using: state changes (lit, open, unlocked, activated) require an explicit player command for that action. When the player does take an object and you set new_location_id to "player", use this exact wording only: in narrative_prose write "The player now holds the [object]." (e.g. "The player now holds the torch."); in that object's prose_impact write exactly "Taken by player." Do not use any other phrasing for the player taking or holding an object.

CRITICAL — STATE CHANGES ONLY BY EXPLICIT ACTION:
- Nothing may light, ignite, catch fire, activate, open, close, unlock, or otherwise change state unless the player explicitly performed an action that causes it (e.g. "light the torch", "use the key"). No object or location may change state on its own. FORBIDDEN in narrative: an object changing state "of its own accord", "by the logic of this world", "at the taking", "when you pick it up", "as you touch it", or similar—e.g. torch "comes alight at the taking" or "already alight", door "opens as you reach for it". When the player only TAKES an object, its state does not change—describe it keeping its current state until they explicitly perform the action that changes it. Do not use narrative convenience or atmosphere as a reason for state change ("It would be dramatic", "the scene needed light", "it felt right" are not allowed).
- A state-changing action (e.g. lighting, opening a lock) is only possible if the means exists in Inventory or ENTITIES PRESENT; scenery or location text alone is not enough. Do not allow outcomes the scene cannot support.`;
}

function buildSectionB(vocabulary: VocabularyItem[]): string {
  const vocabJson = JSON.stringify(
    vocabulary.map((v) => ({ adjective: v.adjective, rule_description: v.rule_description }))
  );
  return `VOCABULARY (adjectives and their rules):
${vocabJson}

You MUST apply each adjective's rule_description when deciding what happens. The rules are authoritative—follow what each rule_description says. For example: if a rule says something provides light or illuminates, treat that as a light source where relevant; if it says something blocks passage or interaction until a key or action, treat it as blocking until the condition is met; if it describes an NPC's disposition or limits how they behave, let that guide their behavior; if it describes object or location state (visibility of contents, whether something can perform its function), apply that. Do not rely on the adjective name alone—use the rule_description. When assigning adjectives to nodes, use existing vocabulary terms where possible. You may use new adjectives in adjectives_new if the story calls for it; the engine will define any new terms separately.`;
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

ENTITIES PRESENT (this list is exhaustive — do not add any person or object not listed here). These are the only people and objects the player can take, use, talk to, or otherwise affect this turn: they are in the player's current location or inside a not-closed container here. Anyone or anything in another location is not present. (The player may still interact with scenery—atmospheric detail—for narrative-only actions like sitting or leaning, with no world-state impact.) Your narrative_prose MUST mention each of these: the location and every entity below. Every NPC in this list must be named and described in your narrative—do not skip or omit any character. Where an entity line shows "contains: X", follow the CONTAINMENT RULE after this list—state what is inside; never describe that container as empty. For each object, mention the object itself (e.g. "the torch") so the player can take or use it. If an object is listed here (e.g. torch_01), the room HAS that object: never say it is absent or missing.
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
    out += `\nCONTAINMENT RULE (mandatory): Entities above that show "contains: X" have X inside them. In narrative_prose you MUST state what is inside (e.g. "the bracket holds the torch", "an unlit torch sits in the bracket"). FORBIDDEN for those containers: "empty", "an empty bracket", "empty torch bracket", "no torch rests in it", "waiting", "waiting for flame", "expectant", "nothing in it", "bare", "vacant". Do not describe a container that has "contains:" as empty in any wording—state what is inside (e.g. "the bracket holds the torch"). Containers and their contents have separate descriptions: never apply the contained object's description or state to the container (e.g. do not give the bracket the torch's "dried tow" or "waiting for flame"), and never apply the container's description to the contents. Each entity is described only by its own line in ENTITIES PRESENT. The "contains" field is authoritative—ignore any base_description that could suggest otherwise.\n`;
  }
  out += `\nPLAYER:\n`;
  const playerAdj = Array.isArray(ctx.player.adjectives) ? ctx.player.adjectives : [];
  out += `- node_id: player | location: ${(ctx.player as { location_id?: string }).location_id ?? "?"} | adjectives: ${JSON.stringify(playerAdj)}\n`;
  if (ctx.inventoryEntities && ctx.inventoryEntities.length > 0) {
    out += `  Inventory (each item's adjectives must be preserved in node_impacts unless this turn changes them): ${ctx.inventoryEntities.map((e) => `${e.node_id} ${JSON.stringify(e.adjectives ?? [])}`).join("; ")}\n`;
  } else {
    out += `  Inventory: ${JSON.stringify(ctx.inventoryNodeIds)}\n`;
  }
  out += `  Recent history: ${ctx.player.recent_history.join(" ") || "(none)"}\n`;
  const exits = ctx.locationExits ?? [];
  if (exits.length === 0) {
    out += `\nEXITS FROM THIS LOCATION: (none)\n`;
  } else {
    out += `\nEXITS FROM THIS LOCATION (only these exist; do not invent others). Ignore any door or exit mentioned in the location Description above—this list is authoritative. Describe every exit below (including up/down, e.g. steps down to cellar); do not skip any. Each line is "label [direction] -> target": use that exact pairing in your narrative. Your narrative_prose MUST describe each exit below:\n`;
    for (const e of exits) {
      const dirPart = e.direction ? ` [${e.direction}]` : "";
      out += `  - ${e.label}${dirPart} -> ${e.target}\n`;
    }
    const exitList = exits.map((e) => `${e.direction ?? "?"} to ${e.target}`).join("; ");
    out += `REQUIRED: Your narrative_prose must mention every exit above. Include at least: ${exitList}.\n`;
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
  const cmd = playerCommand.trim().toLowerCase();
  const isOfferOrQuestion = /^\s*(offer to|may i\b|shall i\b|would you like me to|want me to|can i get you|I could\b|I can get you\b|how about i\b)/i.test(playerCommand.trim());
  const isDescribeOnly = /^\s*(look|examine|l|x|start|begin)(\s+around|\s+at|\s+here)?\s*$/i.test(playerCommand.trim()) || cmd === "l" || cmd === "x";
  const offerBlock = isOfferOrQuestion
    ? `\n*** OFFER/QUESTION DETECTED: The player ONLY offered or asked—they did NOT give a command to do it. You must NOT perform the action (do not light, open, unlock, give, or change any object/location state). Do NOT set adjectives_new to "lit", "open", or any state change for any node. Narrate ONLY the offer and the NPC's or world's response (e.g. Ciaran says he would welcome light, or nods). The torch does NOT get lit; no object or location changes state this turn. ***\n\n`
    : "";
  const describeOnlyBlock = !isOfferOrQuestion && isDescribeOnly
    ? `\n*** DESCRIBE-ONLY: The player only asked to look or describe the scene. Do NOT perform any action (do not take, use, open, or move any object). Do NOT set new_location_id for any object or for the player. Describe the FULL scene: the location and every entity in ENTITIES PRESENT—name each NPC and mention each object. Do not skip any character or object. ***\n\n`
    : "";
  return `PLAYER ACTION: ${playerCommand}
${offerBlock}${describeOnlyBlock}START/BEGIN: If the player said "start" or "begin", describe the full scene including every NPC and object in ENTITIES PRESENT by name. Do NOT set new_location_id for any object. No state changes.
${containmentLine}TAKE: Set new_location_id to "player" in the **taken object's** entry only (e.g. torch_01), not in the player's entry. Without new_location_id on the taken object, the object will not move to the player. Omit new_location_id for that object if it stays in place (e.g. lighting it in its bracket). When you do set new_location_id to "player" for an object: in narrative_prose use exactly "The player now holds the [object]." (e.g. "The player now holds the torch."); in that object's prose_impact use exactly "Taken by player."
Reminder: Literal actions only; offers/questions do not perform the action; objects do not change state on their own or when taken.
${exitLine}${destinationLine}
CRITICAL — node_impacts: ONE entry for the location, each entity in ENTITIES PRESENT, each item in Inventory (see Inventory line above—preserve each item's adjectives unless this turn changes them), and the player (no other node_ids). If the player targeted someone/something not present, action fails but node_impacts still lists location, ENTITIES PRESENT, Inventory items, player. For each entry: adjectives_old = that node's current adjectives from CURRENT SCENE or Inventory; adjectives_new = state after this turn. Use only game-relevant qualities (disposition, lit/closed)—not narrative moments like "noticed looking up" (use prose_impact). When your narrative describes an NPC or object state change (e.g. NPC warms up), set adjectives_new to match or the engine will not update. For start, look, examine, or movement-only (no interaction with an NPC or object): set adjectives_new equal to adjectives_old for every node. No other change → adjectives_new equal to adjectives_old. Never use [] for a node that has adjectives unless explicitly clearing. Use reconciliation_notes if you see a mismatch (e.g. "Narrative showed Ciaran warming up; I should have updated ciaran adjectives_new").

Return ONLY this JSON structure:
{
  "narrative_prose": "<string: describe location, EVERY entity (name each NPC and mention each object), then EVERY exit (direction and destination for each—see REQUIRED line above; e.g. west to scriptorium; down to cellar); then what happened. Never omit an NPC, object, or exit. If 'Containment in this scene' appears above, those containers are NOT empty—state what is inside each. Never describe a listed container as empty.>",
  "action_result": "<success | failure | partial>",
  "node_impacts": [
    {
      "node_id": "<exact node_id from CURRENT SCENE: e.g. scriptorium, ciaran, torch_01, or player—never 'location' or 'entities|name'>",
      "prose_impact": "<string: what this node experienced; for a taken object use exactly 'Taken by player.'>",
      "adjectives_old": ["<current adjectives for this node from CURRENT SCENE>"],
      "adjectives_new": ["<adjectives after this turn; MUST match the state your narrative describes for that node—e.g. if narrative says NPC warmed up, remove \"guarded\" or add appropriate term; same as adjectives_old only if narrative shows no change>"],
      "new_location_id": "<optional: for a TAKEN object put new_location_id: \"player\" in THAT OBJECT'S entry (e.g. torch_01), not in the player's entry; for MOVEMENT set the player entry's new_location_id to the exit target e.g. \"kitchen\"; omit only if no take and no move>"
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

For each candidate: if it has the SAME meaning as an existing vocabulary term (true synonym), respond with that term exactly as listed; otherwise respond with the candidate unchanged. Only map when the two mean the same thing (e.g. "mad" -> "hostile"). Do NOT map when: (1) the candidate is a lessening or negation of the term ("less guarded", "unarmed", "not hostile" are not synonyms for "guarded" or "hostile"); (2) the candidate is object/location state and the term is NPC disposition, or vice versa (e.g. "waiting for flame", "in player's inventory" must not become "curious" or "guarded"). Return those candidates unchanged.

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
    const termsLowerSet = new Set(terms.map((t) => t.trim().toLowerCase()));
    const result = items
      .map((x) => ({
        adjective: typeof x.adjective === "string" ? String(x.adjective).trim() : "",
        rule_description: typeof x.rule_description === "string" ? String(x.rule_description).trim() : "",
      }))
      .filter((x) => x.adjective.length > 0)
      .filter((r) => termsLowerSet.has(r.adjective.toLowerCase()))
      .map((r) => ({
        adjective: terms.find((t) => t.trim().toLowerCase() === r.adjective.toLowerCase())!.trim(),
        rule_description: r.rule_description,
      }));
    // If the model returned fewer definitions than terms (or returned wrong adjectives), fetch each missing term in its own request.
    const definedLower = new Set(result.map((r) => r.adjective.toLowerCase()));
    const missing = terms.filter((t) => !definedLower.has(t.trim().toLowerCase()));
    if (allowFallback && missing.length > 0) {
      if (DEBUG) debugLog("fetchAdjectiveDefinitions", `Got ${result.length}/${terms.length} definitions; fetching missing one-by-one: ${missing.join(", ")}`);
      const extra: { adjective: string; rule_description: string }[] = [];
      for (const term of missing) {
        const one = await fetchAdjectiveDefinitions([term], existingVocabulary, callSource, false);
        const match = one.find((r) => r.adjective.toLowerCase() === term.trim().toLowerCase());
        if (match) extra.push({ adjective: term.trim(), rule_description: match.rule_description });
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
