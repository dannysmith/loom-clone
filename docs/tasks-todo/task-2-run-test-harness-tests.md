# Task 2 — Run Test Harness Tests

Use the isolation test harness at `app/TestHarness/` to empirically map out which AVFoundation / VideoToolbox / CIContext configurations are stable on this M2 Pro Mac and which are not. Replace speculation about the failure modes with data so that task-4 (recording pipeline stabilisation) can act on evidence, and so `docs/m2-pro-video-pipeline-failures.md` can move its "What we don't know" subsections into "What we now know" footnotes.

This is an execution task, not a coding task — with one exception: Tier 4 needs a `real-screen` / `real-camera` source implementation in the harness before it can run (see below).

## Context

Read before starting:

- **`docs/m2-pro-video-pipeline-failures.md`** — the four observed failure modes. Failure mode 4 (1440p preset, kernel-level IOGPUFamily deadlock) is the headline problem this tier plan exists to diagnose.
- **`docs/task-1-tunings-audit-2026-04-14.md`** — what just landed. Task-1 applied VideoToolbox best-practice tunings (`420v`, warm-up reorder, `RealTime = false`, `AllowFrameReordering = false`, hardware-encoder enforcement) to both the main app and the harness. Two tunings (`MaxFrameDelayCount`, `PixelBufferPoolIsShared`) were deferred to task-4 because they're not reachable through `AVAssetWriter`.
- **`app/TestHarness/README.md`** — how the harness works, tuning keys currently plumbed (`realTime`, `allowFrameReordering`, top-level `warmUp`), recovery procedure after a hang.
- **`docs/research/11-m2-pro-video-pipeline-deep-dive.md`** § 7 — falsifiable hypotheses H1–H12 behind the Tier 5 sweeps.

## Current state

- **Tier 1** has been run (pre-task-1). All 7 configs PASSED. Baseline at `test-runs/tier-1-baseline-2026-04-11.md`. First thing to do in this task is re-run it on the post-task-1 harness as a regression check and commit a fresh `tier-1-baseline-post-task-1-<date>.md`. A Tier 1 regression is a hard stop.
- **Tiers 2–5** are not populated. Configs and runner scripts land as part of this task.
- Real-capture source kinds (`real-screen`, `real-camera`) still throw `unsupportedSource` at setup — must be implemented before Tier 4.

## Hard constraints

- **Do not run a Tier 3+ configuration without `--dry-run`ing it first.** The safety scaffolding isn't a substitute for reading the config.
- **Do not batch Tier 3 runs.** The runner already stops on the first `fail-killed`; don't pass `--continue-on-fail` at Tier 3.
- **Do not modify the main LoomClone recording pipeline in this task.** Findings that suggest a main-app change get handed to task-4.
- **After any hang, follow the recovery procedure in `app/TestHarness/README.md`** — check `test-runs/_in-progress.json`, record the dangerous config, move the marker aside.

## Tiers

Each tier below lands as:

1. JSON configs under `app/TestHarness/Scripts/test-configs/tier-<N>/`.
2. A runner script `app/TestHarness/Scripts/run-tier-<N>.sh` (copy `run-tier-1.sh` and repoint it).
3. A baseline markdown summary committed to `test-runs/tier-<N>-baseline-<date>.md`.

### Tier 1 — Single components in isolation (COMPLETE pre-task-1; re-run post-task-1 as regression check)

All synthetic, 30 s, no real capture. Any failure means a single-component problem, not concurrency.

| # | Name | Config | Status |
|---|---|---|---|
| T1.1 | ProRes 4K alone | ProRes writer at 3840×2160, synthetic screen-like BGRA source. | PASS (pre-task-1) |
| T1.2 | H.264 1080p alone | H.264 writer at 1920×1080 @ 6 Mbps. | PASS |
| T1.3 | H.264 1440p alone | H.264 writer at 2560×1440 @ 10 Mbps. | PASS |
| T1.4 | H.264 4K alone | H.264 writer at 3840×2160 @ 18 Mbps. | PASS |
| T1.5 | H.264 720p camera alone | H.264 writer at 1280×720 @ 12 Mbps, synthetic YCbCr. | PASS |
| T1.6 | CIContext compositor alone | Compositor with both sources, no writers. | PASS |
| T1.7 | AAC audio alone | Audio writer, synthetic PCM. | PASS |

### Tier 2 — Two-writer combinations

Does concurrency between any pair of writers cause trouble?

| # | Name | Config |
|---|---|---|
| T2.1 | 2×H.264 at 1080p + 720p | HLS 1080p @ 6 Mbps + raw H.264 720p @ 12 Mbps. Phase 2 stable config minus ProRes. |
| T2.2 | 2×H.264 at 1440p + 720p | HLS 1440p @ 10 Mbps + raw H.264 720p @ 12 Mbps. Does 1440p HLS by itself (no ProRes, no compositor) trigger the failure? |
| T2.3 | 2×H.264 at 4K + 720p | HLS 4K @ 18 Mbps + raw H.264 720p @ 12 Mbps. Expected back-pressure (failure mode 3 analogue), not deadlock. |
| T2.4 | ProRes 4K + H.264 1080p HLS | Confirms ProRes-plus-one-H.264 base case works. |
| T2.5 | ProRes 4K + H.264 1440p HLS | **Critical.** Phase 2b minus the raw camera writer. Does removing the raw camera writer fix failure mode 4? |
| T2.6 | ProRes 4K + H.264 4K HLS | Hostile — both streams at 4K. Expected to fail. |

### Tier 3 — Three-writer combinations (the failure region)

Includes the known-hang configuration. **One at a time. Do not batch. Use the last-known-good marker.**

| # | Name | Config |
|---|---|---|
| T3.1 | Phase 2 1080p stable baseline | HLS H.264 1080p + raw H.264 720p camera + ProRes 4K screen + compositor. **Expected PASS.** |
| T3.2 | Phase 2b 1440p known-hang | HLS H.264 1440p + raw H.264 720p camera + ProRes 4K screen + compositor. **Expected FAIL-KILLED** — the 2026-04-11 13:32 hang. Watchdog should catch it. |
| T3.3 | 1440p, ProRes at display res | T3.2 but ProRes screen writer at display-points (1920×1080 from Retina) instead of native. Tests whether reducing raw screen res relieves IOGPU pressure. |
| T3.4 | 1440p, ProRes at mid res | T3.2 but ProRes screen writer at 2560×1440. Midpoint. |
| T3.5 | 1440p without raw camera writer | HLS 1440p + ProRes 4K + compositor (no raw camera). Splits H.264 engine load differently. |
| T3.6 | 1440p with 420v screen source | T3.2 but synthetic screen in 420v YCbCr instead of BGRA. Halves per-frame IOSurface. |

### Tier 4 — Real capture replacement

Verify that Tier 1–3 findings (synthetic) hold under `SCStream` + `AVCaptureSession`. Only after Tier 3 has clear results.

**Prerequisite: real-capture source kinds.** Currently `real-screen` / `real-camera` throw `HarnessRunnerError.unsupportedSource`. Before any Tier 4 config runs:

- Add a `CapturedFrameSource` wrapping `SCStream` (screen) and `AVCaptureSession` (camera), mirroring `app/LoomClone/Capture/ScreenCaptureManager.swift` + `CameraCaptureManager.swift`. Don't share code with the main app — copy ~100 lines, keep the harness standalone.
- Wire capture delegate callbacks into `HarnessRunner.runMetronome` so captured frames feed the same writer/compositor paths as synthetic frames. Capture runs on its own dispatch queue; take the latest frame per metronome tick rather than driving the metronome off capture callbacks.
- The harness bundle already has `com.apple.security.device.camera` and `com.apple.security.device.audio-input`. ScreenCaptureKit needs TCC approval on first run.
- Dry-run a synthetic equivalent of the target Tier 4 config first to prove the runner still works before adding real capture as a variable.
- Commit the real-capture implementation as its own step before any Tier 4 configs land.

| # | Name | Config |
|---|---|---|
| T4.1 | Real-capture Phase 2 1080p | T3.1 with real capture. Sanity check. |
| T4.2 | Real-capture known-hang 1440p | T3.2 with real capture. |
| T4.3 | Real-capture best-performing Tier 3 variant | Whichever Tier 3 variant looked most promising. |

### Tier 5 — Parameter sweeps

Take the most interesting configuration from Tier 3/4 and vary one tuning at a time. Because task-1 already ships the high-confidence tunings as defaults, most Tier 5 sweeps are **reverse-sweeps**: flip a default back to its pre-task-1 value and measure how much stability it was carrying. If 1440p is still hanging at the end of Tier 3, a reverse-sweep that makes a passing config fail identifies which tuning is load-bearing.

Hypotheses H1–H12 with full rationale and pass/fail criteria live in `docs/research/11-m2-pro-video-pipeline-deep-dive.md` § 7. Read the relevant hypothesis before writing a sweep config.

| Priority | Sweep | Confidence | Notes |
|---|---|---|---|
| 1 | Warm-up reorder (writers start before `SCStream.startCapture()`) vs pre-task-1 ordering — flip via top-level `warmUp` knob and by toggling the warm-up call site | **high** | H2. The preparationQueue stall the spindump shows is the exact path this avoids. |
| 2 | `AllowFrameReordering = false` (default) vs `true` on H.264 writers via the `allowFrameReordering` tuning key | **high** | H4. HLS doesn't need B-frames; measures contribution of disabling the reorder buffer. |
| 3 | `RealTime` — `false` (default) vs unset vs `true`, via the `realTime` tuning key (JSON `null` = unset, for the three-way compare) | **medium-high** | H5. OBS #5840: `RealTime = true` causes heavy framedrops on M1/M2; unset is reported as most reliable. |
| 4 | `SCStream` / synthetic-screen pixel format — `420v` (default) vs BGRA via the `synthetic-screen-bgra` source kind | **high** | H1. `420v` cuts per-frame screen IOSurface from 4 bpp to 1.5 bpp. Already covered by T3.6 synthetically — this priority extends it to real capture in Tier 4. |
| 5 | `CVPixelBufferPool` tuning — `kCVPixelBufferPoolMaximumBufferAgeKey` 0.1 s vs 1 s default; add `kCVPixelBufferPoolAllocationThresholdKey` to fail fast on allocation pressure | **medium** | H6. New `tunings` keys needed on the writer configs. |
| 6 | Serial vs parallel writer warm-up via top-level `warmUp = "parallel"` | **medium** | H7. Composes with priority 1. Measures whether the three-encoder allocation race during the first few hundred ms is the vulnerable window. |
| 7 | `SCStreamConfiguration.queueDepth` — 3 (default) vs higher | **medium** | H8. Tier 4 relevance (real capture only). New `tunings` key needed. |
| 8 | `RequireHardwareAcceleratedVideoEncoder` enforcement — on (default) vs off | **medium** | H10. Safety-net, not a fix. Task-1 ships this as `AVVideoEncoderSpecificationKey` at the top of `outputSettings`. Readback isn't possible through `AVAssetWriter`. |

**Deferred to task-4** (not reachable through `AVAssetWriter`; see the tunings audit doc):
- `MaxFrameDelayCount` sweep — H3. `AVAssetWriter` hardcodes `3` for H.264 and rejects compression dicts on ProRes.
- `PixelBufferPoolIsShared` audit — H9. Property lives on the internal `VTCompressionSession`, not exposed.

Priorities 5 and 7 need new `tunings` keys plumbed on harness writers. Two-line edit pattern is in `app/TestHarness/README.md` § "Writer tunings". The rest of the sweeps can be expressed as multiple JSON files differing in one key — the tier runner picks them up in order and stops on first fail.

### Observability to capture for Tier 3+ runs

`SystemSnapshot` already captures `vm_stat` / `ioreg -c IOSurfaceRoot` / `ps -M` / `powermetrics` before and after. For Tier 3+ and any Tier 5 config near the failure boundary, capture extra context alongside:

```bash
# IOKit snapshots to diff before/after — run alongside the harness
ioreg -rxc IOGPU
ioreg -rxc IOAccelerator
ioreg -rxc AGXAccelerator
ioreg -lw0 | grep -i -E 'IOGPU|IOAccel|IOSurface|PerformanceStatistics'

# Per-process IOSurface footprint, polled during the run
footprint --by-category $(pgrep -x WindowServer)
footprint --by-category $(pgrep LoomCloneTestHarness)

# Unified log stream — start before the config, stop after
log stream --level debug --predicate \
  'subsystem == "com.apple.coremedia" OR subsystem == "com.apple.videotoolbox" \
   OR subsystem == "com.apple.SkyLight" OR subsystem == "com.apple.iosurface" \
   OR subsystem == "com.apple.coreanimation" OR subsystem == "com.apple.GPU"' \
  > test-runs/<run-dir>/log-stream.txt
```

The log stream is the most valuable addition — it catches `IOGPUFamily` / VideoToolbox / SkyLight messages Xcode console misses when the harness runs detached. Run it in a second terminal, start before the tier runner, stop when it exits (or the Mac recovers).

**Optional but high-value:** Instruments **Metal System Trace** around one passing and one failing Tier 3 config (e.g. T3.1 passing and T3.2 failing, first ~10 s). Diffing channel utilisation between a stable and deadlocked pipeline is the only Apple-shipped way to see IOGPUFamily queue contention. Save traces under `test-runs/<run-dir>/`.

## Open research questions this task should close

From `docs/m2-pro-video-pipeline-failures.md` via `docs/research/11-…md` § 6. The tier baseline summaries should explicitly address each — don't paper over gaps.

| Question | Tier(s) that should answer it | What "answered" looks like |
|---|---|---|
| Q2 — What specific conditions cause IOGPUFamily to deadlock rather than back-pressure? | T3.1 vs T3.2; Tier 5 priorities 1–3 | One-sentence concrete trigger, e.g. "three concurrent VTCompressionSessions racing on first-frame IOSurface allocation." |
| Q3 — Are there VT session properties that affect IOGPUFamily allocation? | Tier 5 priorities 1–3 (plus the `MaxFrameDelayCount` sweep once task-4 unlocks it) | Yes/no per property, with the sweep that showed the effect. |
| Q5 — Is the IOSurface pool sizing strategy tunable? | Tier 5 priorities 5, 7 | Whether age/threshold/queueDepth changed peak `footprint` and whether it affected the hang. |
| Q7 — Does warm-up pre-allocate IOSurface enough to avoid mid-recording stalls? | Tier 5 priority 1 | Whether the warmed-up variant passes where the non-warmed one fails, plus `log stream` evidence of where the allocation work happens. |
| Q8 — What's the IOSurface memory footprint cliff? | Every Tier 3 run + `footprint` polling | Rough MB budget (process + WindowServer) at which the hang reproduces vs stays stable. |

Q1, Q4, Q6 were answered definitively by the research doc and don't need re-answering.

## Decision framework — what to do with the results

- **T3.1 passes and T3.2 fails as expected** → harness works, failure is reproducible in isolation. Good baseline.
- **T3.3 (display-res ProRes) passes** → task-4 Path B: reduce raw screen capture resolution. Weigh quality tradeoff.
- **T3.5 (no raw camera) passes** → task-4 Path C: drop the raw camera writer at 1440p+. Loses a feature.
- **T3.6 (420v screen source) passes** → task-4 Path A with a small `SCStreamConfiguration` change. Best-case.
- **A Tier 5 sweep flips failure to success** → task-4 Path A: we've identified a fix *and* learned something. Most desirable.
- **No single-variable Tier 5 sweep flips the config** → try combined sweeps (priorities 1 + 2 + 3, or 1 + 2 + 4) before declaring 1440p unshippable. Production apps apply multiple tunings at once; single-variable sweeps may miss combined effects.
- **No combination passes** → H11 fallback: match Cap's two-writer recipe (drop ProRes, keep two H.264 writers, compose post-recording). Known-stable in production on M-series.
- **Even H11 fails** → task-4 Path D: revert to 1080p-only.

Output of this task is concrete evidence, not hypotheses. "We ran X and it PASSED/FAILED, here's the data."

## Deliverables

1. **Fresh Tier 1 post-task-1 baseline** committed to `test-runs/tier-1-baseline-post-task-1-<date>.md`. Regression check that task-1's changes didn't break anything.
2. **Tier 2 configs, runner script, baseline summary** at `test-runs/tier-2-baseline-<date>.md`.
3. **Tier 3 configs, runner script, baseline summary**, one at a time per the safety constraints. T3.2 is the single most important data point — it's the reference everything else is compared against.
4. **Tier 4 real-capture implementation + configs + baseline** (implementation commits separately, before the Tier 4 configs).
5. **Tier 5 parameter sweep configs + summaries** for whichever subset is reachable given Tier 3 results.
6. **Updates to `docs/m2-pro-video-pipeline-failures.md`** — empirical findings flow back into the "What we don't know" subsections as "What we now know" footnotes. This is the most valuable long-term artefact.
7. **Findings hand-off note to task-4** in `docs/tasks-todo/task-4-recording-pipeline-stabilisation.md` under "## Findings hand-off from task-2", summarising which decision-framework path task-4 should take and why.

## Adding new tests mid-task

If a new hypothesis surfaces mid-task, drop a JSON config into the tier directory that matches its risk level (Tier 2 for two-writer, Tier 3 for three-writer, Tier 5 for parameter sweeps). The harness is designed to make this cheap.
