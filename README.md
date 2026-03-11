# TaleShed MCP Server

Interactive fiction engine over the [Model Context Protocol](https://modelcontextprotocol.io/) (MCP). Implements **TaleShed MCP Server Spec v0.1** (Play Mode proof-of-concept).

## Overview

- **MCP server** (Node.js): exposes three tools — `take_turn`, `bookmark`, `restore_to_bookmark`.
- **Ollama** (local): Mistral 7B via `http://localhost:11434` for world reasoning and narrative output.
- **SQLite**: one database file with `world_graph`, `history_ledger`, and `vocabulary`. Vocabulary is seeded at setup and can grow at runtime when the model proposes new adjectives that pass engine checks (transient and location-only terms are rejected).
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

Optional env: `TALESHED_DB_PATH`, `OLLAMA_BASE`, `OLLAMA_MODEL`.

## Run the MCP server

**HTTP (recommended for Claude / remote clients)** — connect via URL:

```bash
npm start
# or: npm run start:http
```

Server listens on **http://localhost:3000** by default. The MCP endpoint is:

- **URL:** `http://localhost:3000/mcp`

Configure Claude (or any MCP client that supports Streamable HTTP) to use this URL as the server endpoint. No local path or command is required — the client reaches the server over HTTP.

**SSE (legacy)** — if Streamable HTTP is flaky or your client only supports HTTP+SSE:

```bash
npm run start:sse
```

- **GET** `http://localhost:3000/sse` — open the server→client event stream; the response includes an `endpoint` event with the POST URL (including `sessionId`).
- **POST** `http://localhost:3000/messages?sessionId=<id>` — send JSON-RPC messages (use the `sessionId` from the GET response).

SSE is simpler in some environments (proxies, older clients) but is deprecated in the MCP spec in favor of Streamable HTTP.

**Environment:**

| Variable | Default | Description |
|----------|---------|-------------|
| `TALESHED_PORT` or `PORT` | `3000` | HTTP server port. |
| `TALESHED_HOST` | `0.0.0.0` | Bind address (`0.0.0.0` = all interfaces; use `127.0.0.1` for local only). |

**Stdio (local process)** — for clients that spawn the server as a subprocess:

```bash
npm run start:stdio
```

Configure the client with the command to run, e.g. `node /path/to/taleshed/dist/index.js`.

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

## Streamable HTTP vs SSE

| | Streamable HTTP | SSE (legacy) |
|---|-----------------|--------------|
| **Endpoint** | Single URL: `POST /mcp` (and optional GET for streaming). | Two: `GET /sse` to open stream, then `POST /messages?sessionId=...` for each request. |
| **State** | Can be stateless (no session). | Stateful: server keeps one SSE connection and session per client. |
| **Spec status** | Current, recommended. | Deprecated (replaced by Streamable HTTP in 2025-03-26). |
| **Easier when** | Your client supports it; one URL, no session bookkeeping. | Proxies or clients that only speak HTTP+SSE; sometimes more reliable in constrained setups. |

If Streamable HTTP gives you trouble (e.g. connection or proxy issues), run with **SSE** instead: `npm run start:sse` and point the client at `http://localhost:3000/sse`; the client must then POST to `/messages?sessionId=...` using the session ID from the SSE `endpoint` event.

## Authoring web app (world graph)

A graph-paper style editor for the world graph: locations are 5×5 squares; exits are 2-block lines (N/S/E/W). Requires an API key in the URL.

```bash
npm run start:authoring
```

Open **http://localhost:8043/?api=YOUR_KEY** (port defaults to MCP port + 1). Set in `.env`:

| Variable | Default | Description |
|----------|---------|-------------|
| `TALESHED_WEB_IP` | `0.0.0.0` | Bind address for the authoring server. |
| `TALESHED_WEB_PORT` | MCP port + 1 (e.g. 8043) | Authoring server port. |
| `TALESHED_WEB_API_KEY` | (required) | Secret key; must be passed as `?api=KEY` in the URL (or `X-API-Key` header for API calls). |

Click a location to edit all fields in a modal; Save updates, Delete removes the node (with confirmation). Exits use JSON: `[{ "label", "target", "direction": "north"|"south"|"east"|"west" }]`. Use `grid_x` and `grid_y` to place locations on the grid.

**Database sharing:** MCP server and authoring app use the same SQLite file. If you see *attempt to write a readonly database* or *database is locked* while using Claude with the authoring app open, close the authoring app (or stop the authoring server) when playing, or ensure the DB file and its directory are writable by the user running the MCP server. The engine uses a 10s busy timeout to wait for the other process to release the lock.

## Spec reference

See `TaleShed_MCP_Spec_v0.1.pdf` in this repo for full data model, turn pipeline, Ollama prompt structure, and error handling.

For a concise rundown of every LLM call (turn, resolve, definition fetch, engine/transient checks, backfill), see [docs/LLM_CALLS_RUNDOWN.md](docs/LLM_CALLS_RUNDOWN.md).

## License

MIT
