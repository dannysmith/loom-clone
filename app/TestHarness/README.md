# LoomCloneTestHarness

Diagnostic instrument for probing M2 Pro AVFoundation / VideoToolbox / CIContext configurations in isolation. Built to answer the hypotheses raised by task-0B and to bisect the failure modes documented in `docs/m2-pro-video-pipeline-failures.md`, without repeatedly hanging the developer's machine.

This is **not** a shippable part of LoomClone. It is a separate Xcode target (`LoomCloneTestHarness`) that lives in the same project so it can share entitlements and code-signing infrastructure. The main LoomClone recording pipeline is not modified by this task, and the harness does not depend on any of the main app's actors or UI.

## When to use it

- You have a hypothesis about what combination of writers / resolutions / tuning knobs is failing, and want to verify it without touching the main app.
- You are about to change the main recording pipeline and want to validate the change on isolated synthetic input first.
- You're sweeping a VideoToolbox / CVPixelBufferPool / SCStreamConfiguration property across a range of values and want machine-parseable pass/fail output.

See `docs/tasks-todo/task-0C-isolation-test-harness.md` for the full design context, the tier-by-tier test plan, and the safety scaffolding rationale.

## Build

```
cd app
xcodebuild -project LoomClone.xcodeproj -target LoomCloneTestHarness -configuration Debug build
```

This produces `app/build/Debug/LoomCloneTestHarness.app`. The binary inside is what the runner scripts execute directly (`open -a` would work too but loses stdout capture).

Every time `project.yml` changes you'll need to regenerate:

```
cd app && xcodegen generate
```

## Run a single config

```
./app/build/Debug/LoomCloneTestHarness.app/Contents/MacOS/LoomCloneTestHarness \
    --config app/TestHarness/Scripts/test-configs/tier-1/T1.1-prores-4k-alone.json
```

Exit codes:

| code | meaning |
|---|---|
| 0 | PASS |
| 20 | DEGRADED (completed but one or more soft-fail conditions tripped) |
| 30 | FAIL (recorded) — writer failed or output is missing |
| 40 | FAIL (killed) — watchdog fired, this config is dangerous |
| 2 | argv / config-file error |
| 1 | other |

## Dry-run a config

Dry-run validates the config, prints what the harness WOULD do, and exits without touching any AVFoundation entry point. **Always dry-run a new config before running it for real**, especially anything in Tier 3+:

```
./app/build/Debug/LoomCloneTestHarness.app/Contents/MacOS/LoomCloneTestHarness \
    --config path/to/config.json \
    --dry-run
```

## Run a whole tier

```
./app/TestHarness/Scripts/run-tier-1.sh
```

This script is the real entry point for systematic testing. It:

1. Refuses to start if `test-runs/_in-progress.json` exists (see "Recovery after a hang" below).
2. Dry-runs every config first.
3. Runs each config in order, stopping on the first fail-recorded or fail-killed result unless `--continue-on-fail` is passed.
4. Writes a summary at the end.

Only `run-tier-1.sh` is committed right now. Higher tiers will land incrementally. **Do not run Tier 3 tests** until the full safety scaffolding (watchdog + marker + in-process cleanup) has been validated with a dry-run for each config.

## Run outputs

Each run writes to `test-runs/<timestamp>-<config-name>/`:

```
test-runs/2026-04-11-153300-T1.1-prores-4k-alone/
├── config.json              // exact config the harness ran
├── events.jsonl             // timestamped per-writer events
├── result.json              // pass/fail summary + writer final state
├── system-snapshot-start.txt
├── system-snapshot-end.txt
└── outputs/                 // actual writer output files
    └── screen.mov
```

The `test-runs/` directory is tracked (`.gitkeep`) but its contents are gitignored so runs don't pollute the repo.

### What each file is

- **`config.json`** — byte-identical copy of the JSON the runner consumed. Start from this when reproducing a failure.
- **`events.jsonl`** — one line per structured event. Grep / jq-friendly. Look for `writer.failed-before-finish`, `writer.dropped`, `metronome.no-buffer`, `compositor.render-error`, `compositor.pool-exhausted`.
- **`result.json`** — the machine-readable outcome. `outcome` field is `"pass"` / `"degraded"` / `"fail-recorded"` / `"fail-killed"`. `issues` lists soft-fail reasons. `writers` has per-writer final status and byte counts.
- **`system-snapshot-{start,end}.txt`** — `vm_stat`, `sysctl`, `ps -M`, `ioreg -c IOSurfaceRoot -l` (truncated), `powermetrics` (if root). Diff these to see what changed across the run.
- **`outputs/`** — the actual writer outputs. Useful to open in QuickTime / `ffprobe` to confirm the files are well-formed.

## Recovery after a hang

If a Tier 3+ config triggers a kernel-level wedge and you have to hard-reboot the Mac:

1. Reboot and log back in.
2. **Do not run any tier script yet.**
3. Check `test-runs/_in-progress.json`. It will exist, and it will contain the name + full config of the test that hung. Read it.
4. Write the dangerous config's name down somewhere durable so you don't accidentally run it again.
5. Move the marker aside (don't delete it — keep it as a historical record):
   ```
   mv test-runs/_in-progress.json test-runs/_last-hang-2026-04-11.json
   ```
6. Update `docs/m2-pro-video-pipeline-failures.md` with the new hang if it's a new pattern.
7. Now you can run tier scripts again.

If the marker is missing after a hang you thought happened, either the harness finished cleanly (check the latest run directory) or the marker was somehow lost — either way, investigate before assuming it's safe to proceed.

## Adding a new test

1. Drop a new JSON file under `Scripts/test-configs/tier-<N>/`. The filename should start with `T<N>.<X>-` for ordering.
2. Dry-run it with `--dry-run` to sanity-check.
3. If it's a Tier 1 or Tier 2 config, you can just run it via `run-tier-<N>.sh`.
4. If it's Tier 3+, add the new config to the runner script (or a new runner script) and verify the safety scaffolding is active (marker, watchdog deadline) before running it for real.

Writer tunings are supplied as a `tunings` dict on the writer config. Currently-supported keys:

| writer kind | key | type |
|---|---|---|
| `raw-h264` | `averageBitRate` | int |
| `raw-h264` | `expectedFrameRate` | int |
| `raw-h264` | `maxKeyFrameIntervalDuration` | int (seconds) |
| `composited-hls` | `declareRec709Output` | bool (default true) |

New knobs are added by editing the relevant writer's `configure()` method — keep the mapping explicit rather than passing the dict through.

## What this harness does NOT do

- It does not run Tier 4 real-capture tests yet (`real-screen` / `real-camera` source kinds bail at setup time).
- It does not reproduce the main app's pause/resume/mode-switch machinery.
- It does not watch for `kIOGPUCommandBufferCallback*` log messages via `os_log`/`log stream` — for now, those show up in Xcode console when you run the harness attached to a debugger. A future iteration should shell out to `log stream --predicate 'eventMessage CONTAINS "kIOGPU"'` in the background and capture matches into the event log.
- It does not yet implement the segment cadence trend plot — `result.json` contains raw `segmentDurations` arrays for HLS writers that you can plot externally.

Each of these is cheap to add when the task-0B research surfaces a hypothesis that needs it.
