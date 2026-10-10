#!/bin/bash
# Mirrors the built extension (dist/ext) to a native Windows folder so Chrome can
# "Load unpacked" it reliably (Chrome is flaky loading extensions from \\wsl.localhost paths).
#
# Usage: npm run sync:win            (default target: /mnt/d/code/ScrollCollector-dev)
#        SC_WIN_DIR=/mnt/c/x npm run sync:win
set -euo pipefail
cd "$(dirname "$0")/.."

SRC="dist/ext/"
DEST="${SC_WIN_DIR:-/mnt/d/code/ScrollCollector-dev}"

if [ ! -f "${SRC}manifest.json" ]; then
  echo "[sync-win] dist/ext is missing. Run \`npm run build:ext\` first." >&2
  exit 1
fi

mkdir -p "$DEST"
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete --checksum "$SRC" "$DEST/"
else
  rm -rf "${DEST:?}"/*
  cp -r "$SRC". "$DEST/"
fi
echo "[sync-win] Synced to $DEST — in chrome://extensions click the reload icon on ScrollCollector."
