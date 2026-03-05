#!/usr/bin/env node
/**
 * TaleShed MCP Server — Play Mode
 * Spec: TaleShed_MCP_Spec_v0.1.pdf
 *
 * Exposes three tools: take_turn, bookmark, restore_to_bookmark.
 * Transport: stdio (for Claude Desktop or other MCP clients).
 */

import { McpServer, StdioServerTransport } from "./sdk-shim.js";
import { z } from "zod";
import { initDatabase, getDbPath } from "./db/schema.js";
import { handleTakeTurn, handleBookmark, handleRestoreToBookmark } from "./tools.js";

const DB_PATH = getDbPath();
const db = initDatabase(DB_PATH);

const server = new McpServer(
  {
    name: "taleshed",
    version: "0.1.0",
  },
  {
    capabilities: { tools: {} },
  }
);

const TakeTurnSchema = z.object({
  player_command: z.string().describe("The raw text input from the player, e.g. 'ask Ciarán about the manuscript' or 'pick up the torch'"),
  recent_history: z.string().optional().describe("Optional. A short prose summary or transcript of the last 2–4 exchanges, for reconciliation context."),
});

server.registerTool(
  "take_turn",
  {
    title: "Take Turn",
    description: "The core game loop. Pass the player's command and optional recent prose history. Returns result (success/failure/partial), prose for narration, and optional error if the tool failed.",
    inputSchema: TakeTurnSchema,
  },
  async (args: unknown) => {
    const parsed = TakeTurnSchema.safeParse(args);
    if (!parsed.success) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              result: "error",
              prose: "",
              error: parsed.error.message,
            }),
          },
        ],
      };
    }
    const out = await handleTakeTurn(db, parsed.data);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(out) }],
    };
  }
);

server.registerTool(
  "bookmark",
  {
    title: "Bookmark",
    description: "Saves the current world state as a restore point. The player can return to this point later with restore_to_bookmark. No parameters.",
    inputSchema: z.object({}),
  },
  async () => {
    const out = handleBookmark(db);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(out) }],
    };
  }
);

server.registerTool(
  "restore_to_bookmark",
  {
    title: "Restore to Bookmark",
    description: "Rolls the world back to the most recent bookmark. Returns success and confirmation prose. No parameters.",
    inputSchema: z.object({}),
  },
  async () => {
    const out = handleRestoreToBookmark(db);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(out) }],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);

process.stderr.write(`TaleShed MCP server running (stdio), database: ${DB_PATH}\n`);
