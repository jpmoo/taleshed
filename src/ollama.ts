/**
 * Ollama API and Mistral prompt assembly.
 * Spec Section 4.
 */

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

export interface SceneContext {
  location: SceneEntity;
  entities: SceneEntity[];
  player: SceneEntity;
  inventoryNodeIds: string[];
  vocabulary: VocabularyItem[];
}

export interface MistralNodeImpact {
  node_id: string;
  prose_impact: string;
  adjectives_old: string[];
  adjectives_new: string[];
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
You must return exactly the fields described below and nothing else.`;
}

function buildSectionB(vocabulary: VocabularyItem[]): string {
  const vocabJson = JSON.stringify(
    vocabulary.map((v) => ({ adjective: v.adjective, rule_description: v.rule_description }))
  );
  return `VOCABULARY (adjectives and their rules):
${vocabJson}

When assigning adjectives to nodes, use existing vocabulary terms where possible.
If no existing term fits, invent a new adjective and include it in new_adjectives.`;
}

function buildSectionC(ctx: SceneContext): string {
  const loc = ctx.location;
  const adj = JSON.parse(loc.adjectives as unknown as string) as string[];
  let out = `CURRENT SCENE:
Location: ${loc.node_id} — ${loc.name}
Description: ${loc.base_description}
Location adjectives: ${JSON.stringify(adj)}

ENTITIES PRESENT:
`;
  for (const e of ctx.entities) {
    const adjList = Array.isArray(e.adjectives) ? e.adjectives : JSON.parse((e.adjectives as string) || "[]");
    out += `- ${e.node_type} | ${e.node_id} | ${e.name} | adjectives: ${JSON.stringify(adjList)} | ${e.base_description}\n`;
    out += `  Recent history: ${e.recent_history.join(" ")}\n`;
  }
  out += `\nPLAYER:\n`;
  const playerAdj = Array.isArray(ctx.player.adjectives)
    ? ctx.player.adjectives
    : JSON.parse((ctx.player.adjectives as string) || "[]");
  out += `- node_id: player | location: ${(ctx.player as { location_id?: string }).location_id ?? "?"} | adjectives: ${JSON.stringify(playerAdj)}\n`;
  out += `  Inventory: ${JSON.stringify(ctx.inventoryNodeIds)}\n`;
  out += `  Recent history: ${ctx.player.recent_history.join(" ")}\n`;
  return out;
}

function buildSectionD(recentHistory: string): string {
  return `RECENT NARRATION (last 2-4 exchanges as provided by Claude):
${recentHistory || "(none)"}

Check: does the recent narration describe anything inconsistent with the current world state above? If so, note corrections in your response.`;
}

function buildSectionE(playerCommand: string): string {
  return `PLAYER ACTION: ${playerCommand}

Return ONLY this JSON structure:
{
  "narrative_prose": "<string: prose description of what happened, for Claude to use>",
  "action_result": "<success | failure | partial>",
  "node_impacts": [
    {
      "node_id": "<string>",
      "prose_impact": "<string: what this node experienced>",
      "adjectives_old": ["<string>"],
      "adjectives_new": ["<string>"]
    }
  ],
  "new_adjectives": [
    {
      "adjective": "<string>",
      "rule_description": "<string>"
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
    buildSectionE(playerCommand),
  ];
  return sections.join("\n\n");
}

export async function callOllama(prompt: string): Promise<string> {
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
      throw new Error(`Ollama HTTP ${res.status}: ${text}`);
    }
    const data = (await res.json()) as { response?: string; error?: string };
    if (data.error) throw new Error(data.error);
    return data.response ?? "";
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

function parseJsonResponse(responseText: string): MistralResponse {
  const trimmed = responseText.trim();
  const jsonStart = trimmed.indexOf("{");
  const jsonEnd = trimmed.lastIndexOf("}") + 1;
  const jsonStr = jsonStart >= 0 && jsonEnd > jsonStart ? trimmed.slice(jsonStart, jsonEnd) : trimmed;
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

export async function runMistralTurn(
  ctx: SceneContext,
  playerCommand: string,
  recentHistory: string
): Promise<MistralResponse> {
  const prompt = assemblePrompt(ctx, playerCommand, recentHistory);
  const responseText = await callOllama(prompt);
  return parseJsonResponse(responseText);
}

export async function checkOllamaReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`, { method: "GET" });
    return res.ok;
  } catch {
    return false;
  }
}
