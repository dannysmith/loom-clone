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

- **Tier 1** ✅ complete (pre- and post-task-1). All 7 configs PASS on both baselines. See `test-runs/tier-1-baseline-2026-04-11.md` and `test-runs/tier-1-baseline-post-task-1-2026-04-14.md`. Task-1 output sizes dropped 2–5× (expected side-effect of the 420v default and `RealTime = false`); no stability regression.
- **Tier 2** ✅ complete — all 6 two-writer combinations PASS. See `test-runs/tier-2-baseline-2026-04-14.md`. Headline: T2.5 (ProRes 4K + HLS 1440p, no raw camera) passed clean.
- **Tier 3** ✅ complete — all 6 three-writer combinations PASS, **including T3.2 (the literal 2026-04-11 13:32 known-hang reconstruction).** See `test-runs/tier-3-baseline-2026-04-14.md`. **This is the headline finding of the task so far: failure mode 4 does not reproduce on synthetic content.** The writer shape is not the trigger. Something specific to real-capture content (`SCStream` / `AVCaptureSession` buffers) is the missing ingredient. Tier 4 is now the critical path.
- **Tier 4** — blocked on real-capture source implementation. `real-screen` / `real-camera` currently throw `unsupportedSource`. Next step in this task.
- **Tier 5** — dependent on Tier 4. No parameter sweep on synthetic can reach the failure region, so sweeps must run against whatever Tier 4 identifies as the reproducing real-capture config.

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

### Tier 1 — Single components in isolation ✅ COMPLETE (pre- and post-task-1, all 7 PASS)

All synthetic, 30 s, no real capture. Every individual writer and the compositor work on their own. See `test-runs/tier-1-baseline-post-task-1-2026-04-14.md` for the current state.

| # | Name | Post-task-1 status |
|---|---|---|
| T1.1 | ProRes 4K alone | PASS |
| T1.2 | H.264 1080p alone | PASS |
| T1.3 | H.264 1440p alone | PASS |
| T1.4 | H.264 4K alone | PASS |
| T1.5 | H.264 720p camera alone | PASS |
| T1.6 | CIContext compositor alone | PASS |
| T1.7 | AAC audio alone | PASS |

### Tier 2 — Two-writer combinations ✅ COMPLETE (all 6 PASS)

Concurrency between pairs of writers on synthetic: no combination triggers back-pressure or a wedge. See `test-runs/tier-2-baseline-2026-04-14.md`. The harness required a routing change to support dual paths faithfully (raw-prores takes raw screen, composited-hls takes compositor output); shipped as part of Tier 2 infrastructure.

| # | Name | Outcome |
|---|---|---|
| T2.1 | 2×H.264 at 1080p + 720p | PASS |
| T2.2 | 2×H.264 at 1440p + 720p | PASS |
| T2.3 | 2×H.264 at 4K + 720p | PASS |
| T2.4 | ProRes 4K + H.264 1080p HLS | PASS |
| T2.5 | ProRes 4K + H.264 1440p HLS | PASS (Phase 2b minus raw camera — important if Tier 4 confirms) |
| T2.6 | ProRes 4K + H.264 4K HLS | PASS (predicted fail) |

**Caveat across all Tier 2 (and Tier 3) synthetic results:** HLS achieved bitrates are 20–32% of configured targets because synthetic `moving` content compresses very aggressively. Real `SCStream` output has significantly more entropy and will drive the encoder harder.

### Tier 3 — Three-writer combinations ✅ COMPLETE (all 6 PASS on synthetic — failure mode 4 DID NOT reproduce)

Run one at a time via `./app/TestHarness/Scripts/run-tier-3.sh <config-name>`; the runner refuses to batch Tier 3. See `test-runs/tier-3-baseline-2026-04-14.md` for full analysis.

| # | Name | Outcome |
|---|---|---|
| T3.1 | Phase 2 1080p stable baseline | PASS |
| T3.2 | Phase 2b 1440p known-hang | **PASS** (predicted FAIL-KILLED; synthetic cannot reproduce the 2026-04-11 hang) |
| T3.3 | 1440p, ProRes at display res (1080p) | PASS |
| T3.4 | 1440p, ProRes at mid res (1440p) | PASS |
| T3.5 | 1440p without raw camera writer | PASS |
| T3.6 | 1440p with BGRA screen source (task-1 tuning 1 reverse-sweep) | PASS |

**The headline finding.** Every Tier 3 configuration passes on synthetic content, including the literal reconstruction of the configuration that hung the Mac on 2026-04-11 13:32. The writer shape is not the trigger for failure mode 4. Candidate causes pushed to Tier 4 investigation: real-capture content entropy driving the H.264 engine harder, WindowServer-owned IOSurface pool provenance for `SCStream` buffers, capture-callback concurrency pattern, `SCStream` dirty-rect metadata, display configuration state.

T3.6 note: the original Tier 5 priority 4 (420v vs BGRA) framing was stale after task-1 — T3.2 already uses 420v by default, so T3.6 reverse-sweeps to BGRA. On synthetic, BGRA was not load-bearing; that result is weak-signal because achieved H.264 bitrate stayed at ~32% of target either way.

### Tier 4 — Real capture replacement — CRITICAL PATH

Tier 3 proved synthetic cannot reproduce failure mode 4. Tier 4 is now the only route to a reproducing config, and nothing else in this task is actionable without it.

**Prerequisite: real-capture source kinds.** Currently `real-screen` / `real-camera` throw `HarnessRunnerError.unsupportedSource`.

**Implementation scope:**

- New `CapturedFrameSource` (~150 lines) wrapping `SCStream` (screen) and `AVCaptureSession` (camera). Shape mirrors `app/LoomClone/Capture/ScreenCaptureManager.swift` + `CameraCaptureManager.swift`. Standalone — do not import from the main-app target.
- Capture runs on its own dispatch queue. The latest `CMSampleBuffer` is stashed under a lock; the metronome pulls the latest per tick (do not drive the metronome off the capture callback).
- Mixed configs are supported: `source.kind` and `source.additional[].kind` can independently be synthetic or real. E.g. a Tier 4 config can declare `real-screen` + `synthetic-camera` to isolate the screen capture's contribution.

**Device selection:**

- `source.displayID` (Int, `CGDirectDisplayID`) or `source.displayName` (String, prefix-match) — optional on `real-screen`. Default: `CGMainDisplayID()`.
- `source.deviceUniqueID` (String, e.g. `"0x0000000000000000"` for a USB camera) or `source.deviceName` (prefix-match) — optional on `real-camera`. Default: `AVCaptureDevice.default(for: .video)`.
- Harness binary gets a `--list-devices` flag that enumerates available displays (`SCShareableContent.current.displays`) and video devices (`AVCaptureDevice.DiscoverySession`) so the user can copy IDs into configs without guessing.

**Permissions (TCC):**

- **Camera**: `com.apple.security.device.camera` entitlement is in place. At source setup, call `AVCaptureDevice.requestAccess(for: .video)`; if denied, exit with a clear error pointing at System Settings → Privacy → Camera. `--list-devices` hits the same permission path so it's the first place denial surfaces.
- **Audio input**: `com.apple.security.device.audio-input` entitlement is in place.
- **Screen recording**: no entitlement exists. ScreenCaptureKit triggers the system dialog on first use, but since macOS 13 the dialog can't be forced from code — if permission is absent, `SCShareableContent.current` returns an empty display list. On that, exit with a clear "grant Screen Recording permission in System Settings → Privacy & Security → Screen Recording and re-run" message. User grants it once; subsequent runs proceed silently.

**Workflow:**

1. Implement, build, commit the real-capture source before any Tier 4 configs land.
2. Run `--list-devices`, confirm the harness sees the target display and camera, note the IDs.
3. Dry-run a synthetic equivalent of the target Tier 4 config first to prove the runner still works before adding real capture as a variable.
4. Run Tier 4 one config at a time via `run-tier-3.sh`-style single-invocation (add `run-tier-4.sh` or reuse the pattern). Treat any config that touches the failure region with the same safety scaffolding as Tier 3.

**Tier 4 configs (draft — refine after real-capture lands):**

| # | Name | Config |
|---|---|---|
| T4.1 | Real-capture Phase 2 1080p | T3.1 with real `SCStream` + `AVCaptureSession`. Sanity check that real capture doesn't regress a known-stable config. |
| T4.2 | Real-capture known-hang 1440p | T3.2 with real capture. The whole point of Tier 4 — does the hang reproduce? |
| T4.3 | Real-capture T2.5 / T3.5 | ProRes 4K + HLS 1440p + compositor with real `SCStream`, no raw camera writer. If this passes and T4.2 fails, task-4 Path C (drop the raw camera writer) is evidence-backed. |
| T4.4 | Real-capture T3.3 | Real `SCStream` configured for display-points resolution, ProRes at that size. Tests task-4 Path B (reduce raw screen res). |
| T4.5 | Real-screen + synthetic-camera | T3.2 shape but camera is synthetic. If this fails and T4.2 fails, camera capture isn't the differentiator. If this passes and T4.2 fails, camera capture IS the differentiator. |

### Tier 5 — Parameter sweeps (dependent on Tier 4)

The original Tier 5 plan was "take whatever Tier 3 landed on the failure boundary and sweep tunings against it." Tier 3 landed at "nothing fails on synthetic", so Tier 5 needs Tier 4 to produce a reproducing real-capture config first. **The sweep priority list below is preserved for reference but no Tier 5 config should be written until Tier 4 has identified its anchor configuration.**

Hypotheses H1–H12 with full rationale and pass/fail criteria live in `docs/research/11-m2-pro-video-pipeline-deep-dive.md` § 7.

| Priority | Sweep | Confidence | Notes |
|---|---|---|---|
| 1 | Warm-up reorder (writers start before `SCStream.startCapture()`) vs pre-task-1 ordering — flip via top-level `warmUp` knob and by toggling the warm-up call site | **high** | H2. The preparationQueue stall the spindump shows is the exact path this avoids. |
| 2 | `AllowFrameReordering = false` (default) vs `true` on H.264 writers via the `allowFrameReordering` tuning key | **high** | H4. HLS doesn't need B-frames; measures contribution of disabling the reorder buffer. |
| 3 | `RealTime` — `false` (default) vs unset vs `true`, via the `realTime` tuning key (JSON `null` = unset, for the three-way compare) | **medium-high** | H5. OBS #5840: `RealTime = true` causes heavy framedrops on M1/M2; unset is reported as most reliable. |
| 4 | `SCStream` pixel format — `420v` (default) vs BGRA via `SCStreamConfiguration.pixelFormat`. T3.6 reverse-swept this on synthetic with no effect; Tier 4 is where it counts. | **high** | H1. `420v` cuts per-frame screen IOSurface from 4 bpp to 1.5 bpp. |
| 5 | `CVPixelBufferPool` tuning — `kCVPixelBufferPoolMaximumBufferAgeKey` 0.1 s vs 1 s default; add `kCVPixelBufferPoolAllocationThresholdKey` to fail fast on allocation pressure | **medium** | H6. New `tunings` keys needed on the writer configs. |
| 6 | Serial vs parallel writer warm-up via top-level `warmUp = "parallel"` | **medium** | H7. Composes with priority 1. Measures whether the three-encoder allocation race during the first few hundred ms is the vulnerable window. |
| 7 | `SCStreamConfiguration.queueDepth` — 3 (default) vs higher | **medium** | H8. Tier 4-only. New `tunings` key needed on `real-screen`. |
| 8 | `RequireHardwareAcceleratedVideoEncoder` enforcement — on (default) vs off | **medium** | H10. Safety-net, not a fix. Task-1 ships this as `AVVideoEncoderSpecificationKey` at the top of `outputSettings`. Readback isn't possible through `AVAssetWriter`. |

**Deferred to task-4** (not reachable through `AVAssetWriter`; see the tunings audit doc):
- `MaxFrameDelayCount` sweep — H3. `AVAssetWriter` hardcodes `3` for H.264 and rejects compression dicts on ProRes.
- `PixelBufferPoolIsShared` audit — H9. Property lives on the internal `VTCompressionSession`, not exposed.

Priorities 5 and 7 need new `tunings` keys plumbed on harness writers. Two-line edit pattern is in `app/TestHarness/README.md` § "Writer tunings".

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

From `docs/m2-pro-video-pipeline-failures.md` via `docs/research/11-…md` § 6.

| Question | Status after Tier 1/2/3 | What still needs to happen |
|---|---|---|
| Q2 — What conditions cause IOGPUFamily to deadlock? | **Partially answered.** Tier 3 eliminated writer shape alone. Remaining candidates all involve real-capture content properties. | Tier 4 must reproduce first; then Tier 5 priorities 1–3 against the reproducing config. |
| Q3 — Are there VT session properties that affect IOGPUFamily allocation? | Unanswered (nothing flipped on synthetic because nothing failed). | Tier 4 + Tier 5 priorities 1–3 (plus the `MaxFrameDelayCount` sweep once task-4 unlocks it). |
| Q5 — Is the IOSurface pool sizing strategy tunable? | Unanswered. | Tier 5 priorities 5, 7 against a Tier 4 reproducing config, with `footprint --by-category` polling. |
| Q7 — Does warm-up pre-allocate enough to avoid mid-recording stalls? | Unanswered. | Tier 5 priority 1 against a Tier 4 reproducing config + `log stream` evidence of where allocation work happens. |
| Q8 — What's the IOSurface memory footprint cliff? | Unanswered. | Every Tier 4 run + `footprint` polling. |

Q1, Q4, Q6 were answered definitively by the research doc and don't need re-answering.

## Decision framework — what to do with the results

**Pre-condition: none of the task-4 paths below can be actioned until Tier 4 produces a reproducing real-capture config.** Tier 3 passing wholesale on synthetic means the writer shape is not the trigger; any task-4 change based on synthetic data alone would be solving the wrong problem.

Once Tier 4 has a reproducing config:

- **Tier 4 T4.2 passes too** → failure mode 4 is intermittent / state-dependent (display config, thermals, specific content). Capture more state in `SystemSnapshot` and try again; may need timing-sensitive reproduction.
- **T4.4 (real-capture display-res ProRes) passes where T4.2 fails** → task-4 Path B: reduce raw screen capture resolution. Weigh quality tradeoff.
- **T4.3 (real-capture, no raw camera writer) passes where T4.2 fails** → task-4 Path C: drop the raw camera writer at 1440p+. Loses a feature; weigh against how often 1440p is actually used.
- **T4.5 (real-screen + synthetic-camera) passes where T4.2 fails** → camera capture is the differentiator. Investigate `AVCaptureSession` buffer pool and delivery pattern.
- **T4.5 fails alongside T4.2** → screen capture is the differentiator. Investigate `SCStream` buffer provenance and `SCStreamConfiguration`.
- **A Tier 5 sweep flips T4.2 failure to success** → task-4 Path A: fix identified. Best-case.
- **No single-variable Tier 5 sweep flips it** → try combined sweeps (priorities 1 + 2 + 3, or 1 + 2 + 4) before declaring 1440p unshippable.
- **No combination passes** → H11 fallback: match Cap's two-writer recipe (drop ProRes, keep two H.264 writers, compose post-recording). Known-stable in production on M-series.
- **Even H11 fails** → task-4 Path D: revert to 1080p-only.

Output of this task is concrete evidence, not hypotheses. "We ran X and it PASSED/FAILED, here's the data."

## Deliverables

1. ✅ **Fresh Tier 1 post-task-1 baseline** — `test-runs/tier-1-baseline-post-task-1-2026-04-14.md`.
2. ✅ **Tier 2 configs, runner, baseline** — `test-runs/tier-2-baseline-2026-04-14.md`.
3. ✅ **Tier 3 configs, runner, baseline** — `test-runs/tier-3-baseline-2026-04-14.md`.
4. **Tier 4 real-capture implementation + configs + baseline** — in progress. Implementation commits separately, before the Tier 4 configs.
5. **Tier 5 parameter sweep configs + summaries** — gated on Tier 4.
6. **Updates to `docs/m2-pro-video-pipeline-failures.md`** — empirical findings flow back into the "What we don't know" subsections as "What we now know" footnotes. Most valuable long-term artefact. Start updating this as Tier 4 produces data.
7. **Findings hand-off note to task-4** in `docs/tasks-todo/task-4-recording-pipeline-stabilisation.md` under "## Findings hand-off from task-2", summarising which decision-framework path task-4 should take and why. Gated on Tier 4.

## Adding new tests mid-task

If a new hypothesis surfaces mid-task, drop a JSON config into the tier directory that matches its risk level (Tier 2 for two-writer, Tier 3 for three-writer, Tier 5 for parameter sweeps). The harness is designed to make this cheap.
