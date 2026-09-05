#!/usr/bin/env bash
#
# Weekly restic repository integrity check, with a healthchecks.io ping on
# success. Runs from the VPS host's crontab (Sundays 04:30 UTC — an hour after
# the daily backup, so the two never overlap). Alerting is absence-based: a
# failed check aborts before the ping, and healthchecks.io emails when the
# ping doesn't arrive on schedule.
#
# Prerequisites: the same restic setup as backup.sh, plus HC_RESTIC_CHECK_URL
# in ~/.config/loom-clone-ops.env. See docs/developer/operations.md.

set -euo pipefail

export RESTIC_REPOSITORY="sftp:hetzner-backup:loom-clone"
export RESTIC_PASSWORD_FILE="$HOME/.config/restic-password"

LOG_DIR="$HOME/logs"
LOG_FILE="$LOG_DIR/backup-check.log"
mkdir -p "$LOG_DIR"

log() {
  echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*" | tee -a "$LOG_FILE"
}

log "=== restic check started ==="
restic check 2>&1 | tee -a "$LOG_FILE"
log "=== restic check finished ==="

OPS_ENV="$HOME/.config/loom-clone-ops.env"
if [[ -f "$OPS_ENV" ]]; then
  # shellcheck disable=SC1090
  source "$OPS_ENV"
fi
if [[ -n "${HC_RESTIC_CHECK_URL:-}" ]]; then
  curl -fsS -m 10 --retry 5 "$HC_RESTIC_CHECK_URL" > /dev/null \
    && log "healthchecks ping sent" \
    || log "WARNING: healthchecks ping failed"
else
  log "WARNING: HC_RESTIC_CHECK_URL not set in $OPS_ENV — integrity-check alerting is not armed"
fi
