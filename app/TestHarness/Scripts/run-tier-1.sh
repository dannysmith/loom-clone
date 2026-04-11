#!/usr/bin/env bash
#
# Tier 1: single-component isolation tests with synthetic frame sources.
#
# Safety contract (task-0C):
#   1. Refuse to start if test-runs/_in-progress.json exists (signals
#      that the previous run hung the Mac — don't retry blindly).
#   2. Run each config in order.
#   3. Dry-run each config before running it for real (first-time
#      configs get caught by a structural bug before they touch
#      AVFoundation).
#   4. Stop on any fail-killed result.
#   5. Stop on any fail-recorded result unless --continue-on-fail is
#      passed.
#   6. Write a summary at the end.
#
# This script is intentionally plain POSIX-ish bash — it needs to be
# trivial to run straight after a hard-reboot without relying on shell
# plugins or asdf or anything funky.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
TIER_DIR="$SCRIPT_DIR/test-configs/tier-1"
TEST_RUNS_ROOT="$REPO_ROOT/test-runs"
HARNESS_APP="$REPO_ROOT/app/build/Debug/LoomCloneTestHarness.app"
HARNESS_BIN="$HARNESS_APP/Contents/MacOS/LoomCloneTestHarness"

CONTINUE_ON_FAIL=0
DRY_RUN_ONLY=0
for arg in "$@"; do
    case "$arg" in
        --continue-on-fail) CONTINUE_ON_FAIL=1 ;;
        --dry-run-only)     DRY_RUN_ONLY=1 ;;
        *) echo "unknown flag: $arg"; exit 2 ;;
    esac
done

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
reboot. Review the marker contents and either:

  - Mark the config as confirmed-dangerous and move the marker aside
    (e.g. mv _in-progress.json _last-hang.json), or
  - If you're certain it was unrelated (e.g. you killed the test
    manually), remove the marker: rm $TEST_RUNS_ROOT/_in-progress.json

Then re-run this script.
EOM
    exit 2
fi

# ---- Run ----

echo "== Tier 1 isolation tests =="
echo "configs: $TIER_DIR"
echo "runs out: $TEST_RUNS_ROOT"
echo "binary:   $HARNESS_BIN"
echo

pass_count=0
degraded_count=0
fail_count=0
killed_count=0
skipped_count=0
summary_lines=()

for config in "$TIER_DIR"/*.json; do
    name="$(basename "$config" .json)"
    echo "---- $name ----"

    # Dry-run first — cheap sanity check that config decodes and the
    # harness knows what to do with it. Doesn't touch AVFoundation.
    echo "dry-run..."
    "$HARNESS_BIN" --config "$config" --dry-run --test-runs-root "$TEST_RUNS_ROOT"
    dry_exit=$?
    if [ $dry_exit -ne 0 ]; then
        echo "  FAIL (dry-run exit=$dry_exit) — skipping real run"
        summary_lines+=("$name: DRY-RUN FAIL ($dry_exit)")
        skipped_count=$((skipped_count + 1))
        if [ $CONTINUE_ON_FAIL -eq 0 ]; then
            echo "stopping; pass --continue-on-fail to keep going"
            break
        fi
        continue
    fi

    if [ $DRY_RUN_ONLY -eq 1 ]; then
        echo "  dry-run-only: skipping real run"
        summary_lines+=("$name: DRY-RUN ONLY")
        continue
    fi

    # Real run.
    echo "running..."
    # Launch via the binary directly rather than `open -a` so we stay
    # synchronous and get the real exit code. cwd is the repo root so
    # the harness's default test-runs path resolves correctly.
    (cd "$REPO_ROOT" && "$HARNESS_BIN" --config "$config" --test-runs-root "$TEST_RUNS_ROOT")
    exit_code=$?

    case $exit_code in
        0)
            echo "  PASS"
            pass_count=$((pass_count + 1))
            summary_lines+=("$name: PASS")
            ;;
        20)
            echo "  DEGRADED"
            degraded_count=$((degraded_count + 1))
            summary_lines+=("$name: DEGRADED")
            ;;
        30)
            echo "  FAIL (recorded)"
            fail_count=$((fail_count + 1))
            summary_lines+=("$name: FAIL-RECORDED")
            if [ $CONTINUE_ON_FAIL -eq 0 ]; then
                echo "stopping on recorded failure; pass --continue-on-fail to keep going"
                break
            fi
            ;;
        40)
            echo "  FAIL (killed by watchdog)"
            killed_count=$((killed_count + 1))
            summary_lines+=("$name: FAIL-KILLED")
            echo "ABORTING tier run — watchdog fired. Do not run subsequent tests."
            break
            ;;
        *)
            echo "  FAIL (exit=$exit_code)"
            fail_count=$((fail_count + 1))
            summary_lines+=("$name: FAIL ($exit_code)")
            if [ $CONTINUE_ON_FAIL -eq 0 ]; then
                break
            fi
            ;;
    esac
done

# ---- Summary ----

echo
echo "== Summary =="
echo "pass:     $pass_count"
echo "degraded: $degraded_count"
echo "fail:     $fail_count"
echo "killed:   $killed_count"
echo "skipped:  $skipped_count"
echo
for line in "${summary_lines[@]+"${summary_lines[@]}"}"; do
    echo "  $line"
done

if [ -f "$TEST_RUNS_ROOT/_in-progress.json" ]; then
    echo
    echo "warning: in-progress marker still present — a run did not clear it."
fi

# Exit non-zero if any run failed.
if [ $fail_count -gt 0 ] || [ $killed_count -gt 0 ]; then
    exit 1
fi
exit 0
