/**
 * MCP tool handlers: take_turn, bookmark, restore_to_bookmark, update_node_adjectives.
 */

import type Database from "better-sqlite3";
import { takeTurnWithRetry } from "./turn.js";
import { createBookmark, listBookmarks, restoreToBookmark } from "./bookmark.js";
import {
  getNode,
  updateWorldGraphAdjectives,
  updateWorldGraphLocation,
  updateWorldGraphMeta,
  getFullVocabulary,
  insertVocabulary,
  writeHistoryLedger,
  getPlayer,
  getEntitiesInLocationIncludingContents,
  getRootLocationId,
  getPlayerInventory,
  nodeIdExists,
  createWorldGraphNode,
} from "./db/database.js";
import type { WorldNode } from "./db/schema.js";
import {
  fetchAdjectiveDefinitions,
  resolveRedundantAdjectives,
  isEngineCoveredByDefinition,
  filterEngineCoveredAdjectives,
  isTransientOrNarrativeOnlyByDefinition,
  isTransientOrNarrativeOnlyByTerm,
  isLocationOrContainmentOnlyByTerm,
  filterTransientAdjectives,
  debugLog,
  callOllama,
} from "./ollama.js";
import { getTaleshedVersionInfo, type TaleshedVersionInfo } from "./version.js";

export interface TakeTurnArgs {
  player_command: string;
  recent_history?: string;
}

export interface TakeTurnOutput {
  result: "success" | "failure" | "partial" | "error";
  prose: string;
  error?: string;
  reconciliation_notes?: string | null;
  /** Node IDs in the scene this turn (location, entities present, inventory, player). Use these exact IDs for update_node_adjectives. */
  scene_node_ids?: string[];
}

export interface UpdateNodeAdjectivesArgs {
  node_id: string;
  adjectives: string[];
}

export interface UpdateNodeAdjectivesOutput {
  success: boolean;
  error?: string;
}

function parseAdjectives(val: string | undefined | null): string[] {
  try {
    if (typeof val === "string" && val.trim()) {
      const parsed = JSON.parse(val);
      return Array.isArray(parsed) ? parsed.map((x) => String(x)) : [];
    }
    return [];
  } catch {
    return [];
  }
}

export async function handleUpdateNodeAdjectives(
  db: Database.Database,
  args: UpdateNodeAdjectivesArgs
): Promise<UpdateNodeAdjectivesOutput> {
  debugLog("update_node_adjectives request", JSON.stringify(args, null, 2));
  const nodeIdRaw = (args.node_id ?? "").trim();
  if (!nodeIdRaw) {
    const out: UpdateNodeAdjectivesOutput = { success: false, error: "node_id is required" };
    debugLog("update_node_adjectives response", JSON.stringify(out));
    return out;
  }
  let node = getNode(db, nodeIdRaw);
  let nodeId = nodeIdRaw;
  if (!node) {
    for (const suffix of ["_01", "_1"]) {
      const candidate = nodeIdRaw + suffix;
      const n = getNode(db, candidate);
      if (n) {
        node = n;
        nodeId = candidate;
        break;
      }
    }
  }
  if (!node) {
    const out: UpdateNodeAdjectivesOutput = {
      success: false,
      error: `No active node with node_id "${nodeIdRaw}". Use the exact node_id from the scene (e.g. torch_01, not "torch").`,
    };
    debugLog("update_node_adjectives response", JSON.stringify(out));
    return out;
  }
  const rawAdjectives = Array.isArray(args.adjectives) ? args.adjectives : [];
  let adjectives = [...new Set(rawAdjectives.map((a) => String(a).trim()).filter(Boolean))];
  const vocabulary = getFullVocabulary(db);
  /* Strip adjectives that are engine-covered (containment/placement/possession) or transient/narrative-only. */
  adjectives = await filterEngineCoveredAdjectives(adjectives, vocabulary);
  adjectives = await filterTransientAdjectives(adjectives, vocabulary);
  /* States are represented by vocabulary terms only. Negations (e.g. unlit, unlocked, "not X") mean "omit the positive term"—strip the negation term and the corresponding positive term from the list. */
  const vocabLower = new Set(vocabulary.map((v) => v.adjective.trim().toLowerCase()).filter(Boolean));
  const toRemove = new Set<string>();
  for (const a of adjectives) {
    const lower = a.toLowerCase();
    for (const v of vocabLower) {
      if (lower === "un" + v || lower === "not " + v) {
        toRemove.add(a);
        toRemove.add(vocabulary.find((x) => x.adjective.toLowerCase() === v)?.adjective ?? v);
        break;
      }
    }
  }
  if (toRemove.size > 0) {
    const removeLower = new Set([...toRemove].map((x) => x.toLowerCase()));
    adjectives = adjectives.filter((x) => !removeLower.has(x.toLowerCase()));
  }
  const candidatesNotInVocab = adjectives.filter((a) => !vocabLower.has(a.toLowerCase()));
  if (candidatesNotInVocab.length > 0) {
    const resolveMap = await resolveRedundantAdjectives(candidatesNotInVocab, vocabulary);
    adjectives = [...new Set(adjectives.map((a) => resolveMap.get(a.toLowerCase()) ?? a))];
  }
  /* For adjectives not in vocab, reject location-only and non-substantive terms, then fetch definitions and strip any that are engine-covered. */
  const missing = adjectives.filter((a) => !vocabLower.has(a.toLowerCase()));
  if (missing.length > 0) {
    const rejectBeforeDef = new Set<string>();
    for (const term of missing) {
      if (await isTransientOrNarrativeOnlyByTerm(term)) rejectBeforeDef.add(term.toLowerCase());
      else if (await isLocationOrContainmentOnlyByTerm(term)) rejectBeforeDef.add(term.toLowerCase());
    }
    if (rejectBeforeDef.size > 0) {
      adjectives = adjectives.filter((a) => !rejectBeforeDef.has(a.toLowerCase()));
    }
  }
  const stillMissing = adjectives.filter((a) => !vocabLower.has(a.toLowerCase()));
  let vocabToInsert: { adjective: string; rule_description: string }[] = [];
  if (stillMissing.length > 0) {
    const { definitions: definitionsForMissing, requestedToCanonical } = await fetchAdjectiveDefinitions(stillMissing, vocabulary, "update_node_adjectives");
    const rejectedNew = new Set<string>();
    for (const d of definitionsForMissing) {
      if (!d.adjective) continue;
      const key = d.adjective.trim().toLowerCase();
      const covered = await isEngineCoveredByDefinition(d.adjective, d.rule_description || "(No description)");
      if (covered) rejectedNew.add(key);
      const transient = await isTransientOrNarrativeOnlyByDefinition(d.adjective, d.rule_description || "(No description)");
      if (transient) rejectedNew.add(key);
      if (!covered && !transient) vocabToInsert.push({ adjective: d.adjective, rule_description: d.rule_description || "(No description)" });
    }
    if (rejectedNew.size > 0) {
      adjectives = adjectives.filter((a) => !rejectedNew.has((requestedToCanonical.get(a.toLowerCase()) ?? a).toLowerCase()));
    }
    /* Normalize to canonical adjectives (e.g. "copying a manuscript" -> "copied") when model suggested a better term. */
    if (requestedToCanonical.size > 0) {
      adjectives = [...new Set(adjectives.map((a) => requestedToCanonical.get(a.toLowerCase()) ?? a))];
    }
  }
  const currentAdj = parseAdjectives(node.adjectives);
  const newJson = JSON.stringify(adjectives);
  const currentJson = JSON.stringify(currentAdj);
  if (newJson === currentJson) {
    const out: UpdateNodeAdjectivesOutput = { success: true };
    debugLog("update_node_adjectives response", JSON.stringify(out));
    return out;
  }
  db.transaction(() => {
    updateWorldGraphAdjectives(db, nodeId, newJson);
    writeHistoryLedger(db, [
      {
        timestamp: new Date().toISOString(),
        action_description: "narrator_adjective_sync",
        node_id: nodeId,
        prose_impact: null,
        adjectives_old: currentJson,
        adjectives_new: newJson,
        system_event: null,
      },
    ]);
  })();
  if (vocabToInsert.length > 0) {
    db.transaction(() => {
      for (const d of vocabToInsert) {
        insertVocabulary(db, d.adjective, d.rule_description, 0);
      }
    })();
  }
  const out: UpdateNodeAdjectivesOutput = { success: true };
  debugLog("update_node_adjectives response", JSON.stringify(out));
  return out;
}

export function handleTakeTurn(db: Database.Database, args: TakeTurnArgs): Promise<TakeTurnOutput> {
  return takeTurnWithRetry(db, args.player_command, args.recent_history ?? "");
}

export function handleVersion(): TaleshedVersionInfo {
  return getTaleshedVersionInfo();
}

export interface BookmarkArgs {
  description?: string | null;
}

export function handleBookmark(
  db: Database.Database,
  args?: BookmarkArgs
): { prose: string; entry_id: number; number: number; description: string } {
  return createBookmark(db, args?.description);
}

export function handleListBookmarks(db: Database.Database): { bookmarks: { number: number; entry_id: number; description: string }[]; prose: string } {
  return listBookmarks(db);
}

export function handleRestoreToBookmark(
  db: Database.Database,
  bookmarkNumber: number | undefined,
  confirm: boolean
): { prose: string; success: boolean; needs_confirm?: boolean } {
  return restoreToBookmark(db, bookmarkNumber, confirm);
}

// ---------------------------------------------------------------------------
// get_scene
// ---------------------------------------------------------------------------

export interface GetSceneExit {
  label: string;
  target: string;
  direction?: string;
  /**
   * node_id of the entity in this room that physically represents this exit (e.g. a door, gate,
   * or hatch), when one could be matched by name. Check this entity's adjectives to determine
   * whether the exit is passable — e.g. "locked" means the player cannot pass without a key.
   * To change the exit's physical state, call set_node_adjectives with this node_id.
   */
  object_node_id?: string;
  /** Current adjectives of the linked entity — a convenience copy so you need not scan entities[]. */
  object_adjectives?: string[];
}

export interface GetSceneLocation {
  node_id: string;
  name: string;
  description: string;
  adjectives: string[];
  exits: GetSceneExit[];
}

export interface GetSceneEntity {
  node_id: string;
  node_type: string;
  name: string;
  description: string;
  adjectives: string[];
  /** location_id from the DB — equals the room node_id for direct entities, or a container's node_id when contained. */
  location_id: string | null;
  /** node_id of the containing entity when this item is inside another object; null otherwise. */
  contained_by: string | null;
}

export interface GetSceneInventoryItem {
  node_id: string;
  name: string;
  description: string;
  adjectives: string[];
}

export interface GetSceneOutput {
  location: GetSceneLocation;
  entities: GetSceneEntity[];
  player: { node_id: string; adjectives: string[]; location_id: string };
  inventory: GetSceneInventoryItem[];
  vocabulary: { adjective: string; rule_description: string }[];
  /** Last few player commands from the history ledger, oldest first. */
  recent_history: string[];
  /**
   * True when the location has the authored "dark" adjective AND no lit object is present in the
   * room or player inventory. "dark" is set at authoring time and means this location has no
   * ambient light — it cannot be described unless a light source is present. It is never added or
   * removed by game events; only the authoring tool may change it. When darkness_active is true,
   * narrate only impenetrable darkness and the exit the player came from.
   */
  darkness_active: boolean;
  error?: string;
}

function parseExitsForScene(val: string | null | undefined): Omit<GetSceneExit, "object_node_id" | "object_adjectives">[] {
  try {
    if (!val || !val.trim()) return [];
    const parsed = JSON.parse(val);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((e): e is Record<string, unknown> => e != null && typeof e === "object")
      .map((e) => ({
        label: typeof e.label === "string" ? e.label.trim() : "",
        target: typeof e.target === "string" ? e.target.trim() : "",
        ...(typeof e.direction === "string" && e.direction.trim() ? { direction: e.direction.trim() } : {}),
      }))
      .filter((e) => e.target.length > 0);
  } catch {
    return [];
  }
}

/**
 * Try to match an exit label to a room object that physically represents it (a door, gate, etc.).
 * Uses a scored approach: exact name match > label contains name > name contains label >
 * node_id stem in label > shared significant words. Returns null when no confident match found.
 */
function findExitObject(
  exitLabel: string,
  objects: GetSceneEntity[]
): { node_id: string; adjectives: string[] } | null {
  const labelLower = exitLabel.trim().toLowerCase();
  if (!labelLower || objects.length === 0) return null;

  let best: { node_id: string; adjectives: string[]; score: number } | null = null;

  for (const obj of objects) {
    const nameLower = obj.name.trim().toLowerCase();
    const stem = obj.node_id.replace(/_?\d+$/, "").toLowerCase();
    let score = 0;

    if (nameLower === labelLower) {
      score = 100;
    } else if (nameLower.length >= 3 && labelLower.includes(nameLower)) {
      score = 80;
    } else if (labelLower.length >= 3 && nameLower.includes(labelLower)) {
      score = 70;
    } else if (stem.length >= 3 && labelLower.includes(stem)) {
      score = 50;
    } else {
      // Word-level: significant words (4+ chars) shared between label and name.
      const labelWords = labelLower.split(/\s+/).filter((w) => w.length >= 4);
      const nameWords = nameLower.split(/\s+/).filter((w) => w.length >= 4);
      const shared = labelWords.filter((w) => nameWords.includes(w)).length;
      if (shared > 0) score = 20 + shared * 10;
    }

    if (score >= 50 && (!best || score > best.score)) {
      best = { node_id: obj.node_id, adjectives: obj.adjectives, score };
    }
  }

  return best ? { node_id: best.node_id, adjectives: best.adjectives } : null;
}

/** Attach object_node_id and object_adjectives to each exit where a matching room object is found. */
function enrichExitsWithObjects(
  exits: Omit<GetSceneExit, "object_node_id" | "object_adjectives">[],
  entities: GetSceneEntity[]
): GetSceneExit[] {
  const objects = entities.filter((e) => e.node_type === "object");
  return exits.map((exit) => {
    const match = findExitObject(exit.label, objects);
    return match
      ? { ...exit, object_node_id: match.node_id, object_adjectives: match.adjectives }
      : { ...exit };
  });
}

function hasLitObject(nodes: WorldNode[]): boolean {
  return nodes.some((n) => {
    if (n.node_type !== "object") return false;
    const adj = parseAdjectives(n.adjectives);
    return adj.some((a) => a.toLowerCase() === "lit");
  });
}

export function handleGetScene(db: Database.Database): GetSceneOutput {
  const empty = (error: string): GetSceneOutput => ({
    error,
    location: { node_id: "", name: "", description: "", adjectives: [], exits: [] },
    entities: [],
    player: { node_id: "player", adjectives: [], location_id: "" },
    inventory: [],
    vocabulary: [],
    recent_history: [],
    darkness_active: false,
  });

  const player = getPlayer(db);
  if (!player) return empty("No player found. Check database setup (run npm run seed).");

  const locationId = player.location_id;
  if (!locationId) return empty("Player has no location_id. Check database setup.");

  const locationNode = getNode(db, locationId);
  if (!locationNode) return empty(`Location node "${locationId}" not found in world_graph.`);

  // Entities in this room, including contents of open containers.
  // Filter to only entities whose containment chain ends at this room.
  const inLocationRaw = getEntitiesInLocationIncludingContents(db, locationId);
  const inLocationSameRoot = inLocationRaw.filter((n) => getRootLocationId(db, n.node_id) === locationId);

  // Exclude items directly carried by the player — those appear in inventory[] separately.
  // NPC-carried visible items are intentionally included (hidden adjective suppresses them at the db layer).
  const inLocation = inLocationSameRoot.filter((n) => n.location_id !== player.node_id);

  const inventory = getPlayerInventory(db);

  // darkness_active: the authored "dark" adjective is present AND no lit object is here or in inventory.
  // "dark" itself is authoring-only — game events must never add or remove it from a location.
  const locationAdjectives = parseAdjectives(locationNode.adjectives);
  const darkness_active =
    locationAdjectives.some((a) => a.toLowerCase() === "dark") &&
    !hasLitObject(inLocation) &&
    !hasLitObject(inventory);

  // Build entity list — sorted: NPCs first, then objects.
  const entityOrder: Record<string, number> = { npc: 0, object: 1 };
  const entities: GetSceneEntity[] = inLocation
    .slice()
    .sort(
      (a, b) =>
        (entityOrder[a.node_type] ?? 2) - (entityOrder[b.node_type] ?? 2) ||
        a.node_id.localeCompare(b.node_id)
    )
    .map((node) => ({
      node_id: node.node_id,
      node_type: node.node_type,
      name: node.name,
      description: node.base_description,
      adjectives: parseAdjectives(node.adjectives),
      location_id: node.location_id ?? null,
      contained_by: node.location_id && node.location_id !== locationId ? node.location_id : null,
    }));

  const inventoryItems: GetSceneInventoryItem[] = inventory.map((node) => ({
    node_id: node.node_id,
    name: node.name,
    description: node.base_description,
    adjectives: parseAdjectives(node.adjectives),
  }));

  const location: GetSceneLocation = {
    node_id: locationNode.node_id,
    name: locationNode.name,
    description: locationNode.base_description,
    adjectives: locationAdjectives,
    exits: enrichExitsWithObjects(
      parseExitsForScene((locationNode as WorldNode & { exits?: string }).exits),
      entities
    ),
  };

  const vocabulary = getFullVocabulary(db).map((v) => ({
    adjective: v.adjective,
    rule_description: v.rule_description,
  }));

  // Recent player commands from the ledger — last 6, oldest first.
  const recentRows = db
    .prepare(
      `SELECT action_description FROM history_ledger
       WHERE action_description IS NOT NULL AND system_event IS NULL
       ORDER BY entry_id DESC LIMIT 6`
    )
    .all() as { action_description: string }[];
  const recent_history = recentRows.map((r) => r.action_description).reverse();

  return {
    location,
    entities,
    player: {
      node_id: "player",
      adjectives: parseAdjectives(player.adjectives),
      location_id: locationId,
    },
    inventory: inventoryItems,
    vocabulary,
    recent_history,
    darkness_active,
  };
}

// ---------------------------------------------------------------------------
// set_node_adjectives
// ---------------------------------------------------------------------------

export interface SetNodeAdjectivesArgs {
  node_id: string;
  adjectives: string[];
}

export interface SetNodeAdjectivesOutput {
  success: boolean;
  node_id?: string;
  adjectives?: string[];
  error?: string;
}

export function handleSetNodeAdjectives(
  db: Database.Database,
  args: SetNodeAdjectivesArgs
): SetNodeAdjectivesOutput {
  const nodeId = (args.node_id ?? "").trim();
  if (!nodeId) return { success: false, error: "node_id is required" };

  const node = getNode(db, nodeId);
  if (!node) return { success: false, error: `Node "${nodeId}" not found or inactive` };

  // Deduplicate and clean.
  let newAdjectives = [
    ...new Set(
      (Array.isArray(args.adjectives) ? args.adjectives : [])
        .map((a) => String(a).trim())
        .filter(Boolean)
    ),
  ];

  const currentAdjectives = parseAdjectives(node.adjectives);

  // "dark" on location nodes is authoring-only. The server preserves the current
  // dark state regardless of what Claude passes — it cannot be added or removed
  // via this tool. Only the authoring web app may change it.
  if (node.node_type === "location") {
    const hadDark = currentAdjectives.some((a) => a.toLowerCase() === "dark");
    newAdjectives = newAdjectives.filter((a) => a.toLowerCase() !== "dark");
    if (hadDark) newAdjectives = [...newAdjectives, "dark"];
  }

  const oldJson = JSON.stringify(currentAdjectives);
  const newJson = JSON.stringify(newAdjectives);

  // No-op if nothing changed.
  if (oldJson === newJson) {
    return { success: true, node_id: nodeId, adjectives: newAdjectives };
  }

  db.transaction(() => {
    updateWorldGraphAdjectives(db, nodeId, newJson);
    writeHistoryLedger(db, [
      {
        timestamp: new Date().toISOString(),
        action_description: "set_node_adjectives",
        node_id: nodeId,
        prose_impact: null,
        adjectives_old: oldJson,
        adjectives_new: newJson,
        system_event: null,
      },
    ]);
  })();

  return { success: true, node_id: nodeId, adjectives: newAdjectives };
}

// ---------------------------------------------------------------------------
// move_entity
// ---------------------------------------------------------------------------

export interface MoveEntityArgs {
  entity_id: string;
  destination_id: string;
}

export interface MoveEntityOutput {
  success: boolean;
  entity_id?: string;
  previous_location_id?: string | null;
  destination_id?: string;
  error?: string;
}

export function handleMoveEntity(
  db: Database.Database,
  args: MoveEntityArgs
): MoveEntityOutput {
  const entityId = (args.entity_id ?? "").trim();
  const destinationId = (args.destination_id ?? "").trim();

  if (!entityId) return { success: false, error: "entity_id is required" };
  if (!destinationId) return { success: false, error: "destination_id is required" };
  if (entityId === destinationId) return { success: false, error: "entity_id and destination_id must differ" };

  const entity = getNode(db, entityId);
  if (!entity) return { success: false, error: `Entity "${entityId}" not found or inactive` };
  if (entity.node_type === "location") return { success: false, error: `"${entityId}" is a location — locations cannot be moved` };

  const destination = getNode(db, destinationId);
  if (!destination) return { success: false, error: `Destination "${destinationId}" not found or inactive` };

  // The player may only move to another location.
  if (entity.node_type === "player" && destination.node_type !== "location") {
    return { success: false, error: `Player can only be moved to a location node; "${destinationId}" is a ${destination.node_type}` };
  }

  const previousLocationId = entity.location_id ?? null;

  db.transaction(() => {
    updateWorldGraphLocation(db, entityId, destinationId);

    // When moving the player, record where they came from so dark-room entrance
    // tracking knows which exit is the way back.
    if (entity.node_type === "player") {
      let meta: Record<string, unknown> = {};
      try { if (entity.meta) meta = JSON.parse(entity.meta) as Record<string, unknown>; } catch { /* ignore */ }
      meta.came_from_location_id = previousLocationId;
      updateWorldGraphMeta(db, entityId, JSON.stringify(meta));
    }

    writeHistoryLedger(db, [
      {
        timestamp: new Date().toISOString(),
        action_description: "move_entity",
        node_id: entityId,
        prose_impact: `Moved from ${previousLocationId ?? "(none)"} to ${destinationId}`,
        adjectives_old: entity.adjectives,
        adjectives_new: entity.adjectives,
        system_event: null,
      },
    ]);
  })();

  return { success: true, entity_id: entityId, previous_location_id: previousLocationId, destination_id: destinationId };
}

// ---------------------------------------------------------------------------
// seal_passage
// ---------------------------------------------------------------------------

export interface SealPassageArgs {
  location_id: string;
  exit_target: string;
}

export interface SealPassageOutput {
  success: boolean;
  location_id?: string;
  sealed_exit?: { label: string; target: string; direction?: string };
  error?: string;
}

export function handleSealPassage(
  db: Database.Database,
  args: SealPassageArgs
): SealPassageOutput {
  const locationId = (args.location_id ?? "").trim();
  const exitTarget = (args.exit_target ?? "").trim();

  if (!locationId) return { success: false, error: "location_id is required" };
  if (!exitTarget) return { success: false, error: "exit_target is required" };

  const locationNode = getNode(db, locationId);
  if (!locationNode) return { success: false, error: `Location "${locationId}" not found or inactive` };
  if (locationNode.node_type !== "location") return { success: false, error: `"${locationId}" is not a location node` };

  const currentExits = parseExitsForScene((locationNode as WorldNode & { exits?: string }).exits);
  const idx = currentExits.findIndex((e) => e.target.toLowerCase() === exitTarget.toLowerCase());

  if (idx === -1) {
    return { success: false, error: `No exit with target "${exitTarget}" found in "${locationId}"` };
  }

  const sealed = currentExits[idx]!;
  const remaining = [...currentExits.slice(0, idx), ...currentExits.slice(idx + 1)];

  db.transaction(() => {
    db.prepare("UPDATE world_graph SET exits = ? WHERE node_id = ?").run(
      JSON.stringify(remaining),
      locationId
    );
    writeHistoryLedger(db, [
      {
        timestamp: new Date().toISOString(),
        action_description: "seal_passage",
        node_id: locationId,
        prose_impact: `Exit "${sealed.label}" to "${exitTarget}" permanently sealed`,
        adjectives_old: null,
        adjectives_new: null,
        system_event: null,
      },
    ]);
  })();

  return { success: true, location_id: locationId, sealed_exit: { ...sealed } };
}

// ---------------------------------------------------------------------------
// evaluate_consequences
// ---------------------------------------------------------------------------

interface ConsequenceChange {
  node_id: string;
  adjectives: string[];
}

interface NewVocabularyTerm {
  adjective: string;
  rule_description: string;
}

interface MistralConsequenceResponse {
  cascade_changes: ConsequenceChange[];
  new_vocabulary: NewVocabularyTerm[];
}

export interface EvaluateConsequencesArgs {
  action_description: string;
  affected_node_ids?: string[];
  proposed_adjectives?: string[];
}

export interface EvaluateConsequencesOutput {
  cascade_changes_applied: { node_id: string; adjectives: string[] }[];
  vocabulary_added: { adjective: string; rule_description: string }[];
  error?: string;
}

function buildConsequencePrompt(
  actionDescription: string,
  affectedNodeIds: string[],
  proposedAdjectives: string[],
  scene: GetSceneOutput
): string {
  const entityLines = [
    `${scene.location.node_id} (location) | ${scene.location.name} | adjectives: ${JSON.stringify(scene.location.adjectives)}`,
    ...scene.entities.map(
      (e) => `${e.node_id} (${e.node_type}) | ${e.name} | adjectives: ${JSON.stringify(e.adjectives)}`
    ),
    `player | adjectives: ${JSON.stringify(scene.player.adjectives)}`,
    ...scene.inventory.map(
      (e) => `${e.node_id} (inventory) | ${e.name} | adjectives: ${JSON.stringify(e.adjectives)}`
    ),
  ].join("\n");

  const vocabLines = scene.vocabulary
    .map((v) => `- ${v.adjective}: ${v.rule_description}`)
    .join("\n");

  const affectedBlock =
    affectedNodeIds.length > 0
      ? `\nDIRECTLY CHANGED THIS TURN: ${affectedNodeIds.join(", ")}\n`
      : "";

  const proposedBlock =
    proposedAdjectives.length > 0
      ? `\nPROPOSED NEW ADJECTIVES (Claude wants these defined):\n${proposedAdjectives.join(", ")}\n`
      : "";

  return `You are a consequence evaluator for a text adventure game. The game master has already narrated and committed an action. Your only job is to identify any cascade effects on other entities in the scene, and define any new vocabulary terms.

ACTION: ${actionDescription}
${affectedBlock}
CURRENT SCENE (node_id | type | adjectives):
${entityLines}

VOCABULARY:
${vocabLines}
${proposedBlock}
TASK:
1. Do any scene entities need adjective changes as a DIRECT consequence of this action? Only update entities whose state authentically and persistently changed as a result — do not add trivial, momentary, or assumed reactions.
2. Are any new adjective terms needed that are not already in VOCABULARY? Define each with one generic sentence that applies to any node type. Never propose "dark" — it is reserved.

Use only node_ids from the scene list. Use only vocabulary terms for adjectives, or propose new ones in new_vocabulary.
If nothing cascades and no new vocabulary is needed, return empty arrays.

Return ONLY valid JSON:
{
  "cascade_changes": [{ "node_id": "<exact node_id>", "adjectives": ["<full new list>"] }],
  "new_vocabulary": [{ "adjective": "<term>", "rule_description": "<one sentence>" }]
}`;
}

function parseConsequenceResponse(responseText: string): MistralConsequenceResponse | null {
  try {
    const trimmed = responseText.trim();
    const codeMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    const inner = codeMatch ? codeMatch[1]!.trim() : trimmed;
    const start = inner.indexOf("{");
    const end = inner.lastIndexOf("}") + 1;
    if (start < 0 || end <= start) return null;
    const parsed = JSON.parse(inner.slice(start, end)) as Record<string, unknown>;

    const cascade_changes: ConsequenceChange[] = Array.isArray(parsed.cascade_changes)
      ? parsed.cascade_changes
          .filter((c): c is Record<string, unknown> => c != null && typeof c === "object")
          .map((c) => ({
            node_id: typeof c.node_id === "string" ? c.node_id.trim() : "",
            adjectives: Array.isArray(c.adjectives)
              ? c.adjectives.map((a) => String(a).trim()).filter(Boolean)
              : [],
          }))
          .filter((c) => c.node_id.length > 0)
      : [];

    const new_vocabulary: NewVocabularyTerm[] = Array.isArray(parsed.new_vocabulary)
      ? parsed.new_vocabulary
          .filter((v): v is Record<string, unknown> => v != null && typeof v === "object")
          .map((v) => ({
            adjective: typeof v.adjective === "string" ? v.adjective.trim() : "",
            rule_description:
              typeof v.rule_description === "string" ? v.rule_description.trim() : "",
          }))
          .filter((v) => v.adjective.length > 0 && v.rule_description.length > 0)
      : [];

    return { cascade_changes, new_vocabulary };
  } catch {
    return null;
  }
}

export async function handleEvaluateConsequences(
  db: Database.Database,
  args: EvaluateConsequencesArgs
): Promise<EvaluateConsequencesOutput> {
  const actionDescription = (args.action_description ?? "").trim();
  if (!actionDescription) {
    return { cascade_changes_applied: [], vocabulary_added: [], error: "action_description is required" };
  }

  const scene = handleGetScene(db);
  if (scene.error) {
    return { cascade_changes_applied: [], vocabulary_added: [], error: scene.error };
  }

  const affectedNodeIds = Array.isArray(args.affected_node_ids)
    ? args.affected_node_ids.map((s) => String(s).trim()).filter(Boolean)
    : [];
  const proposedAdjectives = Array.isArray(args.proposed_adjectives)
    ? args.proposed_adjectives.map((s) => String(s).trim()).filter(Boolean)
    : [];

  const prompt = buildConsequencePrompt(actionDescription, affectedNodeIds, proposedAdjectives, scene);

  let responseText: string;
  try {
    responseText = await callOllama(prompt, "evaluate_consequences");
  } catch (err) {
    // Ollama unavailable or timed out — primary action is already committed, so
    // return gracefully with empty results rather than failing the turn.
    debugLog("evaluate_consequences", `Ollama error: ${err instanceof Error ? err.message : String(err)}`);
    return { cascade_changes_applied: [], vocabulary_added: [] };
  }

  const parsed = parseConsequenceResponse(responseText);
  if (!parsed) {
    debugLog("evaluate_consequences", `Could not parse response: ${responseText}`);
    return { cascade_changes_applied: [], vocabulary_added: [] };
  }

  // Valid scene node ids — only apply cascades to nodes actually in this scene.
  const validNodeIds = new Set<string>([
    scene.location.node_id,
    ...scene.entities.map((e) => e.node_id),
    ...scene.inventory.map((e) => e.node_id),
    "player",
  ]);

  // Apply cascade adjective changes using set_node_adjectives (includes dark protection,
  // deduplication, and auto-ledgering).
  const cascadeApplied: { node_id: string; adjectives: string[] }[] = [];
  for (const change of parsed.cascade_changes) {
    if (!validNodeIds.has(change.node_id)) {
      debugLog("evaluate_consequences", `Ignoring cascade for out-of-scene node: ${change.node_id}`);
      continue;
    }
    const result = handleSetNodeAdjectives(db, {
      node_id: change.node_id,
      adjectives: change.adjectives,
    });
    if (result.success && result.adjectives) {
      cascadeApplied.push({ node_id: change.node_id, adjectives: result.adjectives });
    }
  }

  // Insert new vocabulary terms — skip "dark", skip existing terms, skip empty rules.
  const existingVocab = new Set(getFullVocabulary(db).map((v) => v.adjective.toLowerCase()));
  const vocabularyAdded: { adjective: string; rule_description: string }[] = [];
  for (const term of parsed.new_vocabulary) {
    const key = term.adjective.toLowerCase();
    if (key === "dark" || existingVocab.has(key)) continue;
    insertVocabulary(db, term.adjective, term.rule_description, 0);
    vocabularyAdded.push({ adjective: term.adjective, rule_description: term.rule_description });
    existingVocab.add(key);
  }

  debugLog(
    "evaluate_consequences",
    `cascade_changes_applied: ${cascadeApplied.length}, vocabulary_added: ${vocabularyAdded.length}`
  );

  return { cascade_changes_applied: cascadeApplied, vocabulary_added: vocabularyAdded };
}

// ---------------------------------------------------------------------------
// create_node
// ---------------------------------------------------------------------------

export interface CreateNodeArgs {
  node_type: "object" | "npc";
  name: string;
  base_description: string;
  adjectives?: string[];
  location_id?: string;
  node_id?: string;
}

export interface CreateNodeOutput {
  success: boolean;
  node_id?: string;
  node_type?: string;
  name?: string;
  location_id?: string | null;
  adjectives?: string[];
  error?: string;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s_]/g, "")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 40)
    .replace(/^_+|_+$/g, "");
}

function generateUniqueNodeId(db: Database.Database, base: string): string {
  const safeBase = base || "node";
  if (!nodeIdExists(db, safeBase)) return safeBase;
  for (let i = 1; i <= 99; i++) {
    const candidate = `${safeBase}_${String(i).padStart(2, "0")}`;
    if (!nodeIdExists(db, candidate)) return candidate;
  }
  return `${safeBase}_${Date.now()}`;
}

export function handleCreateNode(
  db: Database.Database,
  args: CreateNodeArgs
): CreateNodeOutput {
  const nodeType = args.node_type;
  if (nodeType !== "object" && nodeType !== "npc") {
    return { success: false, error: `node_type must be "object" or "npc"; got "${String(nodeType)}"` };
  }

  const name = (args.name ?? "").trim();
  if (!name) return { success: false, error: "name is required" };

  const baseDescription = (args.base_description ?? "").trim();
  if (!baseDescription) return { success: false, error: "base_description is required" };

  // Resolve placement location
  let locationId: string | null = null;
  if (args.location_id) {
    const targetId = args.location_id.trim();
    const loc = getNode(db, targetId);
    if (!loc) return { success: false, error: `location_id "${targetId}" not found in world_graph` };
    locationId = loc.node_id;
  } else {
    const player = getPlayer(db);
    locationId = player?.location_id ?? null;
  }

  // Generate unique node_id
  const preferredBase = args.node_id
    ? args.node_id.trim().toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "")
    : slugify(name);
  const nodeId = generateUniqueNodeId(db, preferredBase || "node");

  // Clean adjectives — "dark" is never valid on created nodes
  const rawAdjectives = Array.isArray(args.adjectives)
    ? [...new Set(args.adjectives.map((a) => String(a).trim()).filter(Boolean))]
    : [];
  const adjectives = rawAdjectives.filter((a) => a.toLowerCase() !== "dark");
  const adjectivesJson = JSON.stringify(adjectives);

  db.transaction(() => {
    createWorldGraphNode(db, nodeId, nodeType, name, baseDescription, adjectivesJson, locationId);
    writeHistoryLedger(db, [
      {
        timestamp: new Date().toISOString(),
        action_description: "create_node",
        node_id: nodeId,
        prose_impact: `Created ${nodeType} "${name}" (${nodeId}) at location ${locationId ?? "(none)"}`,
        adjectives_old: null,
        adjectives_new: adjectivesJson,
        system_event: null,
      },
    ]);
  })();

  debugLog("create_node", `Created ${nodeType} "${name}" as ${nodeId} at ${locationId ?? "(none)"}`);

  return {
    success: true,
    node_id: nodeId,
    node_type: nodeType,
    name,
    location_id: locationId,
    adjectives,
  };
}
