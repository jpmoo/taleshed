/**
 * Turn pipeline: assemble scene, call Mistral, write ledger and world_graph, vocabulary.
 * Spec Section 5.
 */

import type Database from "better-sqlite3";
import {
  getPlayer,
  getNode,
  getEntitiesInLocation,
  getPlayerInventory,
  getRecentHistoryForNode,
  getFullVocabulary,
  writeHistoryLedger,
  updateWorldGraphAdjectives,
  insertVocabulary,
} from "./db/database.js";
import type { WorldNode } from "./db/schema.js";
import {
  runMistralTurn,
  checkOllamaReachable,
  type SceneContext,
  type SceneEntity,
  type MistralResponse,
  type VocabularyItem,
} from "./ollama.js";

const OLLAMA_UNREACHABLE_PROSE =
  "The world pauses, as if holding its breath. (Engine: Ollama unreachable. Please check the local model service.)";

const MALFORMED_RESPONSE_PROSE =
  "The world flickers uncertainly. (Engine: The story engine could not interpret the outcome. Please try again.)";

function toSceneEntity(node: WorldNode, recentHistory: string[]): SceneEntity {
  const adjectives = typeof node.adjectives === "string" ? JSON.parse(node.adjectives || "[]") : node.adjectives;
  return {
    node_id: node.node_id,
    node_type: node.node_type,
    name: node.name,
    base_description: node.base_description,
    adjectives: Array.isArray(adjectives) ? adjectives : [],
    recent_history: recentHistory,
  };
}

function assembleSceneContext(db: Database.Database): SceneContext | null {
  const player = getPlayer(db);
  if (!player) return null;
  const locationId = player.location_id;
  if (!locationId) return null;
  const location = getNode(db, locationId);
  if (!location) return null;

  const inLocation = getEntitiesInLocation(db, locationId);
  const inventory = getPlayerInventory(db);
  const inventoryNodeIds = inventory.map((n) => n.node_id);

  const allEntities = [location, ...inLocation, player];
  const entities: SceneEntity[] = [];
  for (const node of allEntities) {
    if (node.node_id === "player") continue;
    const recent = getRecentHistoryForNode(db, node.node_id, 3).map((h) => h.prose_impact ?? "").filter(Boolean);
    entities.push(toSceneEntity(node, recent));
  }

  const playerRecent = getRecentHistoryForNode(db, "player", 3).map((h) => h.prose_impact ?? "").filter(Boolean);
  const playerEntity = toSceneEntity(player, playerRecent);
  (playerEntity as SceneEntity & { location_id: string }).location_id = locationId;

  const vocabulary: VocabularyItem[] = getFullVocabulary(db).map((v) => ({
    adjective: v.adjective,
    rule_description: v.rule_description,
  }));

  return {
    location: toSceneEntity(location, getRecentHistoryForNode(db, location.node_id, 3).map((h) => h.prose_impact ?? "")),
    entities,
    player: playerEntity,
    inventoryNodeIds,
    vocabulary,
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
        prose_impact: i.prose_impact,
        adjectives_old: i.adjectives_old,
        adjectives_new: i.adjectives_new,
      },
    ])
  );

  for (const nodeId of sceneNodeIds) {
    let entry = impactByNode.get(nodeId);
    if (!entry) {
      const node = getNode(db, nodeId);
      const currentAdj = node ? (typeof node.adjectives === "string" ? node.adjectives : JSON.stringify(node.adjectives)) : "[]";
      entry = {
        prose_impact: "No change.",
        adjectives_old: JSON.parse(currentAdj),
        adjectives_new: JSON.parse(currentAdj),
      };
    }
    impactByNode.set(nodeId, entry);
  }

  const ledgerEntries = Array.from(impactByNode.entries()).map(([node_id, entry]) => ({
    timestamp: now,
    action_description: actionDescription,
    node_id,
    prose_impact: entry.prose_impact,
    adjectives_old: JSON.stringify(entry.adjectives_old),
    adjectives_new: JSON.stringify(entry.adjectives_new),
    system_event: null as string | null,
  }));

  try {
    db.transaction(() => {
      writeHistoryLedger(db, ledgerEntries);
      for (const [node_id, entry] of impactByNode) {
        const node = getNode(db, node_id);
        if (!node) {
          console.warn(`[TaleShed] Mistral returned node_id not in world_graph: ${node_id}, skipping`);
          continue;
        }
        const oldJson = JSON.stringify(entry.adjectives_old);
        const newJson = JSON.stringify(entry.adjectives_new);
        if (oldJson !== newJson) {
          updateWorldGraphAdjectives(db, node_id, newJson);
        }
      }
      for (const na of mistralResponse.new_adjectives ?? []) {
        if (na?.adjective && na?.rule_description) {
          insertVocabulary(db, na.adjective, na.rule_description, 0);
        }
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
