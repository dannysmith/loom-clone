#!/usr/bin/env bash
#
# Daily backup of loom-clone data to a Hetzner Storage Box via restic.
# Intended to run from the VPS host's crontab as the deploy user.
#
# What gets backed up:
#   - data/app.db.bak  (point-in-time SQLite snapshot, deleted after run)
#   - Per-video: recording.json, chapters.json (user-edited chapter titles —
#     the only user-authored file outside the DB), derivatives/source.mp4 (the
#     pristine original), derivatives/thumbnail.jpg, derivatives/edits.json
#     (edit decisions), derivatives/words.json (word timestamps),
#     derivatives/captions.original.* (the transcript exactly as the Mac
#     produced it)
#
# What does NOT get backed up — everything here is regenerable from the files
# above by re-running post-processing:
#   - HLS segments, the <H>p.mp4 presentation master and its downscaled variants,
#     the served captions.srt (remapped from captions.original.* through the EDL),
#     storyboards, thumbnail candidates, peaks, editor storyboards
#
# Note that a restored video therefore needs a reprocess before it serves: the
# master is a derivative now, not the archive.
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

# Cap the log: nothing rotates it, and it once reached 86 MB (restic --verbose
# output, doubled by a since-removed crontab redirect). Trim to the most
# recent ~1 MB whenever it exceeds 5 MB.
if [[ -f "$LOG_FILE" && $(wc -c < "$LOG_FILE") -gt 5242880 ]]; then
  tail -c 1048576 "$LOG_FILE" > "$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"
fi

log() {
  echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*" | tee -a "$LOG_FILE"
}

log "=== backup started ==="

# ---------------------------------------------------------------------------
# Pre-flight checks
# ---------------------------------------------------------------------------

# A leftover snapshot means a previous run failed after the sqlite step (e.g.
# the storage box was unreachable during restic). It's disposable — a fresh
# one is taken below — so replace it and carry on: refusing to run would turn
# one transient failure into an indefinite backup outage, and the missed
# healthchecks ping is the alarm bell, not this check.
if [[ -f "$DATA_DIR/app.db.bak" ]]; then
  log "WARNING: stale app.db.bak found (a previous run likely failed) — replacing it and continuing"
  rm -f "$DATA_DIR/app.db.bak"
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
    "$dir/chapters.json" \
    "$dir/derivatives/source.mp4" \
    "$dir/derivatives/thumbnail.jpg" \
    "$dir/derivatives/edits.json" \
    "$dir/derivatives/words.json" \
    "$dir/derivatives/captions.original.srt" \
    "$dir/derivatives/captions.original.vtt"; do
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
# No --verbose: it logs every file on every run (the main reason the log once
# hit 86 MB); the end-of-run summary restic prints anyway is what matters.
restic backup \
  --files-from "$FILELIST" \
  2>&1 | tee -a "$LOG_FILE"

log "restic backup complete"

# Record the last successful backup where the server can see it: the admin
# settings page and the self-check read this marker from inside the container
# (display only — backup *alerting* is the healthchecks ping below).
date -u '+%Y-%m-%dT%H:%M:%SZ' > "$DATA_DIR/.last-backup"

# ---------------------------------------------------------------------------
# Step 4: Clean up SQLite snapshot
# ---------------------------------------------------------------------------

rm -f "$DATA_DIR/app.db.bak"
log "SQLite snapshot removed"

# ---------------------------------------------------------------------------
# Step 5: Prune old snapshots
# ---------------------------------------------------------------------------

log "pruning old snapshots..."
# --group-by host matters: restic's default grouping is host AND path set, and
# --files-from produces a different path set whenever a video is added — so
# each superseded group stopped receiving snapshots and kept its last ~7
# dailies forever (April dailies were still in the repo five months on).
# Grouping by host alone applies the retention policy to one shared timeline.
restic forget --prune \
  --group-by host \
  --keep-daily 7 \
  --keep-weekly 4 \
  --keep-monthly 12 \
  2>&1 | tee -a "$LOG_FILE"

log "=== backup finished ==="

# ---------------------------------------------------------------------------
# Step 6: Dead-man's-switch ping
# ---------------------------------------------------------------------------
# Alerting is absence-based: healthchecks.io emails when this ping does NOT
# arrive on schedule. Any failure above aborts the script (set -e) before this
# line, so a failed backup = no ping = an alert. See
# docs/developer/operations.md for setup.

OPS_ENV="$HOME/.config/loom-clone-ops.env"
if [[ -f "$OPS_ENV" ]]; then
  # shellcheck disable=SC1090
  source "$OPS_ENV"
fi
if [[ -n "${HC_BACKUP_URL:-}" ]]; then
  curl -fsS -m 10 --retry 5 "$HC_BACKUP_URL" > /dev/null \
    && log "healthchecks ping sent" \
    || log "WARNING: healthchecks ping failed"
else
  log "WARNING: HC_BACKUP_URL not set in $OPS_ENV — backup failure alerting is not armed"
fi
