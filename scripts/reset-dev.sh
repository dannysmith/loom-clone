#!/usr/bin/env bash
#
# Resets all local dev data: recordings, server data, database, and generates
# a fresh API key. Only operates on local dev paths — safe to run anytime.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVER_DIR="$REPO_ROOT/server"
RECORDINGS_DIR="$HOME/Library/Application Support/LoomClone/recordings"
SERVER_DATA_DIR="$SERVER_DIR/data"

echo "=== Dev Reset ==="
echo ""

# 1. Clear macOS app local recordings
if [ -d "$RECORDINGS_DIR" ]; then
  rm -rf "$RECORDINGS_DIR"
  echo "[x] Cleared local recordings: $RECORDINGS_DIR"
else
  echo "[ ] No local recordings to clear"
fi

# 2. Clear server data directory (video files, db, etc.)
if [ -d "$SERVER_DATA_DIR" ]; then
  rm -rf "$SERVER_DATA_DIR"
  echo "[x] Cleared server data: $SERVER_DATA_DIR"
else
  echo "[ ] No server data to clear"
fi

# 3. Re-initialise the database (migrations run on initDb) and generate a fresh API key
echo ""
echo "Generating fresh API key..."
echo ""
cd "$SERVER_DIR"
bun run keys:create "dev"
echo ""
echo "=== Done. Paste the token above into the macOS app settings. ==="
