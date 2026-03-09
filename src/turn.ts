/**
 * Turn pipeline: assemble scene, call Mistral, write ledger and world_graph, vocabulary.
 * Spec Section 5.
 */

import type Database from "better-sqlite3";
import {
  getPlayer,
  getNode,
  getEntitiesInLocation,
  getEntitiesInLocationIncludingContents,
  getRootLocationId,
  getPlayerInventory,
  getRecentHistoryForNode,
  getFullVocabulary,
  writeHistoryLedger,
  updateWorldGraphAdjectives,
  updateWorldGraphLocation,
  updateWorldGraphMeta,
  getPlayerCameFromLocationId,
  getLocationNodeIds,
  insertVocabulary,
  resolveLocationNodeId,
} from "./db/database.js";
import type { WorldNode } from "./db/schema.js";
import {
  runMistralTurn,
  checkOllamaReachable,
  fetchAdjectiveDefinitions,
  resolveRedundantAdjectives,
  debugLog,
  type SceneContext,
  type SceneEntity,
  type DestinationScene,
  type MistralResponse,
  type VocabularyItem,
} from "./ollama.js";

/** True if the player only offered or asked (did not give a command to perform the action). */
function isOfferOrQuestion(playerCommand: string): boolean {
  return /^\s*(offer to|may i\b|shall i\b|would you like me to|want me to|can i get you|I could\b|I can get you\b|how about i\b)/i.test(playerCommand.trim());
}

/** True if the player only asked to look/describe (no take, use, or move). */
function isDescribeOnly(playerCommand: string): boolean {
  const t = playerCommand.trim();
  const lower = t.toLowerCase();
  if (lower === "l" || lower === "x") return true;
  return /^\s*(look|examine|start|begin)(\s+around|\s+at|\s+here)?\s*$/i.test(t);
}

/** Standard phrase the model must use in narrative_prose when the player takes an object. Enables reliable detection and stripping when we negate a take. */
export const TAKE_NARRATIVE_PHRASE = "The player now holds the";
/** Standard prose_impact for a taken object's node_impacts entry. Use this exact string so logs are easy to scan. */
export const TAKE_PROSE_IMPACT = "Taken by player.";

/** True only when the player's command explicitly takes this object (e.g. "take torch", "get the torch"). Used to block model from moving objects to player when the player said something else. */
function isTakeCommandForObject(playerCommand: string, nodeId: string, entityName?: string): boolean {
  const cmd = playerCommand.trim().toLowerCase();
  const takeVerb =
    /\b(take|get|grab|pick\s+up|carry)\b/.test(cmd) || /^\s*(take|get|grab|pick\s+up|carry)\s+/i.test(playerCommand.trim());
  if (!takeVerb) return false;
  const keywords: string[] = [];
  const fromId = nodeId.replace(/_?\d*$/, "").toLowerCase();
  if (fromId.length >= 2) keywords.push(fromId);
  if (entityName && entityName.trim()) {
    const name = entityName.trim().toLowerCase().replace(/^(the|a|an)\s+/, "");
    const word = name.split(/\s+/)[0];
    if (word.length >= 2 && !keywords.includes(word)) keywords.push(word);
  }
  if (keywords.length === 0) return false;
  return keywords.some((kw) => new RegExp("\\b" + kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i").test(playerCommand));
}

/** True when the player's command is to drop or put down an object (e.g. "drop torch", "put down the torch"). */
function isDropCommand(playerCommand: string): boolean {
  const cmd = playerCommand.trim().toLowerCase();
  return /\b(drop|put\s+down|set\s+down|place\s+down)\b/.test(cmd) || /^\s*(drop|put\s+down|set\s+down)\s+/i.test(playerCommand.trim());
}

/** Remove from narrative any phrase that says the player holds, carries, or took the given object (so returned prose is consistent with stripped object moves). */
function sanitizeNarrativeStrippedTakes(
  narrative: string,
  strippedEntities: { node_id: string; name?: string }[]
): string {
  if (strippedEntities.length === 0) return narrative;
  let out = narrative;
  for (const e of strippedEntities) {
    const kw = e.node_id.replace(/_?\d*$/, "").trim();
    if (kw.length < 2) continue;
    const esc = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const obj = `(?:unlit\\s+)?(?:an?\\s+)?(?:the\\s+)?${esc}`;
    const patterns: RegExp[] = [
      new RegExp(`\\s*${TAKE_NARRATIVE_PHRASE}\\s+${obj}[\\s.]*`, "gi"),
      new RegExp(`,\\s*who\\s+now\\s+holds?\\s+${obj}[\\s.]*`, "gi"),
      new RegExp(`\\s+[Yy]ou\\s+hold\\s+${obj}[\\s.]*`, "gi"),
      new RegExp(`\\s+[Yy]ou\\s+(?:have|took|picked\\s+up|carry)\\s+${obj}[\\s.]*`, "gi"),
      new RegExp(`\\s+(?:[Tt]he\\s+)?${obj}\\s+(?:is\\s+)?(?:now\\s+)?in\\s+your\\s+hand[s]?[\\s.]*`, "gi"),
      new RegExp(`\\s+with\\s+${obj}\\s+in\\s+(?:your\\s+)?hand[s]?[\\s.]*`, "gi"),
    ];
    for (const re of patterns) {
      out = out.replace(re, (match) => (match.trimEnd().endsWith(".") ? ". " : " "));
    }
  }
  return out.replace(/\s{2,}/g, " ").replace(/\s+\./g, ".").replace(/\s+,/g, ",").trim();
}

const OLLAMA_UNREACHABLE_PROSE =
  "The world pauses, as if holding its breath. (Engine: Ollama unreachable. Please check the local model service.)";

const MALFORMED_RESPONSE_PROSE =
  "The world flickers uncertainly. (Engine: The story engine could not interpret the outcome. Please try again.)";

const ALL_EXIT_DIRECTIONS = [
  "north", "south", "east", "west",
  "northeast", "northwest", "southeast", "southwest",
  "up", "down",
] as const;

/** Normalize direction to lowercase; preserve cardinals, ordinals, up, down; otherwise empty. */
function normalizeDirection(d: unknown): string {
  const s = (d != null && typeof d === "string" ? d.trim() : "").toLowerCase();
  return ALL_EXIT_DIRECTIONS.includes(s as (typeof ALL_EXIT_DIRECTIONS)[number]) ? s : "";
}

/** Parse exits JSON from a location node; returns { label, target, direction? }[]. */
function safeParseExits(val: string | undefined | null): { label: string; target: string; direction: string }[] {
  try {
    if (val == null || (typeof val === "string" && !val.trim())) return [];
    const raw = typeof val === "string" ? val.trim() : String(val);
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((e): e is Record<string, unknown> => e != null && typeof e === "object")
      .map((e) => {
        const target =
          (e.target ?? e.target_node_id ?? e.destination) != null
            ? String(e.target ?? e.target_node_id ?? e.destination).trim()
            : "";
        const label = (e.label ?? e.name) != null ? String(e.label ?? e.name).trim() : "";
        const direction = normalizeDirection(e.direction);
        return { label: label || target || "(exit)", target, direction };
      })
      .filter((e) => e.target.length > 0);
  } catch {
    return [];
  }
}

const CARDINAL_AND_ORDINAL_DIRECTIONS = [
  "north",
  "south",
  "east",
  "west",
  "northeast",
  "northwest",
  "southeast",
  "southwest",
  "up",
  "down",
] as const;

/** True if the command is purely a movement attempt (direction word, "go north", "leave", etc.). */
function isMovementCommand(playerCommand: string): boolean {
  const cmd = playerCommand.trim().toLowerCase();
  if (CARDINAL_AND_ORDINAL_DIRECTIONS.some((d) => cmd === d || cmd === "go " + d)) return true;
  const generic = ["go through the door", "through the door", "leave", "go out", "exit"];
  if (generic.some((g) => cmd === g || cmd.startsWith(g + " "))) return true;
  if (cmd.startsWith("go through") || cmd.startsWith("through ")) return true;
  if (cmd === "go") return true;
  return false;
}

/** If the player command is a movement (go through door, east, leave, etc.), return the exit target node_id; otherwise null. */
function resolveMovementTarget(
  playerCommand: string,
  locationExits: { target: string; direction?: string }[]
): string | null {
  if (locationExits.length === 0) return null;
  const cmd = playerCommand.trim().toLowerCase();
  for (const d of CARDINAL_AND_ORDINAL_DIRECTIONS) {
    if (cmd === d || cmd === "go " + d) {
      const ex = locationExits.find((e) => (e.direction ?? "").toLowerCase() === d);
      return ex ? ex.target : null;
    }
  }
  const generic = ["go through the door", "through the door", "leave", "go out", "exit"];
  if (generic.some((g) => cmd === g || cmd.startsWith(g + " "))) {
    return locationExits[0].target;
  }
  if (cmd.startsWith("go through") || cmd.startsWith("through ")) {
    return locationExits[0].target;
  }
  if (cmd === "go" && locationExits.length === 1) return locationExits[0].target;
  return null;
}

/** Build destination scene (location + entities + exits) for a location so the prompt can describe arrival. When destination is dark and no light source is present, returns stripped scene (no entities, only exit back to currentLocationId) and darkActive: true. Uses current DB state for player inventory so a lit torch etc. correctly negates dark at destination. */
function assembleDestinationScene(
  db: Database.Database,
  locationId: string,
  currentLocationId: string | null
): DestinationScene | null {
  const location = getNode(db, locationId);
  if (!location || location.node_type !== "location") return null;
  const inLocationRaw = getEntitiesInLocationIncludingContents(db, locationId);
  const inLocationSameRoot = inLocationRaw.filter((n) => getRootLocationId(db, n.node_id) === locationId);
  const npcIdsInRoom = new Set(
    inLocationSameRoot.filter((n) => n.node_type === "npc").map((n) => n.node_id)
  );
  const inLocation = inLocationSameRoot.filter((n) => {
    if (n.location_id != null && npcIdsInRoom.has(n.location_id)) return false;
    return true;
  });
  const locAdjectives = safeParseAdjectives(location.adjectives);
  const destDark = locAdjectives.some((a) => a.toLowerCase() === "dark");
  /* Player brings inventory with them; use current DB so lit torch etc. negates dark at destination. */
  const playerInventory = getPlayerInventory(db);
  const negated = isDarkNegated(playerInventory, inLocation);
  const darkAndNotNegated = destDark && !negated;
  if (destDark) {
    debugLog(
      "dark destination",
      `${locationId}: negated=${negated} (inventory: ${playerInventory.map((n) => `${n.node_id}[${safeParseAdjectives(n.adjectives).join(",")}]`).join(", ")})`
    );
  }

  const locationRecent = getRecentHistoryForNode(db, location.node_id, 3)
    .map((h) => sanitizeProseForPrompt(h.prose_impact))
    .filter(Boolean);
  const locationEntity = toSceneEntity(location, locationRecent);

  let entities: SceneEntity[];
  let exits = safeParseExits((location as WorldNode & { exits?: string }).exits);
  if (darkAndNotNegated) {
    entities = [];
    if (currentLocationId != null) {
      const entranceOnly = exits.filter((e) => e.target === currentLocationId);
      exits = entranceOnly.length > 0 ? entranceOnly : exits;
    } else {
      exits = [];
    }
    return { location: locationEntity, entities, exits, darkActive: true };
  }

  const entityOrder: Record<string, number> = { location: 0, npc: 1, object: 2, player: 3 };
  const rawEntities: SceneEntity[] = inLocation.map((node) => {
    const recent = getRecentHistoryForNode(db, node.node_id, 3)
      .map((h) => sanitizeProseForPrompt(h.prose_impact))
      .filter(Boolean);
    return toSceneEntity(node, recent);
  });
  entities = rawEntities.sort(
    (a, b) =>
      (entityOrder[a.node_type] ?? 2) - (entityOrder[b.node_type] ?? 2) ||
      a.node_id.localeCompare(b.node_id)
  );
  return { location: locationEntity, entities, exits };
}

/** Canonical prose when the scene is dark (no light): player sees nothing except the listed exit(s). Used so we never show room detail when dark is active. */
function buildDarkProse(exits: { direction?: string; target: string }[]): string {
  const base = "Impenetrable darkness. You can see nothing.";
  if (exits.length === 0) return base + ".";
  const parts = exits.map((e) => `${e.direction ?? "?"} to ${e.target}`).filter(Boolean);
  return parts.length === 0 ? base + "." : `${base}\n\nExits: ${parts.join("; ")}.`;
}

/** Ensure narrative mentions every exit so the player can see them (e.g. down to cellar). If any exit's destination is missing from prose, append an Exits line. */
function ensureExitsInProse(
  prose: string,
  exits: { direction?: string; target: string }[]
): string {
  if (exits.length === 0) return prose;
  const lower = prose.toLowerCase();
  const missing = exits.some((e) => {
    const target = (e.target ?? "").trim();
    return target.length > 0 && !lower.includes(target.toLowerCase());
  });
  if (!missing) return prose;
  const parts = exits.map((e) => `${e.direction ?? "?"} to ${e.target}`).filter(Boolean);
  if (parts.length === 0) return prose;
  const suffix = "\n\nExits: " + parts.join("; ") + ".";
  return prose.trimEnd() + suffix;
}

/** Prose that looks like JSON or is too long must not be written to the ledger (would pollute future prompts). */
const MAX_PROSE_LEDGER = 500;
function sanitizeProseForLedger(s: string): string {
  if (typeof s !== "string") return "No change.";
  const t = s.trim();
  if (t.includes("{") || t.length > MAX_PROSE_LEDGER) return "No change.";
  return t || "No change.";
}

/** Prose used in the prompt (recent history); omit JSON or huge blobs so the model isn't confused. */
const MAX_PROSE_PROMPT = 280;
function sanitizeProseForPrompt(s: string | null | undefined): string {
  if (s == null) return "";
  const t = String(s).trim();
  if (t.includes("{") || t.length > MAX_PROSE_PROMPT) return "";
  return t;
}

/** Parse adjectives from DB (may be invalid/corrupt); always returns a string[]. */
function safeParseAdjectives(val: string | unknown): string[] {
  try {
    if (typeof val === "string") {
      const parsed = JSON.parse(val || "[]");
      return Array.isArray(parsed) ? parsed.map((x) => String(x)) : [];
    }
    return Array.isArray(val) ? val.map((x) => String(x)) : [];
  } catch {
    return [];
  }
}

/** True if a light source is present: a lit object in player inventory, or in the location, or in an open container here. Uses node_type and adjectives from world_graph (vocabulary "lit" = provides light in dark locations). */
function isDarkNegated(
  inventoryNodes: WorldNode[],
  entitiesInLocationNodes: WorldNode[]
): boolean {
  const hasLit = (n: WorldNode) => {
    if (n.node_type !== "object") return false;
    const adj = safeParseAdjectives(n.adjectives);
    return adj.some((a) => String(a).trim().toLowerCase() === "lit");
  };
  for (const n of inventoryNodes) {
    if (hasLit(n)) return true;
  }
  for (const n of entitiesInLocationNodes) {
    if (hasLit(n)) return true;
  }
  return false;
}

/** Drop model slip-ups: JSON fragments or non-words (e.g. "[]", "[") are not adjectives. */
function isValidAdjectiveToken(s: string): boolean {
  const t = String(s).trim();
  if (!t) return false;
  if (t === "[]" || t === "[" || t === "]") return false;
  return /[a-zA-Z]/.test(t);
}

function toSceneEntity(node: WorldNode, recentHistory: string[]): SceneEntity {
  const adjectives = safeParseAdjectives(node.adjectives);
  return {
    node_id: node.node_id,
    node_type: node.node_type,
    name: node.name,
    base_description: node.base_description,
    adjectives: Array.isArray(adjectives) ? adjectives : [],
    recent_history: recentHistory,
    location_id: node.location_id ?? undefined,
  };
}

function assembleSceneContext(db: Database.Database): SceneContext | null {
  const player = getPlayer(db);
  if (!player) return null;
  const locationId = player.location_id;
  if (!locationId) return null;
  const location = getNode(db, locationId);
  if (!location) return null;

  const inLocationRaw = getEntitiesInLocationIncludingContents(db, locationId);
  // Only show entities whose containment chain ends at this location (e.g. torch in bracket in scriptorium shows in scriptorium only, not in cloister).
  const inLocationSameRoot = inLocationRaw.filter((n) => getRootLocationId(db, n.node_id) === locationId);
  const npcIdsInRoom = new Set(
    inLocationSameRoot.filter((n) => n.node_type === "npc").map((n) => n.node_id)
  );
  // Exclude anything whose location is the player or an NPC (player/NPC inventory).
  const inLocation = inLocationSameRoot.filter((n) => {
    if (n.location_id === player.node_id) return false;
    if (n.location_id != null && npcIdsInRoom.has(n.location_id)) return false;
    return true;
  });
  const inventory = getPlayerInventory(db);
  const inventoryNodeIds = inventory.map((n) => n.node_id);

  const allEntities = [location, ...inLocation, player];
  const entityOrder: Record<string, number> = { location: 0, npc: 1, object: 2, player: 3 };
  const rawEntities: SceneEntity[] = [];
  for (const node of allEntities) {
    if (node.node_id === "player") continue;
    const recent = getRecentHistoryForNode(db, node.node_id, 3)
      .map((h) => sanitizeProseForPrompt(h.prose_impact))
      .filter(Boolean);
    rawEntities.push(toSceneEntity(node, recent));
  }
  let entities = rawEntities.sort(
    (a, b) =>
      (entityOrder[a.node_type] ?? 2) - (entityOrder[b.node_type] ?? 2) ||
      a.node_id.localeCompare(b.node_id)
  );

  const playerRecent = getRecentHistoryForNode(db, "player", 3)
    .map((h) => sanitizeProseForPrompt(h.prose_impact))
    .filter(Boolean);
  const playerEntity = toSceneEntity(player, playerRecent);
  (playerEntity as SceneEntity & { location_id: string }).location_id = locationId;

  const vocabulary: VocabularyItem[] = getFullVocabulary(db).map((v) => ({
    adjective: v.adjective,
    rule_description: v.rule_description,
  }));

  let locationExits = safeParseExits((location as WorldNode & { exits?: string }).exits);
  const locAdjectives = safeParseAdjectives(location.adjectives);
  const darkActive = locAdjectives.some((a) => a.toLowerCase() === "dark");
  const cameFromId = getPlayerCameFromLocationId(db);
  let darkActiveAndNotNegated = false;
  if (darkActive && !isDarkNegated(inventory, inLocation)) {
    darkActiveAndNotNegated = true;
    entities = [];
    if (cameFromId != null) {
      const entranceOnly = locationExits.filter((e) => e.target === cameFromId);
      locationExits = entranceOnly.length > 0 ? entranceOnly : locationExits;
    } else {
      locationExits = [];
    }
  }

  const inventoryEntities: SceneEntity[] = inventory.map((node) =>
    toSceneEntity(
      node,
      getRecentHistoryForNode(db, node.node_id, 3).map((h) => sanitizeProseForPrompt(h.prose_impact)).filter(Boolean)
    )
  );

  debugLog("scene entities", `location: ${location.node_id} | entity node_ids: ${entities.map((e) => e.node_id).join(", ")}`);

  return {
    darkActive: darkActiveAndNotNegated,
    location: toSceneEntity(
      location,
      getRecentHistoryForNode(db, location.node_id, 3).map((h) => sanitizeProseForPrompt(h.prose_impact)).filter(Boolean)
    ),
    entities,
    player: playerEntity,
    inventoryNodeIds,
    inventoryEntities,
    vocabulary,
    locationExits,
  };
}

/** Expand single-token abbreviations for the player command. Only expands when the whole command is exactly the abbreviation. */
function expandPlayerCommandAbbreviations(playerCommand: string): string {
  const cmd = playerCommand.trim().toLowerCase();
  const abbrevs: Record<string, string> = {
    i: "inventory",
    l: "look",
    n: "north",
    ne: "northeast",
    e: "east",
    se: "southeast",
    s: "south",
    sw: "southwest",
    w: "west",
    nw: "northwest",
    u: "up",
    d: "down",
  };
  return abbrevs[cmd] ?? playerCommand.trim();
}

function normalizeActionDescription(playerCommand: string): string {
  const t = playerCommand.trim();
  return t.length > 200 ? t.slice(0, 197) + "..." : t;
}

export interface TakeTurnResult {
  result: "success" | "failure" | "partial" | "error";
  prose: string;
  error?: string;
  /** If the model reported inconsistencies (e.g. narrative described a state change not reflected in adjectives_new). */
  reconciliation_notes?: string | null;
}

export async function takeTurn(
  db: Database.Database,
  playerCommand: string,
  recentHistory: string
): Promise<TakeTurnResult> {
  playerCommand = (playerCommand ?? "").trim();
  if (!playerCommand) {
    return { result: "error", prose: "", error: "player_command is required and must be non-empty" };
  }
  playerCommand = expandPlayerCommandAbbreviations(playerCommand);

  const ctx = assembleSceneContext(db);
  if (!ctx) {
    return {
      result: "error",
      prose: "The world has no player or location. Check database setup.",
      error: "Missing player or location",
    };
  }

  const destTarget = resolveMovementTarget(playerCommand, ctx.locationExits ?? []);
  if (isMovementCommand(playerCommand) && destTarget === null) {
    return { result: "failure", prose: "You can't go that way." };
  }
  const destinationScene =
    destTarget != null ? assembleDestinationScene(db, destTarget, ctx.location.node_id) : null;

  const reachable = await checkOllamaReachable();
  if (!reachable) {
    return { result: "error", prose: OLLAMA_UNREACHABLE_PROSE, error: "Ollama unreachable" };
  }

  let mistralResponse: MistralResponse;
  try {
    mistralResponse = await runMistralTurn(
      ctx,
      playerCommand,
      recentHistory ?? "",
      destinationScene ?? undefined
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("timeout") || message.includes("unreachable")) {
      return { result: "error", prose: OLLAMA_UNREACHABLE_PROSE, error: message };
    }
    return { result: "error", prose: MALFORMED_RESPONSE_PROSE, error: message };
  }

  if (mistralResponse.reconciliation_notes) {
    console.error("[TaleShed] Reconciliation notes:", mistralResponse.reconciliation_notes);
  }

  const sceneNodeIds = new Set<string>();
  sceneNodeIds.add(ctx.location.node_id);
  for (const e of ctx.entities) sceneNodeIds.add(e.node_id);
  sceneNodeIds.add("player");
  for (const id of ctx.inventoryNodeIds) sceneNodeIds.add(id);

  /* Only apply impacts for nodes that were in the current scene (location, entities here, player, or player inventory). Ignore model output for nodes elsewhere (e.g. "talk to Ciaran" in kitchen must not update Ciaran). */
  const sceneImpactsOnly = mistralResponse.node_impacts.filter((i) => sceneNodeIds.has(i.node_id));
  const actionDescription = normalizeActionDescription(playerCommand);
  const now = new Date().toISOString();
  const impactByNode = new Map(
    sceneImpactsOnly.map((i) => {
      const adjOld = safeParseAdjectives(i.adjectives_old).filter(isValidAdjectiveToken);
      const adjNew = safeParseAdjectives(i.adjectives_new).filter(isValidAdjectiveToken);
      return [
        i.node_id,
        {
          prose_impact: i.prose_impact ?? "No change.",
          adjectives_old: adjOld,
          adjectives_new: adjNew,
          new_location_id:
            i.new_location_id != null && String(i.new_location_id).trim() !== ""
              ? String(i.new_location_id).trim()
              : undefined,
        },
      ];
    })
  );

  for (const nodeId of sceneNodeIds) {
    let entry = impactByNode.get(nodeId);
    if (!entry) {
      const node = getNode(db, nodeId);
      const adj = node ? safeParseAdjectives(node.adjectives) : [];
      entry = {
        prose_impact: "No change.",
        adjectives_old: adj,
        adjectives_new: adj,
        new_location_id: undefined,
      };
    }
    impactByNode.set(nodeId, entry);
  }
  /* When the player drops an object but the model omitted it from node_impacts, set the dropped object's new_location_id to the current room so the engine actually moves it. */
  if (isDropCommand(playerCommand) && ctx.inventoryNodeIds.length > 0) {
    const cmd = playerCommand.trim().toLowerCase();
    for (const nid of ctx.inventoryNodeIds) {
      const entry = impactByNode.get(nid);
      if (!entry || entry.new_location_id === locationNodeId) continue;
      const node = getNode(db, nid);
      const name = node?.name?.trim().toLowerCase().replace(/^(the|a|an)\s+/, "");
      const fromId = nid.replace(/_?\d*$/, "").toLowerCase();
      const keywords = fromId.length >= 2 ? [fromId, ...(name ? name.split(/\s+/).filter((w) => w.length >= 2) : [])] : name ? name.split(/\s+/).filter((w) => w.length >= 2) : [];
      const mentioned = keywords.length > 0 && keywords.some((kw) => new RegExp("\\b" + kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i").test(cmd));
      if (mentioned) {
        entry.new_location_id = locationNodeId;
        break;
      }
    }
  }

  const locationNodeIds = getLocationNodeIds(db);
  for (const [, entry] of impactByNode) {
    entry.adjectives_old = entry.adjectives_old.filter((a) => !locationNodeIds.has(String(a).trim().toLowerCase()));
    entry.adjectives_new = entry.adjectives_new.filter((a) => !locationNodeIds.has(String(a).trim().toLowerCase()));
  }

  /* When the player only offered or asked, do not apply state changes or moves—even if the model disobeyed. */
  if (isOfferOrQuestion(playerCommand)) {
    for (const [, entry] of impactByNode) {
      entry.adjectives_new = [...entry.adjectives_old];
      entry.new_location_id = undefined;
    }
  }
  /* When the player only asked to look/describe, do not move any object or the player—even if the model had them take something. */
  if (isDescribeOnly(playerCommand)) {
    for (const [, entry] of impactByNode) {
      entry.new_location_id = undefined;
    }
  }
  /* When the player gave a movement command and we resolved a valid exit, always move the player there even if the model forgot new_location_id. */
  if (isMovementCommand(playerCommand) && destTarget != null) {
    const playerEntry = impactByNode.get("player");
    if (playerEntry) playerEntry.new_location_id = destTarget;
  }
  /* Only allow moving an object to the player when the player's command explicitly took that object (e.g. "take torch"). Block model from putting objects in hand on "apologize", "look", etc. */
  const strippedObjectEntities: { node_id: string; name?: string }[] = [];
  const locationNodeId = ctx.location.node_id;
  for (const [node_id, entry] of impactByNode) {
    if (node_id === "player" || node_id === locationNodeId) continue;
    if (entry.new_location_id !== "player") continue;
    const entity = ctx.entities.find((e) => e.node_id === node_id);
    const nodeForName = entity ? undefined : getNode(db, node_id);
    const name = entity?.name ?? nodeForName?.name;
    if (!isTakeCommandForObject(playerCommand, node_id, name)) {
      entry.new_location_id = undefined;
      strippedObjectEntities.push({ node_id, name });
    }
  }
  /* When the player took only the contents (e.g. "take torch"), do not also take the container. Strip new_location_id from any container whose contained object was the one explicitly taken. */
  for (const [node_id, entry] of impactByNode) {
    if (entry.new_location_id !== "player" || node_id === "player" || node_id === locationNodeId) continue;
    const contents = getEntitiesInLocation(db, node_id);
    const playerTookAContained = contents.some((c) => {
      const e = impactByNode.get(c.node_id);
      if (e?.new_location_id !== "player") return false;
      return isTakeCommandForObject(playerCommand, c.node_id, c.name);
    });
    if (playerTookAContained) {
      entry.new_location_id = undefined;
      const node = getNode(db, node_id);
      strippedObjectEntities.push({ node_id, name: node?.name });
    }
  }
  /* When the player drops an object (inventory item moving somewhere other than player), the only valid target is the current room. Do not allow the model to put the object into another entity (e.g. hearth_fire). */
  for (const [node_id, entry] of impactByNode) {
    if (node_id === "player" || node_id === locationNodeId) continue;
    if (entry.new_location_id == null || entry.new_location_id === "player") continue;
    if (!ctx.inventoryNodeIds.includes(node_id)) continue;
    entry.new_location_id = locationNodeId;
  }

  const vocabulary = getFullVocabulary(db);
  const vocabLower = new Set(vocabulary.map((v) => v.adjective.toLowerCase()));
  const candidatesNotInVocab = new Set<string>();
  for (const [, entry] of impactByNode) {
    for (const a of entry.adjectives_new) {
      const t = String(a).trim();
      if (t && !vocabLower.has(t.toLowerCase())) candidatesNotInVocab.add(t);
    }
  }
  if (candidatesNotInVocab.size > 0) {
    const resolveMap = await resolveRedundantAdjectives([...candidatesNotInVocab], vocabulary);
    for (const [, entry] of impactByNode) {
      const normalized = entry.adjectives_new
        .map((a) => resolveMap.get(String(a).trim().toLowerCase()) ?? String(a).trim())
        .filter(Boolean);
      entry.adjectives_new = [...new Set(normalized)];
    }
  }

  const ledgerEntries = Array.from(impactByNode.entries()).map(([node_id, entry]) => ({
    timestamp: now,
    action_description: actionDescription,
    node_id,
    prose_impact: sanitizeProseForLedger(entry.prose_impact),
    adjectives_old: JSON.stringify(entry.adjectives_old),
    adjectives_new: JSON.stringify(entry.adjectives_new),
    system_event: null as string | null,
  }));

  const newAdjsRaw = Array.isArray(mistralResponse.new_adjectives) ? mistralResponse.new_adjectives : [];
  const newAdjCandidates = new Set<string>();
  for (const na of newAdjsRaw) {
    const adj =
      na && typeof na === "object" && typeof (na as { adjective?: unknown }).adjective === "string"
        ? (na as { adjective: string }).adjective.trim()
        : "";
    if (adj && !vocabLower.has(adj.toLowerCase())) newAdjCandidates.add(adj);
  }
  let newAdjToInsert: { adjective: string; rule_description: string }[] = [];
  if (newAdjCandidates.size > 0) {
    const resolveMapNew = await resolveRedundantAdjectives([...newAdjCandidates], vocabulary);
    for (const na of newAdjsRaw) {
      const adj =
        na && typeof na === "object" && typeof (na as { adjective?: unknown }).adjective === "string"
          ? (na as { adjective: string; rule_description?: string }).adjective.trim()
          : "";
      if (!adj) continue;
      const resolved = resolveMapNew.get(adj.toLowerCase()) ?? adj;
      if (!vocabLower.has(resolved.toLowerCase())) {
        const rule =
          na && typeof na === "object" && typeof (na as { rule_description?: unknown }).rule_description === "string"
            ? (na as { rule_description: string }).rule_description.trim()
            : "";
        newAdjToInsert.push({ adjective: resolved, rule_description: rule || "(No description)" });
      }
    }
  }

  try {
    db.transaction(() => {
      writeHistoryLedger(db, ledgerEntries);
      for (const [node_id, entry] of impactByNode) {
        const node = getNode(db, node_id);
        if (!node) {
          console.warn(`[TaleShed] Mistral returned node_id not in world_graph: ${node_id}, skipping`);
          continue;
        }
        const currentAdj = safeParseAdjectives(node.adjectives);
        let newAdj = entry.adjectives_new;
        if (node.node_type === "location") {
          const hadDark = currentAdj.some((a) => a.toLowerCase() === "dark");
          const modelAddedDark = !hadDark && newAdj.some((a) => a.toLowerCase() === "dark");
          if (hadDark && !newAdj.some((a) => a.toLowerCase() === "dark")) {
            newAdj = [...newAdj, "dark"];
          } else if (modelAddedDark) {
            newAdj = newAdj.filter((a) => a.toLowerCase() !== "dark");
          }
        }
        const newJson = JSON.stringify(newAdj);
        const currentJson = JSON.stringify(currentAdj);
        if (newJson !== currentJson) {
          const modelReturnedEmpty = newAdj.length === 0;
          const nodeHadAdjectives = currentAdj.length > 0;
          const modelAcknowledgedCurrent =
            entry.adjectives_old.length > 0 &&
            JSON.stringify(entry.adjectives_old) === currentJson;
          /* Never overwrite inventory item adjectives with empty when the node has state (e.g. lit torch). */
          const isInventory = ctx.inventoryNodeIds.includes(node_id);
          if (modelReturnedEmpty && nodeHadAdjectives && (isInventory || !modelAcknowledgedCurrent)) {
            continue;
          }
          updateWorldGraphAdjectives(db, node_id, newJson);
        }
        if (entry.new_location_id != null) {
          const raw = String(entry.new_location_id).trim();
          const playerNode = getPlayer(db);
          const playerNodeId = playerNode?.node_id ?? "player";
          const isPlayerInventory =
            raw.toLowerCase() === "player_inventory" || raw === playerNodeId;
          const resolvedId = isPlayerInventory
            ? playerNodeId
            : getNode(db, raw)
              ? raw
              : resolveLocationNodeId(db, raw);
          if (!resolvedId) {
            console.warn(
              `[TaleShed] Ignoring new_location_id "${raw}" for ${node_id}: no such location in world_graph (model may have invented a location).`
            );
          } else if (node.node_type === "player") {
            const targetNode = getNode(db, resolvedId);
            if (targetNode?.node_type === "location") {
              const validTargets = new Set((ctx.locationExits ?? []).map((e) => e.target));
              if (!validTargets.has(resolvedId)) {
                console.warn(
                  `[TaleShed] Ignoring new_location_id "${raw}" for player: not an exit from current location (model may have invented a move).`
                );
              } else {
                const previousLocationId = node.location_id ?? null;
                updateWorldGraphLocation(db, node_id, resolvedId);
                if (previousLocationId) {
                  updateWorldGraphMeta(
                    db,
                    "player",
                    JSON.stringify({ came_from_location_id: previousLocationId })
                  );
                }
              }
            } else {
              console.warn(
                `[TaleShed] Ignoring new_location_id "${raw}" for player: player location must be a location node, not ${targetNode?.node_type ?? "unknown"}.`
              );
            }
          } else {
            updateWorldGraphLocation(db, node_id, resolvedId);
          }
        }
      }
      for (const d of newAdjToInsert) {
        insertVocabulary(db, d.adjective, d.rule_description, 0);
      }
    })();
  } catch (dbErr) {
    const message = dbErr instanceof Error ? dbErr.message : String(dbErr);
    return {
      result: "error",
      prose: "The world stutters. (Engine: A persistent error occurred. Please try again.)",
      error: message,
    };
  }

  const adjectivesInTurn = new Set<string>();
  for (const [, entry] of impactByNode) {
    for (const a of entry.adjectives_new) {
      const t = String(a).trim();
      if (t) adjectivesInTurn.add(t);
    }
  }
  const vocabularyAfter = getFullVocabulary(db);
  const vocabLowerAfter = new Set(vocabularyAfter.map((v) => v.adjective.toLowerCase()));
  const missing = [...adjectivesInTurn].filter((a) => !vocabLowerAfter.has(a.toLowerCase()));
  if (missing.length > 0) {
    const definitions = await fetchAdjectiveDefinitions(missing, vocabularyAfter);
    if (definitions.length > 0) {
      db.transaction(() => {
        for (const d of definitions) {
          if (d.adjective) {
            insertVocabulary(db, d.adjective, d.rule_description || "(No description)", 0);
            console.warn(`[TaleShed] Vocabulary: inserted "${d.adjective}"`);
          }
        }
      })();
    }
  }

  let prose = mistralResponse.narrative_prose ?? "";
  if (strippedObjectEntities.length > 0 && prose) {
    prose = sanitizeNarrativeStrippedTakes(prose, strippedObjectEntities);
  }
  /* When dark is active (no light), never show room description — force canonical darkness prose so the model cannot leak detail. */
  if (ctx.darkActive && !(isMovementCommand(playerCommand) && destTarget != null)) {
    prose = buildDarkProse(ctx.locationExits ?? []);
  } else if (isMovementCommand(playerCommand) && destTarget != null && destinationScene?.darkActive) {
    prose = buildDarkProse(destinationScene.exits);
  } else if (!(isMovementCommand(playerCommand) && destTarget != null)) {
    /* When the player stayed in the current location (look, take, etc.), ensure every exit is mentioned so they always see e.g. "down to cellar". */
    prose = ensureExitsInProse(prose, ctx.locationExits ?? []);
  }

  return {
    result: mistralResponse.action_result,
    prose,
    reconciliation_notes: mistralResponse.reconciliation_notes ?? null,
  };
}

export async function takeTurnWithRetry(
  db: Database.Database,
  playerCommand: string,
  recentHistory: string
): Promise<TakeTurnResult> {
  const first = await takeTurn(db, playerCommand, recentHistory);
  if (first.result !== "error" || !first.error?.includes("Missing required") || !first.error?.includes("JSON")) {
    return first;
  }
  return takeTurn(db, playerCommand, recentHistory);
}
