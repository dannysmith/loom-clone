#!/usr/bin/env bash
#
# Tier 4: real-capture tests (SCStream + AVCaptureSession), including
# the 1440p known-hang reproduction (T4.2). Same safety contract as
# Tier 3 — ONE config per invocation, refuses to batch, so that a wedge
# lands on a single last-known-good marker rather than inside a sweep.
#
# Safety contract:
#   1. Require an explicit config name as the first argument.
#   2. Refuse to start if test-runs/_in-progress.json exists.
#   3. Dry-run before real run — catches structural bugs before the
#      harness touches AVFoundation.
#   4. If watchdog fires (exit 40), loudly tell the user to follow
#      the recovery procedure and do NOT offer retries.
#
# Usage:
#   ./run-tier-4.sh T4.1
#   ./run-tier-4.sh T4.1-real-capture-phase-2-1080p
#   ./run-tier-4.sh --dry-run T4.2
#   ./run-tier-4.sh --list
#
# The first form prefix-matches the configs in test-configs/tier-4/.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
TIER_DIR="$SCRIPT_DIR/test-configs/tier-4"
TEST_RUNS_ROOT="$REPO_ROOT/test-runs"
HARNESS_APP="$REPO_ROOT/app/build/Debug/LoomCloneTestHarness.app"
HARNESS_BIN="$HARNESS_APP/Contents/MacOS/LoomCloneTestHarness"

DRY_RUN_ONLY=0
TARGET=""
for arg in "$@"; do
    case "$arg" in
        --dry-run|--dry-run-only) DRY_RUN_ONLY=1 ;;
        --list)
            echo "Tier 4 configs:"
            for config in "$TIER_DIR"/*.json; do
                echo "  $(basename "$config" .json)"
            done
            exit 0
            ;;
        --help|-h)
            sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        -*)
            echo "unknown flag: $arg" >&2
            exit 2
            ;;
        *)
            if [ -n "$TARGET" ]; then
                echo "error: run one config at a time (got '$TARGET' and '$arg')" >&2
                exit 2
            fi
            TARGET="$arg"
            ;;
    esac
done

if [ -z "$TARGET" ]; then
    cat <<EOM >&2
error: Tier 4 runs one config at a time — pass the config name.

available configs:
EOM
    for config in "$TIER_DIR"/*.json; do
        echo "  $(basename "$config" .json)" >&2
    done
    cat <<EOM >&2

usage:
  $(basename "$0") T4.1
  $(basename "$0") T4.1-phase-2-1080p-stable-baseline
  $(basename "$0") --dry-run T4.2
EOM
    exit 2
fi

# Resolve prefix match.
matches=()
for config in "$TIER_DIR"/*.json; do
    name="$(basename "$config" .json)"
    if [ "$name" = "$TARGET" ] || [ "$name" = "${TARGET}" ] || [[ "$name" == "${TARGET}"* ]]; then
        matches+=("$config")
    fi
done

if [ ${#matches[@]} -eq 0 ]; then
    echo "error: no Tier 4 config matches '$TARGET'" >&2
    echo "available:" >&2
    for config in "$TIER_DIR"/*.json; do
        echo "  $(basename "$config" .json)" >&2
    done
    exit 2
fi

if [ ${#matches[@]} -gt 1 ]; then
    echo "error: '$TARGET' matches multiple configs — be more specific:" >&2
    for m in "${matches[@]}"; do
        echo "  $(basename "$m" .json)" >&2
    done
    exit 2
fi

CONFIG="${matches[0]}"
NAME="$(basename "$CONFIG" .json)"

# ---- Preflight ----

if [ ! -x "$HARNESS_BIN" ]; then
    cat <<EOM >&2
error: harness binary not found at:
    $HARNESS_BIN

build it first:
    cd app && xcodebuild -project LoomClone.xcodeproj -target LoomCloneTestHarness -configuration Debug build
EOM
    exit 2
fi

mkdir -p "$TEST_RUNS_ROOT"

if [ -f "$TEST_RUNS_ROOT/_in-progress.json" ]; then
    cat <<EOM >&2
error: previous run left an in-progress marker at:
    $TEST_RUNS_ROOT/_in-progress.json

The last test didn't finish cleanly — probably a hang that forced a
reboot. Follow the recovery procedure in app/TestHarness/README.md
before running anything else.
EOM
    exit 2
fi

# ---- Run ----

echo "== Tier 4 single-config run (real capture) =="
echo "config:   $NAME"
echo "file:     $CONFIG"
echo "runs out: $TEST_RUNS_ROOT"
echo "binary:   $HARNESS_BIN"
echo

echo "dry-run..."
"$HARNESS_BIN" --config "$CONFIG" --dry-run --test-runs-root "$TEST_RUNS_ROOT"
dry_exit=$?
if [ $dry_exit -ne 0 ]; then
    echo "  FAIL (dry-run exit=$dry_exit)" >&2
    exit $dry_exit
fi

if [ $DRY_RUN_ONLY -eq 1 ]; then
    echo "dry-run-only: skipping real run"
    exit 0
fi

echo
echo "running $NAME (watchdog fires at duration + grace)..."
(cd "$REPO_ROOT" && "$HARNESS_BIN" --config "$CONFIG" --test-runs-root "$TEST_RUNS_ROOT")
exit_code=$?

echo
case $exit_code in
    0)  echo "RESULT: PASS" ;;
    20) echo "RESULT: DEGRADED" ;;
    30) echo "RESULT: FAIL (recorded)" ;;
    40)
        cat <<EOM

RESULT: FAIL-KILLED (watchdog fired)

The pipeline wedged and the watchdog hard-killed the process. Before
running anything else:

1. Check that the Mac is still responsive. If the GUI is wedged, you
   need a hard reboot (power button) — the watchdog can kill the
   harness process but it can't rescue from a kernel-level wedge.
2. After reboot, check test-runs/_in-progress.json. Record the
   dangerous config somewhere durable.
3. Move the marker aside:
     mv test-runs/_in-progress.json test-runs/_last-hang-\$(date +%F).json
4. Update docs/m2-pro-video-pipeline-failures.md with the evidence.
5. Do NOT re-run this config without a plan for what you're changing
   next time.
EOM
        ;;
    *)  echo "RESULT: FAIL (exit=$exit_code)" ;;
esac

if [ -f "$TEST_RUNS_ROOT/_in-progress.json" ]; then
    echo
    echo "warning: in-progress marker still present at:" >&2
    echo "  $TEST_RUNS_ROOT/_in-progress.json" >&2
    echo "the run did not clear it — follow the recovery procedure." >&2
fi

exit $exit_code
