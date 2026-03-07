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
  updateWorldGraphLocation,
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

/** Parse exits JSON from a location node; returns { label, target }[]. */
function safeParseExits(val: string | undefined | null): { label: string; target: string }[] {
  try {
    if (!val) return [];
    const parsed = JSON.parse(val);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((e): e is { label?: string; target?: string } => e != null && typeof e === "object")
      .map((e) => ({ label: String(e.label ?? ""), target: String(e.target ?? "") }))
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

  const ledgerEntries = Array.from(impactByNode.entries()).map(([node_id, entry]) => ({
    timestamp: now,
    action_description: actionDescription,
    node_id,
    prose_impact: sanitizeProseForLedger(entry.prose_impact),
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
        if (entry.new_location_id != null) {
          updateWorldGraphLocation(db, node_id, entry.new_location_id);
        }
      }
      const newAdjs = Array.isArray(mistralResponse.new_adjectives) ? mistralResponse.new_adjectives : [];
      for (const na of newAdjs) {
        const adj = na && typeof na === "object" && typeof (na as { adjective?: unknown }).adjective === "string" ? (na as { adjective: string; rule_description?: string }).adjective.trim() : "";
        const rule = na && typeof na === "object" && typeof (na as { rule_description?: unknown }).rule_description === "string" ? (na as { rule_description: string }).rule_description.trim() : "";
        if (adj) {
          insertVocabulary(db, adj, rule || "(No description)", 0);
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
