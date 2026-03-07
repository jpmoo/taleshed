#!/usr/bin/env bash
# Start both the TaleShed MCP HTTP server and the authoring web app.
# If either process exits, this script exits (so systemd can restart both).
# Requires .env (or env) with TALESHED_WEB_API_KEY for the authoring server.

set -e
cd "$(dirname "$0")/.."
NODE="${NODE:-node}"
HTTP_PID=""
AUTH_PID=""
EXIT_CODE=1

cleanup() {
  [ -n "$HTTP_PID" ] && kill "$HTTP_PID" 2>/dev/null || true
  [ -n "$AUTH_PID" ] && kill "$AUTH_PID" 2>/dev/null || true
  exit "${EXIT_CODE}"
}
trap cleanup EXIT TERM INT

$NODE -r dotenv/config dist/http.js &
HTTP_PID=$!
$NODE -r dotenv/config dist/authoring-server.js &
AUTH_PID=$!

# When the first child exits, kill the other and exit with that child's status
wait -n
EXIT_CODE=$?
cleanup
