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
  getPlayerInventory,
  getRecentHistoryForNode,
  getFullVocabulary,
  writeHistoryLedger,
  updateWorldGraphAdjectives,
  updateWorldGraphLocation,
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
  type MistralResponse,
  type VocabularyItem,
} from "./ollama.js";

const OLLAMA_UNREACHABLE_PROSE =
  "The world pauses, as if holding its breath. (Engine: Ollama unreachable. Please check the local model service.)";

const MALFORMED_RESPONSE_PROSE =
  "The world flickers uncertainly. (Engine: The story engine could not interpret the outcome. Please try again.)";

/** Normalize direction to lowercase north/south/east/west or empty if not a cardinal. */
function normalizeDirection(d: unknown): string {
  const s = (d != null && typeof d === "string" ? d.trim() : "").toLowerCase();
  if (["north", "south", "east", "west"].includes(s)) return s;
  return "";
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
  const npcIdsInRoom = new Set(
    inLocationRaw.filter((n) => n.node_type === "npc").map((n) => n.node_id)
  );
  const inLocation = inLocationRaw.filter((n) => {
    if (n.location_id === "player_inventory") return false;
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
  const entities = rawEntities.sort(
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

  const locationExits = safeParseExits((location as WorldNode & { exits?: string }).exits);

  debugLog("scene entities", `location: ${location.node_id} | entity node_ids: ${entities.map((e) => e.node_id).join(", ")}`);

  return {
    location: toSceneEntity(
      location,
      getRecentHistoryForNode(db, location.node_id, 3).map((h) => sanitizeProseForPrompt(h.prose_impact)).filter(Boolean)
    ),
    entities,
    player: playerEntity,
    inventoryNodeIds,
    vocabulary,
    locationExits,
  };
}

function normalizeActionDescription(playerCommand: string): string {
  const t = playerCommand.trim();
  return t.length > 200 ? t.slice(0, 197) + "..." : t;
}

export interface TakeTurnResult {
  result: "success" | "failure" | "partial" | "error";
  prose: string;
  error?: string;
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

  const ctx = assembleSceneContext(db);
  if (!ctx) {
    return {
      result: "error",
      prose: "The world has no player or location. Check database setup.",
      error: "Missing player or location",
    };
  }

  const reachable = await checkOllamaReachable();
  if (!reachable) {
    return { result: "error", prose: OLLAMA_UNREACHABLE_PROSE, error: "Ollama unreachable" };
  }

  let mistralResponse: MistralResponse;
  try {
    mistralResponse = await runMistralTurn(ctx, playerCommand, recentHistory ?? "");
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

  const actionDescription = normalizeActionDescription(playerCommand);
  const now = new Date().toISOString();
  const impactByNode = new Map(
    mistralResponse.node_impacts.map((i) => [
      i.node_id,
      {
        prose_impact: i.prose_impact ?? "No change.",
        adjectives_old: safeParseAdjectives(i.adjectives_old),
        adjectives_new: safeParseAdjectives(i.adjectives_new),
        new_location_id:
          i.new_location_id != null && String(i.new_location_id).trim() !== ""
            ? String(i.new_location_id).trim()
            : undefined,
      },
    ])
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
        const newJson = JSON.stringify(entry.adjectives_new);
        const currentJson = JSON.stringify(currentAdj);
        if (newJson !== currentJson) {
          const modelReturnedEmpty = entry.adjectives_new.length === 0;
          const nodeHadAdjectives = currentAdj.length > 0;
          const modelAcknowledgedCurrent =
            entry.adjectives_old.length > 0 &&
            JSON.stringify(entry.adjectives_old) === currentJson;
          if (modelReturnedEmpty && nodeHadAdjectives && !modelAcknowledgedCurrent) {
            continue;
          }
          updateWorldGraphAdjectives(db, node_id, newJson);
        }
        if (entry.new_location_id != null) {
          const raw = String(entry.new_location_id).trim();
          const isPlayerInventory = raw.toLowerCase() === "player_inventory";
          const resolvedId = isPlayerInventory
            ? "player_inventory"
            : getNode(db, raw)
              ? raw
              : resolveLocationNodeId(db, raw);
          if (!resolvedId) {
            console.warn(
              `[TaleShed] Ignoring new_location_id "${raw}" for ${node_id}: no such location in world_graph (model may have invented a location).`
            );
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

  return {
    result: mistralResponse.action_result,
    prose: mistralResponse.narrative_prose ?? "",
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
