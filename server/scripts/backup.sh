#!/usr/bin/env bash
#
# Daily backup of loom-clone data to a Hetzner Storage Box via restic.
# Intended to run from the VPS host's crontab as the deploy user.
#
# What gets backed up:
#   - data/app.db.bak  (point-in-time SQLite snapshot, deleted after run)
#   - Per-video: recording.json, derivatives/source.mp4, derivatives/thumbnail.jpg
#
# What does NOT get backed up (regenerable from source.mp4):
#   - HLS segments, variants, storyboards, thumbnail candidates
#
# Prerequisites:
#   - restic, sqlite3 installed on the host
#   - SSH config alias 'hetzner-backup' pointing at the Storage Box (port 23)
#   - Restic repo initialised: restic -r sftp:hetzner-backup:loom-clone init
#   - Password file at ~/.config/restic-password (chmod 600)
#
# See docs/developer/backup-and-restore.md for full setup instructions.

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

DATA_DIR="/mnt/data/loom-clone"
export RESTIC_REPOSITORY="sftp:hetzner-backup:loom-clone"
export RESTIC_PASSWORD_FILE="$HOME/.config/restic-password"

LOG_DIR="$HOME/logs"
LOG_FILE="$LOG_DIR/backup.log"

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

mkdir -p "$LOG_DIR"

log() {
  echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*" | tee -a "$LOG_FILE"
}

log "=== backup started ==="

# ---------------------------------------------------------------------------
# Pre-flight checks
# ---------------------------------------------------------------------------

if [[ -f "$DATA_DIR/app.db.bak" ]]; then
  log "ERROR: $DATA_DIR/app.db.bak already exists — previous run may have crashed. Investigate before re-running."
  exit 1
fi

for cmd in restic sqlite3; do
  if ! command -v "$cmd" &>/dev/null; then
    log "ERROR: $cmd not found on PATH"
    exit 1
  fi
done

if [[ ! -f "$RESTIC_PASSWORD_FILE" ]]; then
  log "ERROR: restic password file not found at $RESTIC_PASSWORD_FILE"
  exit 1
fi

if [[ ! -f "$DATA_DIR/app.db" ]]; then
  log "ERROR: database not found at $DATA_DIR/app.db"
  exit 1
fi

# ---------------------------------------------------------------------------
# Step 1: SQLite online backup
# ---------------------------------------------------------------------------

log "creating SQLite snapshot..."
sqlite3 "$DATA_DIR/app.db" ".backup $DATA_DIR/app.db.bak"
log "SQLite snapshot created"

# ---------------------------------------------------------------------------
# Step 2: Build file list
# ---------------------------------------------------------------------------

FILELIST=$(mktemp)
# shellcheck disable=SC2064
trap "rm -f '$FILELIST'" EXIT

echo "$DATA_DIR/app.db.bak" >> "$FILELIST"

file_count=1
shopt -s nullglob
for dir in "$DATA_DIR"/*/; do
  vid_id=$(basename "$dir")
  # Skip non-UUID-looking directories (safety net)
  [[ "$vid_id" =~ ^[0-9a-f-]{36}$ ]] || continue

  for f in \
    "$dir/recording.json" \
    "$dir/derivatives/source.mp4" \
    "$dir/derivatives/thumbnail.jpg"; do
    if [[ -f "$f" ]]; then
      echo "$f" >> "$FILELIST"
      ((file_count++))
    fi
  done
done
shopt -u nullglob

log "file list built: $file_count files"

# ---------------------------------------------------------------------------
# Step 3: restic backup
# ---------------------------------------------------------------------------

log "running restic backup..."
restic backup \
  --files-from "$FILELIST" \
  --verbose 2>&1 | tee -a "$LOG_FILE"

log "restic backup complete"

# ---------------------------------------------------------------------------
# Step 4: Clean up SQLite snapshot
# ---------------------------------------------------------------------------

rm -f "$DATA_DIR/app.db.bak"
log "SQLite snapshot removed"

# ---------------------------------------------------------------------------
# Step 5: Prune old snapshots
# ---------------------------------------------------------------------------

log "pruning old snapshots..."
restic forget --prune \
  --keep-daily 7 \
  --keep-weekly 4 \
  --keep-monthly 12 \
  2>&1 | tee -a "$LOG_FILE"

log "=== backup finished ==="
