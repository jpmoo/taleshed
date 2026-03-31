#!/usr/bin/env bash
# Pull latest TaleShed, rebuild, restart systemd service.
# Usage: ./scripts/pull-and-restart.sh
# Or from anywhere: bash /path/to/taleshed/scripts/pull-and-restart.sh
# Override repo root: TALESHED_ROOT=/path/to/taleshed ./scripts/pull-and-restart.sh

set -euo pipefail

ROOT="${TALESHED_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$ROOT"

echo "==> $ROOT"

# Remove top-level *.log without failing when none exist
shopt -s nullglob
for f in *.log; do
  rm -f -- "$f"
  echo "Removed: $f"
done
shopt -u nullglob

git pull
npm run build
sudo systemctl restart taleshed

echo "==> taleshed restarted. Check: sudo systemctl status taleshed"
