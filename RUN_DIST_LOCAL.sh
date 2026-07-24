#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
TARGET="$ROOT/RadiantOS_Standalone.html"

if [[ ! -f "$TARGET" ]]; then
  echo "[ERROR] RadiantOS_Standalone.html not found. Run npm run build first."
  exit 1
fi

if command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$TARGET" >/dev/null 2>&1 &
  exit 0
fi

if command -v open >/dev/null 2>&1; then
  open "$TARGET"
  exit 0
fi

echo "$TARGET"
