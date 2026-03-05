# TaleShed MCP Server

Interactive fiction engine over the [Model Context Protocol](https://modelcontextprotocol.io/) (MCP). Implements **TaleShed MCP Server Spec v0.1** (Play Mode proof-of-concept).

## Overview

- **MCP server** (Node.js): exposes three tools — `take_turn`, `bookmark`, `restore_to_bookmark`.
- **Ollama** (local): Mistral 7B via `http://localhost:11434` for world reasoning and narrative output.
- **SQLite**: one database file with `world_graph`, `history_ledger`, and `vocabulary`.
- **Claude** (external): player-facing LLM; calls MCP tools and narrates from the returned prose.

## Requirements

- Node.js 18+
- Ollama with Mistral (e.g. `ollama pull mistral`)
- SQLite (via `better-sqlite3`)

## Setup

```bash
npm install
npm run build
npm run seed    # creates taleshed.db with starter vocabulary and sample world
```

Optional: set `TALESHED_DB_PATH` to use a different database file. Set `OLLAMA_BASE` or `OLLAMA_MODEL` to change Ollama endpoint/model.

## Run the MCP server

**Stdio (for Claude Desktop or other MCP clients):**

```bash
npm start
```

Configure your MCP client to run this command (e.g. in Claude Desktop’s `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "taleshed": {
      "command": "node",
      "args": ["/path/to/taleshed/dist/index.js"]
    }
  }
}
```

## Tools

| Tool | Purpose |
|------|--------|
| `take_turn` | Core loop: `player_command` (required), optional `recent_history`. Returns `result`, `prose`, and optional `error`. |
| `bookmark` | Saves current world state as a restore point. No args. |
| `restore_to_bookmark` | Rolls world back to last bookmark. No args. |

## GM setup (before play)

1. Ensure DB exists and tables are created (`npm run seed` or `npm run db:init` then manual vocab/world).
2. Populate `vocabulary` with starter adjectives (see spec Appendix A).
3. Populate `world_graph` with locations, NPCs, objects, and the `player` row (see spec Appendix B).
4. Start the MCP server and confirm Ollama is reachable (`GET http://localhost:11434/api/tags`).

## Spec reference

See `TaleShed_MCP_Spec_v0.1.pdf` in this repo for full data model, turn pipeline, Ollama prompt structure, and error handling.

## License

MIT
