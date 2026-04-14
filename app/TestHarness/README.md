# LoomCloneTestHarness

A diagnostic instrument for probing `AVFoundation` / `VideoToolbox` / `CIContext` / `ScreenCaptureKit` configurations in isolation, without having to exercise them through the real recording pipeline.

It exists because this project targets Apple Silicon Pro-class chips (single H.264 engine, separate ProRes engine, shared IOGPUFamily kernel arbiter) where the wrong combination of concurrent writers, resolutions, or `VTCompressionSession` tunings can cause a kernel-level GPU wedge that hard-locks the Mac. Iterating on those configurations inside the main app means hanging the developer's machine and hard-rebooting every time something goes wrong. The harness lets us vary **one knob at a time** in a process that is safer, more observable, and more reproducible than the real app. See `docs/m2-pro-video-pipeline-failures.md` for the institutional memory of failure modes this tool is meant to help diagnose.

This is **not** a shippable part of LoomClone. It is a second Xcode target (`LoomCloneTestHarness`) in the same project so it can share code-signing infrastructure and entitlements, but it does not depend on any actor / UI code from the main app, and the main recording pipeline is never modified as a result of running it.

## When to use it

- You have a hypothesis about which combination of writers / resolutions / tuning knobs is failing, and you want to verify it without touching the main app.
- You're about to change the main recording pipeline and want to validate the change on synthetic input first.
- You're sweeping a `VTCompressionSession` / `CVPixelBufferPool` / `SCStreamConfiguration` property across a range of values and want machine-parseable pass/fail output.
- You've hit a new failure mode and want to bisect the minimal reproducer.

## Active limitations (2026-04-14)

**Real-capture screen (`real-screen` source) does not work reliably** when writers are attached. Symptom: `SCStream`'s delegate fires at the expected ~30 fps when the harness has no writers, but collapses to ~0.4 fps as soon as any writer is attached — regardless of writer kind, resolution, or whether we skip feeding duplicates. Three independent fixes were attempted (retain `CMSampleBuffer` rather than `CVPixelBuffer`; dedup writer feeds on a source-generation counter; tie the compositor+HLS path to real screen rate); none changed the delivery rate. Root cause not isolated.

Consequence: **Tier 4 real-capture tests cannot be trusted to exercise the real capture path.** T4.0 (screen-only, no writers) works correctly and is useful for verifying capture permissions and display selection. T4.1–T4.5 currently produce output files whose "screen" content is mostly a frozen initial frame; their pass/fail outcomes are not diagnostic. Do not use their results to make decisions about the main-app pipeline.

Real-capture camera (`real-camera` source / `AVCaptureSession`) appears to work correctly.

If you return to this: start by reading `docs/m2-pro-video-pipeline-failures.md` — there's a summary of the harness work and what we still don't know. Then build a bisection suite (one writer at a time, with vs without compositor, with vs without `startWriting()`, etc) before attempting another fix.

## How it works

One run = one JSON config in, one `result.json` out, plus a directory of supporting artefacts. The harness is deliberately linear — no retries, no UI, no interactive state machine. Everything interesting is in the config or in the run directory.

```
┌────────────┐    ┌──────────────┐    ┌──────────────┐    ┌────────────┐
│ HarnessCon─│ →  │ HarnessRun─  │ →  │ Sources      │ →  │ Writers    │
│ fig (JSON) │    │ ner          │    │ (synthetic / │    │ (HLS /     │
└────────────┘    │              │    │  real)       │    │  H.264 /   │
                  │  metronome   │    └──────┬───────┘    │  ProRes /  │
                  │              │           ↓            │  audio)    │
                  │              │    ┌──────────────┐    └──────┬─────┘
                  │              │    │ HarnessCom─  │           ↓
                  │              │    │ positor      │    ┌────────────┐
                  │              │    │ (CIContext,  │    │ result.    │
                  │              │    │  optional)   │    │ json +     │
                  │              │    └──────────────┘    │ events.    │
                  │              │                        │ jsonl +    │
                  │              │                        │ snapshots  │
                  └──────┬───────┘                        └────────────┘
                         │
                         ↓
                  ┌────────────┐
                  │ Watchdog + │
                  │ in─progress│
                  │ marker     │
                  └────────────┘
```

Key components:

- **`HarnessConfig`** — flat `Codable` JSON schema describing the writers to instantiate, source(s) to drive, optional compositor, duration, and per-writer tuning knobs. Written to `config.json` in the run directory so every run is byte-exact reproducible.
- **`HarnessRunner`** — orchestrates a single run. Writes the pre-run system snapshot, arms the watchdog, builds sources + compositor + writers, drives a metronome that produces frames and feeds them into the writers, stops the writers, writes the post-run snapshot, computes the pass/fail outcome, and writes `result.json`.
- **`SyntheticFrameSource`** — produces `CVPixelBuffer` / `CMSampleBuffer` frames without touching any capture API. Supports BGRA (screen-like), 420v YCbCr (camera-like), and silent PCM audio. Uses `memset_pattern4` for fast in-place fills so even 4K synthetic content keeps up with a 30 fps metronome. Synthetic frames are the default because they remove the capture layer as a confounding variable — if a test fails with synthetic frames, the capture layer is not the cause.
- **Writers** — minimal analogues of the main-app `WriterActor` / `RawStreamWriter`: composited HLS (H.264 + AVAssetWriter HLS profile with a segment-capture delegate), raw H.264 `.mp4`, raw ProRes 422 Proxy `.mov`, raw AAC `.m4a`. Each is independently enable/disable-able and has a `tunings` dict for sweeping `AVAssetWriterInput` / `VTCompressionSession` properties.
- **`HarnessCompositor`** — optional `CIContext`-based compositor that reads one or two input `CIImage`s and renders a composited output into the composited HLS writer's input. Supports both `ciContext.render(..., to:bounds:)` and `ciContext.startTask(toRender:to:)` paths, the Lanczos-scaling toggle, and the PiP circle-mask camera overlay.
- **Observability** — `EventLog` (JSONL, thread-safe), `SystemSnapshot` (`vm_stat` / `ioreg -c IOSurfaceRoot` / `ps -M` / `powermetrics` captured before and after the run), `WatchdogTimer` (pthread-based hard kill-switch), and `InProgressMarker` (`test-runs/_in-progress.json` written pre-run, deleted on clean completion).
- **Outcome classifier** — `pass` / `degraded` / `fail-recorded` / `fail-killed` based on writer final status, the presence of GPU errors or dropped frames, HLS segment cadence stability, and whether the watchdog fired.

The runner script (`Scripts/run-tier-<N>.sh`) is a shell wrapper that runs a whole tier of configs in order, dry-runs each one first, and stops on the first killed or recorded failure.

## Test tier convention

Configs live under `Scripts/test-configs/tier-<N>/` and runner scripts at `Scripts/run-tier-<N>.sh`. Tiers are grouped by risk and purpose rather than subject matter:

| Tier | Purpose |
|---|---|
| **Tier 1** | Single-component isolation. One writer at a time, synthetic sources only. Any failure here means a fundamental single-writer bug, not concurrency. |
| **Tier 2** | Two-writer combinations, synthetic sources. Finds issues that emerge from concurrent writers but stops short of the known-hang region. |
| **Tier 3** | Three-writer combinations, including configurations known to trigger kernel wedges on the target hardware. Synthetic sources. Run one config at a time, never batched — the last-known-good marker is designed for this tier. |
| **Tier 4** | Real-capture replacement. Takes selected configs from earlier tiers and runs them again with `SCStream` + `AVCaptureSession` instead of synthetic sources, to check whether findings from synthetic runs survive the real capture layer. |
| **Tier 5** | Parameter sweeps. Takes one configuration and varies a single `VTCompressionSession` / `CVPixelBufferPool` / `SCStreamConfiguration` property across a range of values. Automation pays off here — an overnight sweep of 20 configs is much more efficient than manual testing. |

Not every tier is populated at any given time — treat the list as the scheme, not an inventory. What exists is whatever is in `Scripts/test-configs/` and `Scripts/run-tier-*.sh` right now.

## Build

```
cd app
xcodebuild -project LoomClone.xcodeproj -target LoomCloneTestHarness -configuration Debug build
```

This produces `app/build/Debug/LoomCloneTestHarness.app`. The binary inside is what the runner scripts execute directly (`open -a` works too, but loses stdout capture).

Whenever `project.yml` changes you need to regenerate the xcodeproj:

```
cd app && xcodegen generate
```

## Enumerate displays and cameras (`--list-devices`)

Before using any `real-screen` / `real-camera` source, run:

```
./app/build/Debug/LoomCloneTestHarness.app/Contents/MacOS/LoomCloneTestHarness --list-devices
```

This enumerates available `SCDisplay`s (with `displayID`, `localizedName`, points-size, pixel-size) and `AVCaptureDevice`s (with `uniqueID`, `localizedName`, best ≥30 fps format, first few declared formats including frame-rate ranges). It also triggers the TCC permission paths:

- **Camera**: calls `AVCaptureDevice.requestAccess(for: .video)` → macOS prompts on first run; denial prints an actionable message pointing at System Settings → Privacy & Security → Camera.
- **Screen recording**: calls `SCShareableContent.current`. macOS cannot prompt for screen recording from code post-macOS 13 — if permission is missing, the displays list comes back empty (or throws) and the output tells you to enable the harness in System Settings → Privacy & Security → Screen & System Audio Recording.

Copy the IDs you want into the `source.displayID` / `source.deviceUniqueID` fields of your config. Name-based alternatives (`source.displayName` / `source.deviceName`, prefix match) are also supported.

## Run a single config

```
./app/build/Debug/LoomCloneTestHarness.app/Contents/MacOS/LoomCloneTestHarness \
    --config app/TestHarness/Scripts/test-configs/tier-1/T1.1-prores-4k-alone.json
```

Exit codes:

| code | meaning |
|---|---|
| 0 | PASS |
| 20 | DEGRADED — completed but one or more soft-fail conditions tripped |
| 30 | FAIL (recorded) — a writer failed or output is missing |
| 40 | FAIL (killed) — watchdog fired, this config is probably dangerous |
| 2 | argv / config-file error |
| 1 | other |

## Dry-run a config

Dry-run validates the config, prints what the harness WOULD do, and exits without touching any `AVFoundation` entry point. **Always dry-run a new config before running it for real**, especially anything that touches the known-hang region of the configuration space:

```
./app/build/Debug/LoomCloneTestHarness.app/Contents/MacOS/LoomCloneTestHarness \
    --config path/to/config.json \
    --dry-run
```

## Run a whole tier

```
./app/TestHarness/Scripts/run-tier-1.sh
```

The runner script:

1. Refuses to start if `test-runs/_in-progress.json` exists (see "Recovery after a hang" below).
2. Dry-runs every config first.
3. Runs each config in order, stopping on the first `fail-recorded` or `fail-killed` result unless `--continue-on-fail` is passed.
4. Writes a summary at the end.

The runner can also be invoked with `--dry-run-only` to exercise the flow without running the real tests.

## Run a single Tier 3 / Tier 4 config (one at a time)

Tiers 3 and 4 include configurations that may wedge the Mac, so their runner scripts refuse to batch — each invocation runs exactly one config:

```
./app/TestHarness/Scripts/run-tier-3.sh T3.1
./app/TestHarness/Scripts/run-tier-3.sh T3.2-phase-2b-1440p-known-hang
./app/TestHarness/Scripts/run-tier-3.sh --dry-run T3.2
./app/TestHarness/Scripts/run-tier-3.sh --list
```

The name argument prefix-matches against filenames in `test-configs/tier-N/`. On a `FAIL-KILLED` result the script prints the recovery procedure instead of offering a retry.

## Run outputs

Each run writes a fresh directory to `test-runs/<timestamp>-<config-name>/`:

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

The `test-runs/` directory itself is tracked (via `.gitkeep`) but its contents are gitignored except for aggregate `*.md` summaries — individual run directories are large and machine-specific. If you want to record findings across a tier run, commit a markdown summary alongside the run dirs.

### What each file is

- **`config.json`** — byte-identical copy of the JSON the runner consumed. Start from this when reproducing a failure.
- **`events.jsonl`** — one line per structured event. Grep- and jq-friendly. Notable event kinds: `writer.failed-before-finish`, `writer.dropped`, `writer.segment`, `metronome.no-buffer`, `compositor.render-error`, `compositor.pool-exhausted`, `watchdog.armed`.
- **`result.json`** — the machine-readable outcome. `outcome` field is `"pass"` / `"degraded"` / `"fail-recorded"` / `"fail-killed"`. `issues` lists soft-fail reasons. `writers[]` has per-writer final status, error description, output bytes, and (for HLS) the array of observed segment durations.
- **`system-snapshot-{start,end}.txt`** — `uname`, `sw_vers`, `sysctl hw.*`, `vm_stat`, `ps -M`, `ioreg -c IOSurfaceRoot -l` (truncated), `powermetrics` (requires root, otherwise just records the denial). Diff `start` vs `end` to see what changed over the run.
- **`outputs/`** — the actual writer output files. Useful to open in QuickTime or `ffprobe` to confirm the files are well-formed.

## Safety model

The harness will, by design, eventually be asked to run configurations that trigger a hang. Three independent safeguards stand between that config and an unrecoverable Mac:

1. **Wall-clock watchdog.** Every run is armed with a `pthread`-based timer that fires `duration + watchdogGraceSeconds` after the run starts. On fire it prints a diagnostic line and calls `exit(40)`. The watchdog thread is separated from the Swift concurrency runtime so it stays armed even if the main pipeline is wedged. This does not rescue us from a true kernel-level hang (if the kernel is stuck, no userspace code runs), but it catches every "userspace stall with a stuck thread" case.
2. **Last-known-good marker.** Before starting, the harness writes `test-runs/_in-progress.json` containing the test name and full config. On clean completion it deletes the file. If the Mac hangs and has to be hard-rebooted, the file survives — the runner script on next invocation refuses to start until the marker is acknowledged.
3. **Dry-run mode.** `--dry-run` validates a config and prints what the harness would do, without calling any `AVFoundation` entry point. This is the first thing any new config should be run with.

The runner script layers onto these by running tier configs in order, stopping on the first `fail-killed` or `fail-recorded` by default, and refusing to start in the presence of a marker.

## Recovery after a hang

If a config triggers a kernel-level wedge and forces a hard reboot:

1. Reboot and log back in.
2. **Do not run any tier script yet.**
3. Check `test-runs/_in-progress.json`. It will exist, and it will contain the name and full config of the test that hung. Read it.
4. Write the dangerous config's name down somewhere durable so you don't accidentally run it again.
5. Move the marker aside as a historical record (don't delete it):
   ```
   mv test-runs/_in-progress.json test-runs/_last-hang-YYYY-MM-DD.json
   ```
6. Record the new failure mode in `docs/m2-pro-video-pipeline-failures.md` if it's not already documented.
7. You can now run tier scripts again.

If the marker is missing after a hang you thought happened, either the harness finished cleanly (check the latest run directory) or the marker was somehow lost — either way, investigate before assuming it's safe to proceed.

## Writing a new test config

Test configs are flat JSON. The minimum shape is:

```json
{
  "name": "T1.1-prores-4k-alone",
  "tier": "tier-1",
  "durationSeconds": 30,
  "watchdogGraceSeconds": 10,
  "frameRate": 30,
  "source": {
    "kind": "synthetic-screen",
    "width": 3840,
    "height": 2160,
    "pattern": "moving",
    "colorSpace": "srgb"
  },
  "writers": [
    {
      "kind": "raw-prores",
      "name": "screen",
      "width": 3840,
      "height": 2160
    }
  ]
}
```

Fields:

- `name` — unique identifier shown in events, result, and the run directory name. Follow the `T<tier>.<index>-<slug>` convention for tier configs.
- `tier` — label used by the runner script to group configs (purely informational to the harness itself).
- `durationSeconds` — how long the metronome runs. The watchdog fires at `durationSeconds + watchdogGraceSeconds`.
- `frameRate` — metronome tick rate. Defaults to 30.
- `warmUp` — writer warm-up strategy. `"serial"` (default) runs each writer's `startWriting()` sequentially, matching the main app's `prepareRecording()` ordering after task-1 tuning 2. `"parallel"` kicks every writer off at the same time via a `TaskGroup` — only useful for Tier 5 priority 7 (serialised-vs-parallel warm-up sweep).
- `source.kind` — one of `synthetic-screen` (420v YCbCr, matches the main-app `SCStream` pixel path), `synthetic-screen-bgra` (32BGRA, for the explicit BGRA exception case), `synthetic-camera` (420v YCbCr), `synthetic-audio` (silent PCM), `real-screen` (ScreenCaptureKit), `real-camera` (AVCaptureSession). A single source can declare `additional` sub-sources for tests that need both a screen and camera feed.
- `source.pattern` — `solid`, `gradient`, `moving`, or `noise`. `moving` is the default because static content compresses to almost nothing and doesn't stress the encoder realistically.
- `source.colorSpace` — `srgb` (display default), `p3` (wide-gamut display), `rec709` (camera default). Controls the attachment tags on synthetic pixel buffers so downstream writers see the same input shape they would in production.
- `compositor` — optional. When present, the compositor receives the source frames and its output feeds the composited HLS writer. Fields: `outputWidth`, `outputHeight`, `includeCameraOverlay`, `useLanczosScaling`, `renderMode` (`render-to-bounds` or `start-task`).
- `writers[]` — each writer is configured by `kind` (`composited-hls`, `raw-h264`, `raw-prores`, `raw-audio`), a unique `name`, dimensions, bitrate, and an optional `tunings` dict.
- `expected` — informational, not enforced: `"pass"` / `"degraded"` / `"fail"` / `"fail-killed"` / `"unknown"`.

> ⚠️ **Camera-writer naming gotcha.** The runner routes frames to a raw-h264 writer whose `name` contains the substring `"camera"` (case-insensitive) from the camera source, not from the screen source. This keeps test configs flat but it means a writer named e.g. `"screen-camera-overlay"` will silently receive camera frames instead of screen frames. If you have a non-camera raw-h264 writer, keep the word "camera" out of its name. If you have a camera writer, put "camera" in its name.

When creating a config:

1. Drop it under `Scripts/test-configs/tier-<N>/` with a `T<N>.<X>-<slug>.json` filename so the runner picks it up in order.
2. `--dry-run` it first.
3. If it's in a known-safe tier, run it directly or via the tier runner.
4. If it's in a tier known to approach the failure region, verify the safety scaffolding is behaving (marker, watchdog deadline) before running it for real — and run it by itself, not batched.

## Writer tunings

Writer tunings are supplied as a `tunings` dict on the writer config. Currently-supported keys:

| writer kind | key | type |
|---|---|---|
| `raw-h264` | `averageBitRate` | int (bits/sec) |
| `raw-h264` | `expectedFrameRate` | int |
| `raw-h264` | `maxKeyFrameIntervalDuration` | int (seconds) |
| `raw-h264`, `composited-hls` | `realTime` | bool — default `false` (matches task-1 tuning 3 after OBS #5840); `true` sets `kVTCompressionPropertyKey_RealTime = true`; JSON `null` leaves the property unset entirely (for comparison against the documented "unknown" default) |
| `raw-h264`, `composited-hls` | `allowFrameReordering` | bool — default `false` (matches task-1 tuning 4, disables B-frames); `true` re-enables the encoder's B-frame reorder buffer for a controlled comparison |
| `composited-hls` | `declareRec709Output` | bool — default `true`; set to `false` to test what happens without `AVVideoColorPropertiesKey` on the writer output |

Adding a new tuning knob is a two-line edit to the relevant writer's `configure()` method: read the key from `tunings` and apply it to the `AVAssetWriterInput` / `VTCompressionSession` properties. Keep the mapping explicit — don't pass the dict through opaquely.

## What this harness is NOT

- It is not a production recording pipeline. It is allowed to be messier, simpler, and more directly coupled than the main app's actors.
- It is not a UI-driven app. There is no window, no settings panel, no live preview. Everything is driven from config files on disk.
- It is not a performance benchmark or quality comparison tool. It measures whether a configuration is stable and what it produces, not whether one configuration is "better" than another.
- It does not reproduce the main app's pause / resume / mode-switch machinery. One config, one run, no in-flight reconfiguration.
- It does not, out of the box, tail `os_log` / `log stream` for `kIOGPUCommandBufferCallback*` messages. Those show up in the Xcode console when the harness is run attached to a debugger.

## Layout

```
app/TestHarness/
├── README.md
├── Info.plist
├── TestHarness.entitlements
├── TestHarnessMain.swift         // @main, argv, AppKit entry
├── HarnessConfig.swift           // Codable config schema
├── HarnessResult.swift           // Codable result schema
├── HarnessDryRun.swift           // --dry-run printer
├── HarnessRunner.swift           // per-run orchestrator + metronome
├── Sources/
│   └── SyntheticFrameSource.swift
├── Compositor/
│   └── HarnessCompositor.swift
├── Writers/
│   ├── HarnessWriter.swift              // common protocol
│   ├── HarnessCompositedHLSWriter.swift
│   ├── HarnessRawH264Writer.swift
│   ├── HarnessRawProResWriter.swift
│   └── HarnessRawAudioWriter.swift
├── Observability/
│   ├── EventLog.swift
│   ├── SystemSnapshot.swift
│   ├── WatchdogTimer.swift
│   └── InProgressMarker.swift
└── Scripts/
    ├── run-tier-1.sh
    ├── run-tier-2.sh             // if present
    ├── ...
    └── test-configs/
        ├── tier-1/
        │   └── *.json
        ├── tier-2/
        └── ...
```

Run outputs land at the repo root under `test-runs/` so they're out of the way of the app target and easy to clean up.
