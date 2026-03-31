#!/usr/bin/env bash
# Start both the TaleShed MCP HTTP server and the authoring web app.
# If either process exits, this script exits (so systemd can restart both).
# Requires .env with TALESHED_WEB_API_KEY (authoring server exits with 1 if missing).

set -e
SCRIPT_DIR="$(dirname "$0")"
cd "$SCRIPT_DIR/.."
NODE="${NODE:-node}"

# Ensure we can run node (systemd often has a minimal PATH)
if ! command -v "$NODE" >/dev/null 2>&1; then
  echo "TaleShed run-with-authoring: node not found. Set NODE=/full/path/to/node or PATH in the service unit." >&2
  exit 1
fi

HTTP_PID=""
AUTH_PID=""
EXIT_CODE=1

cleanup() {
  [ -n "$HTTP_PID" ] && kill "$HTTP_PID" 2>/dev/null || true
  [ -n "$AUTH_PID" ] && kill "$AUTH_PID" 2>/dev/null || true
  exit "${EXIT_CODE}"
}
trap cleanup EXIT TERM INT

# Run from project root so dotenv finds .env
"$NODE" dist/http.js &
HTTP_PID=$!
"$NODE" dist/authoring-server.js &
AUTH_PID=$!

# When the first child exits, kill the other and exit with that child's status
wait -n
EXIT_CODE=$?
cleanup
