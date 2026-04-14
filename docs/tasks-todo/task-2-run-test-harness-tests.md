# Task 2 — Run Test Harness Tests

Use the isolation test harness at `app/TestHarness/` to empirically map out which AVFoundation / VideoToolbox / CIContext configurations are stable on this M2 Pro Mac and which are not. The goal is to replace speculation about the failure modes with data, so that task-4 (recording pipeline stabilisation) can resolve the main-branch Phase 2b situation with evidence instead of guesses, and so that `docs/m2-pro-video-pipeline-failures.md` can be updated from "what we don't know" to "what we now know" footnotes.

This is an execution task, not a coding task. The harness already exists and is working — this task runs tests in it and records what happens.

## Dependencies

This task **depends on task-1 (VideoToolbox best-practice tunings)** having landed first. Task-1 applied the high-confidence tunings that could be expressed through `AVAssetWriter` — `420v` pixel format, `PrepareToEncodeFrames` warm-up (via re-ordered `startWriting()` calls), `RealTime = false`, `AllowFrameReordering = false`, and `RequireHardwareAcceleratedVideoEncoder = true` — to **both** the main-app recording pipeline and the harness writers. Two of the seven tunings (`MaxFrameDelayCount` bounded, `PixelBufferPoolIsShared` audit) turned out to be unreachable through `AVAssetWriter` and were deferred to task-4's shape-change work; see the reshaped Tier 5 priority table below and `docs/task-1-tunings-audit-2026-04-14.md` for the full story. Running this task against a harness whose writers are still on default settings would mean Tier 5 parameter sweeps vary one knob against an unaudited baseline — the results would be contaminated and hard to attribute.

If task-1 has not yet landed by the time this task starts, stop and finish task-1 first. The rare exception is Tier 2 two-writer tests against the pre-task-1 harness, which are useful as a regression check that task-1 didn't break anything — but any Tier 3+ work must wait for the best-practice baseline.

## Context

Before starting, read:

- `docs/m2-pro-video-pipeline-failures.md` — institutional memory of the four failure modes observed to date. Failure mode 4 (the 1440p-preset kernel-level IOGPUFamily deadlock, 2026-04-11 13:32) is the headline problem this test plan exists to diagnose.
- `app/TestHarness/README.md` — how the harness works, how to build it, how to run a single config or a whole tier, how to recover after a hang, and how to write a new test config.
- `docs/research/11-m2-pro-video-pipeline-deep-dive.md` — deeper research into IOGPUFamily behaviour, VideoToolbox tuning knobs, and how comparable apps handle concurrent hardware video sessions on Apple Silicon. Produces the concrete hypotheses that feed into Tier 5 parameter sweeps.
- `docs/tasks-todo/task-1-videotoolbox-best-practice-tunings.md` — the upstream task whose tunings this task is validating empirically. The Tier 5 priority list here depends on the audit/implementation notes task-1 produced — read those before writing Tier 5 configs so you know which knobs are already on best-practice defaults and which are new `tunings` keys added during task-1.
- `docs/tasks-todo/task-4-recording-pipeline-stabilisation.md` — the task this execution work unblocks. Don't modify the main app's pipeline as part of this task; findings get written up and handed back to task-4.

## Current state

- **Tier 1 has been run** (2026-04-11). All 7 configs PASSED on the dev M2 Pro. Baseline recorded at `test-runs/tier-1-baseline-2026-04-11.md`. This already tells us that the 1440p preset and 4K H.264 work fine in isolation — failure modes 3 and 4 are specifically about concurrent sessions, not the absolute resolution of any individual writer.
- **Task-1 (best-practice tunings) is expected to have updated the harness writers** to reflect best practice. Before starting Tier 2 here, re-run `./app/TestHarness/Scripts/run-tier-1.sh` to confirm all 7 Tier 1 configs still PASS on the post-task-1 harness. Commit a fresh `test-runs/tier-1-baseline-post-task-1-<date>.md` if anything changed — a Tier 1 regression from task-1 is a hard stop and needs to be resolved before continuing.
- Tiers 2–5 are not yet populated. Configs and runner scripts land as part of this task.

## Hard constraints

- **Do not run a Tier 3+ configuration without dry-running it first.** The safety scaffolding (watchdog, last-known-good marker) is not a substitute for reading the config. Every new Tier 3+ config gets `--dry-run`'d before it's run for real, and gets run alone, not batched with other Tier 3 configs.
- **Do not batch Tier 3 runs.** The runner script already stops on the first `fail-killed` result; do not pass `--continue-on-fail` to it for Tier 3.
- **Do not modify the main LoomClone recording pipeline as part of this task.** If a finding suggests a main-app change, write it up and hand it back to task-4 (not task-1 — task-1 is the best-practice tunings and by the time this task runs it should already be complete).
- **After any hang, follow the recovery procedure in `app/TestHarness/README.md` before running anything else.** In particular, check for `test-runs/_in-progress.json`, record the dangerous config somewhere durable, and move the marker aside (don't delete it).

## Test plan

Each tier listed below should have:
1. One JSON config file per test under `app/TestHarness/Scripts/test-configs/tier-<N>/`.
2. A runner script at `app/TestHarness/Scripts/run-tier-<N>.sh` (can be a copy of `run-tier-1.sh` pointed at a different config directory).
3. A tier baseline markdown summary committed to `test-runs/tier-<N>-baseline-<date>.md` after the tier is run.

### Tier 1 — Baseline components in isolation (COMPLETE)

Goal: prove each component works on its own before combining them. Any Tier 1 failure means a fundamental single-component problem that's not about concurrency.

All Tier 1 tests use synthetic frames, 30-second duration, no real capture.

| # | Name | Config | Status |
|---|---|---|---|
| T1.1 | ProRes 4K alone | ProRes writer at 3840×2160, synthetic screen-like BGRA source. | **PASS** |
| T1.2 | H.264 1080p alone | H.264 writer at 1920×1080 @ 6 Mbps, synthetic BGRA source. | **PASS** |
| T1.3 | H.264 1440p alone | H.264 writer at 2560×1440 @ 10 Mbps, synthetic BGRA source. | **PASS** |
| T1.4 | H.264 4K alone | H.264 writer at 3840×2160 @ 18 Mbps, synthetic BGRA source. | **PASS** |
| T1.5 | H.264 720p camera alone | H.264 writer at 1280×720 @ 12 Mbps, synthetic YCbCr source. | **PASS** |
| T1.6 | CIContext compositor alone | Compositor with both sources, no writers attached. | **PASS** |
| T1.7 | AAC audio alone | Audio writer, synthetic PCM source. | **PASS** |

### Tier 2 — Two-writer combinations

Goal: find out if two simultaneous writers cause any observable issues. If these all pass, single-writer concurrency isn't the trigger.

All Tier 2 tests use synthetic frames, 30-second duration.

| # | Name | Config |
|---|---|---|
| T2.1 | 2×H.264 at 1080p + 720p | HLS 1080p @ 6 Mbps + raw H.264 720p @ 12 Mbps. Matches the Phase 2 stable config minus ProRes. |
| T2.2 | 2×H.264 at 1440p + 720p | HLS 1440p @ 10 Mbps + raw H.264 720p @ 12 Mbps. Does 1440p HLS by itself (no ProRes, no compositor) trigger the failure? |
| T2.3 | 2×H.264 at 4K + 720p | HLS 4K @ 18 Mbps + raw H.264 720p @ 12 Mbps. Expected to back-pressure (failure mode 3 analogue) but not deadlock. |
| T2.4 | ProRes 4K + H.264 1080p HLS | Confirms the ProRes-plus-one-H.264 base case works. |
| T2.5 | ProRes 4K + H.264 1440p HLS | **Critical.** "Like Phase 2b but without the raw camera writer." Does removing the raw camera writer fix failure mode 4, or is it still triggered? |
| T2.6 | ProRes 4K + H.264 4K HLS | Hostile configuration — both streams at 4K. Expected to fail. |

### Tier 3 — Three-writer combinations (the failure region)

Goal: find the exact tipping point. Includes the known-hang configuration from failure mode 4. **Run Tier 3 tests one at a time. Do not batch them. Use the last-known-good marker.**

| # | Name | Config |
|---|---|---|
| T3.1 | Phase 2 1080p stable baseline | HLS H.264 1080p @ 6 Mbps + raw H.264 720p camera + ProRes 4K screen + compositor. **Expected to PASS** (reproduces the proven-stable Stage 2 config). |
| T3.2 | Phase 2b 1440p known-hang | HLS H.264 1440p @ 10 Mbps + raw H.264 720p camera + ProRes 4K screen + compositor. **Expected to FAIL (killed)** — this is the configuration that hung the Mac on 2026-04-11 at 13:32. The watchdog should catch it. |
| T3.3 | 1440p with ProRes at display res | Same as T3.2 but ProRes screen writer at display-points resolution (1920×1080 from a Retina display) instead of native 3840×2160. Tests the hypothesis that reducing raw screen resolution relieves IOGPU pressure. |
| T3.4 | 1440p with ProRes at mid res | Same as T3.2 but ProRes screen writer at 2560×1440 (same as the HLS output). Midpoint between native and display-points. |
| T3.5 | 1440p without raw camera writer | HLS H.264 1440p + ProRes 4K screen + compositor (no raw camera writer). Does removing one H.264 session avoid failure mode 4? This is the "what if we split the 2 H.264 engine load differently" test. |
| T3.6 | 1440p with BGRA→420v screen | Like T3.2 but synthetic screen source delivers 420v YCbCr instead of BGRA. Reduces per-frame IOSurface by half. |

### Tier 4 — Real capture replacement

Goal: verify that findings from Tiers 1–3 (which use synthetic frames) hold up when `ScreenCaptureKit` and `AVCaptureSession` are in the pipeline. Run the most interesting Tier 3 configs again with real capture.

Only run Tier 4 after Tier 3 has produced clear results.

**Prerequisite: implement real-capture source kinds.** The harness's `real-screen` and `real-camera` source kinds currently throw `HarnessRunnerError.unsupportedSource` at setup time — Tier 1–3 only needed synthetic frames so the real-capture path was left unimplemented. Before any Tier 4 test can run, this has to land:

- Add a `CapturedFrameSource` (or equivalent) that wraps `SCStream` for screen and `AVCaptureSession` for camera, mirroring `app/LoomClone/Capture/ScreenCaptureManager.swift` and `CameraCaptureManager.swift`. Don't share code with the main app — the harness is intentionally standalone, and copying ~100 lines is cheaper than cross-target coupling.
- Wire the capture delegate callbacks into `HarnessRunner.runMetronome` so captured frames feed the same writer / compositor paths that synthetic frames do. The capture layer runs on its own dispatch queue — take the latest frame per metronome tick rather than trying to drive the metronome off the capture callback.
- Remember the harness app bundle already has `com.apple.security.device.camera` and `com.apple.security.device.audio-input` entitlements. Screen capture doesn't need an entitlement but does need TCC approval on first run — the harness will get the standard system prompt, accept it and re-run.
- Dry-run a synthetic version of the target Tier 4 config first (same writer set, `kind: synthetic-screen` + `synthetic-camera`) to prove the runner side still works before adding the real-capture variable.

Commit the real-capture implementation as its own step before any Tier 4 test configs go in.

| # | Name | Config |
|---|---|---|
| T4.1 | Real-capture Phase 2 1080p | T3.1 with real `SCStream` + `AVCaptureSession`. Sanity check that real capture doesn't change the baseline. |
| T4.2 | Real-capture known-hang 1440p | T3.2 with real capture. Confirms the failure reproduces with real capture too (expected yes). |
| T4.3 | Real-capture best-performing Tier 3 variant | Whichever Tier 3 variant looked most promising, now with real capture. |

### Tier 5 — Parameter sweeps

Goal: take the most interesting configuration from Tiers 3–4 and vary individual tuning parameters (from the deep-dive research in `docs/research/11-m2-pro-video-pipeline-deep-dive.md`) to see which ones move the needle.

**Important framing.** By the time this task starts, task-1 has already shipped the high-confidence tunings (priorities 1–5 below) as the main-app and harness defaults. That changes the purpose of Tier 5 sweeps from *"try a new tuning to see if it helps"* to *"isolate the contribution of a tuning we already ship, by flipping it back to the pre-task-1 value and measuring the delta."* This is a more valuable experiment: it tells us not just whether the combined tunings work, but *which specific tuning is carrying which part of the weight*. If Tier 3 passes at 1440p on the post-task-1 defaults, Tier 5 reverse-sweeps tell us the minimal subset of tunings we actually needed. If Tier 3 still fails at 1440p, Tier 5 tells us whether the failure depends on specific tuning combinations — i.e. whether any single reversion also causes Tier 3 to fail.

Structure: take the most interesting configuration, run it N times with one parameter changed per run. The research doc lists these as falsifiable hypotheses H1–H12 in section 7 — consult that section for the full rationale, expected behaviour, and pass/fail criteria of each one before writing the config. The priority list below is lifted directly from the research doc's ranked shortlist and is ordered cheapest/highest-leverage first. Confidence labels (**high** / **medium** / **low**) reflect how strongly Apple docs, WWDC sessions, or production-app code support the hypothesis.

| Priority | Sweep | Already a task-1 default? | Confidence | Source evidence |
|---|---|---|---|---|
| 1 | `VTCompressionSessionPrepareToEncodeFrames` warm-up via task-1 tuning 2's reorder (`writer.startWriting()` moved into `prepareRecording()` before `screenCapture.startCapture()`) vs the pre-task-1 ordering (warm-up after SCStream opens) | **yes** (task-1 tuning 2) | **high** | `VTCompressionSession.h`: "If this isn't called, any necessary resources will be allocated on the first `VTCompressionSessionEncodeFrame` call." Our spindump shows the hang is on exactly that allocation path. Reverse-sweep in the harness measures how much of the stability delta comes from warming up before SCStream is running. |
| 2 | ~~`kVTCompressionPropertyKey_MaxFrameDelayCount` — 1, 2, 4, `kVTUnlimitedFrameDelayCount`~~ | **deferred** (task-1 tuning 5) | — | **Not reachable through `AVAssetWriter`.** Task-1 discovered that `AVAssetWriter` throws `NSInvalidArgumentException` for any H.264 value other than `3` ("video codec type avc1 only allows the value 3") and rejects any compression-properties dict on ProRes outputs. HandBrake / OBS / FFmpeg sweep this freely because they drive `VTCompressionSession` directly. This sweep can only run after task-4 moves the pipeline off `AVAssetWriter` for encoding. See `docs/task-1-tunings-audit-2026-04-14.md`. |
| 3 | `kVTCompressionPropertyKey_AllowFrameReordering` — `false` (task-1 default) vs `true` on H.264 writers | **yes** (task-1 tuning 4) | **high** | Removes the B-frame reorder buffer entirely. HLS doesn't require B-frames. Reverse-sweep via the `allowFrameReordering` tunings key measures whether disabling B-frames mattered. |
| 4 | `kVTCompressionPropertyKey_RealTime` — `kCFBooleanFalse` (task-1 default) vs unset vs `kCFBooleanTrue` | **yes** (task-1 tuning 3) | **medium-high** | OBS issue #5840 (<https://github.com/obsproject/obs-studio/issues/5840>) documents that `RealTime = true` caused heavy framedrops on M1/M2 and that "removing the `RealTime` property makes the HW VideoToolbox very reliable." OBS, FFmpeg, and HandBrake all ship `kCFBooleanFalse`. The harness's `realTime` tunings key accepts `true` / `false` / JSON `null` (where `null` leaves the property unset for the three-way comparison). |
| 5 | `SCStreamConfiguration.pixelFormat` / `SyntheticFrameSource` format — `420v` (task-1 default, covered by T3.6 and T4.1/T4.3 for real capture) vs BGRA | **yes** (task-1 tuning 1) | **high** | WWDC22/10155 lists `420v` "for encoding and streaming" and Apple's 4K/60 sample uses it. Cap uses it. Cuts per-frame screen IOSurface bytes from 4 bpp to 1.5 bpp (~63% reduction). Reverse-sweep to BGRA (via the new `synthetic-screen-bgra` source kind task-1 added) isolates the pixel format's contribution. |
| 6 | `kCVPixelBufferPoolMaximumBufferAgeKey` — 0.1 s vs the 1 s default; plus `kCVPixelBufferPoolAllocationThresholdKey` hard ceiling via `CVPixelBufferPoolCreatePixelBufferWithAuxAttributes` | **no** (new sweep) | **medium** | `CVPixelBufferPool.h` documents the 1 s default age-out. The threshold key lets the pool fail fast (returns `kCVReturnWouldExceedAllocationThreshold`) instead of triggering a kernel allocation at the wrong moment. |
| 7 | Serialised encoder start-up — covered by task-1 tuning 2; this sweep explicitly pits it against forced-parallel start-up via the top-level `warmUp = "parallel"` override that task-1 added to `HarnessConfig` | **yes** (task-1 tuning 2) | **medium** | Hypothesis H7: the three-encoder allocation race during the first few hundred milliseconds is the vulnerable window. Removing the parallelism at that one moment removes the contention. Reverse-sweep measures how much of the 1440p stability delta comes from serialisation specifically. |
| 8 | `SCStreamConfiguration.queueDepth` — 3 (default) vs higher | **no** (new sweep) | **medium** | WWDC22/10155 verbatim: "Increase the depth of the frame queue to ensure high fps at the expense of increasing the memory footprint of WindowServer." Each unit = one extra IOSurface. |
| 9 | `kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder = true` (enforcement) | **yes** (task-1 tuning 6) | **medium** | Not a fix — a safety net. Task-1 ships this as `AVVideoEncoderSpecificationKey` at the top level of `outputSettings` on every H.264 writer, verified working through `AVAssetWriter`. Makes silent software fallback fail loudly at `startWriting()` with a VT error instead of a kernel deadlock. Note: the readback form of the tuning (reading `UsingHardwareAcceleratedVideoEncoder`) is **not implementable** through `AVAssetWriter` — the internal `VTCompressionSession` isn't exposed. Sweep is effectively "enforcement on vs off", not "readback says what". |
| 10 | ~~`kVTCompressionPropertyKey_PixelBufferPoolIsShared` read-back audit (diagnostic)~~ | **deferred** (task-1 tuning 7) | — | **Not reachable through `AVAssetWriter`** — the property lives on the encoder's internal `VTCompressionSession`, which `AVAssetWriter` doesn't expose. The architectural fix is to feed writers via `AVAssetWriterInputPixelBufferAdaptor` with `sourcePixelBufferAttributes` matching the encoder's preferred input, which is a shape change belonging to task-4. See `docs/task-1-tunings-audit-2026-04-14.md`. |

Tuning-knob plumbing: task-1 added `realTime` and `allowFrameReordering` as new writer `tunings` keys, and a top-level `warmUp` field on `HarnessConfig`. `maxFrameDelayCount` was intentionally *not* added — task-1 tuning 5 was deferred (see priority 2 above). Read the updated `app/TestHarness/README.md` § "Writer tunings" for the current inventory and the two-line pattern for adding a new one. Priorities 6 and 8 are the sweeps in the table above that still need new `tunings` keys added as part of this task. Priority 2 and priority 10 can't be added through the `AVAssetWriter` path — they're blocked on task-4's shape change.

This tier is where the harness pays off: an automated sweep of 10–20 configurations running overnight while the developer works on something else is dramatically more efficient than manual testing. Most Tier 5 sweeps can be expressed as multiple JSON files in `test-configs/tier-5/` that differ only in one `tunings` key. The tier runner picks them up in order and stops on the first fail like any other tier.

**The composing question.** If every single-variable reverse-sweep of a task-1 tuning (priorities 1–5) still passes at 1440p, the combined tunings are load-bearing as a *set* rather than individually — each one contributes some headroom but no single one is critical. If a single reverse-sweep causes the hang to come back, that single tuning is the load-bearing piece and task-4 must preserve it. If the pre-task-1 defaults fail at 1440p (the reasonable expectation) but the post-task-1 defaults also fail, nothing in this set is sufficient and the decision framework below applies.

### Research hypotheses quick reference

The research doc at `docs/research/11-m2-pro-video-pipeline-deep-dive.md` § 7 defines twelve falsifiable hypotheses H1–H12 with full rationale, setup, and pass/fail criteria. Mapping from hypothesis to tier:

| Hypothesis | Tier coverage | Notes |
|---|---|---|
| H1 — ScreenCaptureKit `420v` pixel format | T3.6 (synthetic), Tier 5 priority 5 (with real capture) | Highest-leverage single change per the research. |
| H2 — `VTCompressionSessionPrepareToEncodeFrames` warm-up | Tier 5 priority 1 | Maps directly to the preparationQueue stall the spindump shows. |
| H3 — `MaxFrameDelayCount` bounded | **Deferred to task-4** | Task-1 discovered `AVAssetWriter` enforces a hardcoded value of `3` for H.264 and rejects any compression dict on ProRes. Not reachable through the current shape. See `docs/task-1-tunings-audit-2026-04-14.md`. |
| H4 — `AllowFrameReordering = false` on H.264 | Tier 5 priority 3 | Shipped by task-1 as a harness default. Tier 5 reverse-sweep against `true` measures its contribution. |
| H5 — `RealTime = kCFBooleanFalse` on all sessions | Tier 5 priority 4 | The OBS #5840 hypothesis. |
| H6 — `CVPixelBufferPool` tuning (age, threshold) | Tier 5 priority 6 | |
| H7 — Serialised encoder start-up | Tier 5 priority 7 | Composes with H2. |
| H8 — `queueDepth = 3` | Tier 5 priority 8 | Real-capture relevance starts at Tier 4. |
| H9 — `PixelBufferPoolIsShared` audit | **Deferred to task-4** | Not readable through `AVAssetWriter`'s public API — the property lives on the internal `VTCompressionSession`. Unlocks together with H3 if task-4 moves off `AVAssetWriter`. |
| H10 — `RequireHardwareAcceleratedVideoEncoder = true` | Tier 5 priority 9 | Task-1 shipped this as the enforcement form (silent software fallback now fails loudly at `startWriting()`). The readback form is not implementable through `AVAssetWriter`. |
| H11 — Shape change: drop ProRes, match Cap's two-writer recipe | Outside tier structure — this is the decision-framework fallback if nothing else works | Decision-framework option below. Do not run blindly without reading the research doc's rationale. |
| H12 — Per-writer heartbeat supervisor | Not a harness hypothesis — this is a main-app resilience improvement | Hand off to task-4 (or a task-4 follow-up) if Tier 3 confirms that neither the harness nor the main app can cleanly recover from the hang in userspace. Not a tuning knob, so explicitly out of scope for task-1. |

Before creating a Tier 5 config, read the corresponding hypothesis in the research doc in full. The research doc contains the "why we think this" and "pass criterion" detail that doesn't fit in this table.

### Observability to capture per Tier 3+ run

The existing `SystemSnapshot` captures `vm_stat`, `ioreg -c IOSurfaceRoot -l`, `ps -M`, `powermetrics` before and after each run. That's the baseline. For any Tier 3+ config (and any Tier 5 sweep that's expected to be on the failure boundary), capture additional context so that a hang produces richer evidence than just `result.json`. Commands and predicates from the research doc § Area 3 "Observability toolbox":

```bash
# Extra IOKit snapshots to diff before/after — add to SystemSnapshot or run alongside
ioreg -rxc IOGPU
ioreg -rxc IOAccelerator
ioreg -rxc AGXAccelerator
ioreg -lw0 | grep -i -E 'IOGPU|IOAccel|IOSurface|PerformanceStatistics'

# Per-process IOSurface footprint (poll during the run)
footprint --by-category $(pgrep -x WindowServer)
footprint --by-category $(pgrep LoomCloneTestHarness)

# Unified log stream — start before the config, stop after
log stream --level debug --predicate \
  'subsystem == "com.apple.coremedia" OR subsystem == "com.apple.videotoolbox" \
   OR subsystem == "com.apple.SkyLight" OR subsystem == "com.apple.iosurface" \
   OR subsystem == "com.apple.coreanimation" OR subsystem == "com.apple.GPU"' \
  > test-runs/<run-dir>/log-stream.txt
```

The log stream capture is the most valuable addition. It'll pick up `IOGPUFamily` / VideoToolbox / SkyLight messages that the Xcode console misses when the harness runs detached. Run it in a second terminal started immediately before the tier runner and stopped as soon as the runner exits (or the Mac recovers from a hang).

**Optional but high-value:** run an Instruments **Metal System Trace** around at least one confirmed-passing Tier 3 config and one confirmed-failing Tier 3 config (e.g. T3.1 passing and T3.2 failing, bounded to the first ~10 s so the trace doesn't blow up). Diffing channel utilisation between a stable and a deadlocked pipeline is the only tool Apple ships that can show IOGPUFamily queue contention. Save the traces under `test-runs/<run-dir>/` for later comparison. Instruments template docs: <https://developer.apple.com/metal/tools/>.

**`PixelBufferPoolIsShared` audit — deferred.** Originally intended as a per-run readback, but task-1 discovered this isn't implementable: the property lives on the encoder's internal `VTCompressionSession` and `AVAssetWriter` doesn't expose the session. Getting a meaningful answer requires moving to `AVAssetWriterInputPixelBufferAdaptor` with explicit `sourcePixelBufferAttributes` or direct `VTCompressionSession` management, which is task-4 shape-change territory. See `docs/task-1-tunings-audit-2026-04-14.md`.

## Open research questions this task should close out

The research doc § 6 lists five open questions from `docs/m2-pro-video-pipeline-failures.md` that remain unanswered after the research pass and need empirical data. This task is the place they get answered. Map each question to the tier(s) expected to produce the answer, and make sure the tier baseline summary explicitly addresses each one — don't leave an open question implicitly closed.

| Open question (from failures doc) | Tier(s) that should answer it | What "answered" looks like |
|---|---|---|
| Q2 — What specific conditions cause IOGPUFamily to deadlock rather than back-pressure gracefully? | T3.1 vs T3.2 (reproducible baseline); Tier 5 sweeps 1–4 (which tunings flip it) | A concrete trigger we can describe in one sentence, e.g. "three concurrent VTCompressionSessions each holding an unbounded IOSurface working set" or "the first-frame allocation race on `preparationQueue`." |
| Q3 — Are there VideoToolbox session properties that affect IOGPUFamily resource allocation behaviour? | Tier 5 sweeps 1, 3, 4 (and 2 once task-4 unlocks it) | A yes/no per property, with the specific sweep that demonstrated the effect. "Reverse-sweeping `RealTime` to unset moved T3.2 from FAIL-KILLED to PASS" is the shape of a good answer. Q3 can't be fully closed until task-4 exposes `MaxFrameDelayCount`, but the sweeps we *can* run still narrow the space meaningfully. |
| Q5 — What is the IOSurface pool sizing strategy, and is any of it tunable? | Tier 5 sweeps 6, 8 | Whether lowering `kCVPixelBufferPoolMaximumBufferAgeKey` or `SCStreamConfiguration.queueDepth` changed peak footprint (via `footprint --by-category` deltas) and whether it affected the hang. |
| Q7 — Does `VTCompressionSessionPrepareToEncodeFrames` pre-allocate IOSurface resources enough to prevent allocation stalls mid-recording? | Tier 5 sweep 1 | Whether the warm-up variant passes where the baseline fails, and whether `log stream` shows the allocation work happening during the warm-up phase vs during the recording phase. |
| Q8 — What's the IOSurface memory footprint cliff? | Every Tier 3 run + `footprint --by-category` polling | A rough MB-budget for the combined process + WindowServer working set at which the hang reproduces vs stays stable. Polling `footprint` every ~second during Tier 3 runs is how this gets measured. |

If a question remains open after the tier results land, explicitly say so in the tier baseline summary and note what evidence would still be needed — don't paper over the gap. The research doc is honest about what it couldn't determine from public sources; the baseline summaries should be equally honest about what the harness couldn't determine empirically.

The other three questions from the failures doc (Q1 documented session limit, Q4 Apple sample code, Q6 comparable-app handling) were answered definitively by the research doc and do not need to be re-answered here.

## Decision framework — what to do with the results

Once we have real data from the harness, we can make informed decisions about task-4 (recording pipeline stabilisation). A rough flow:

- **If T3.1 passes and T3.2 fails as expected**, the harness is working and the failure is reproducible in an isolated context. Good baseline.
- **If T3.3 (display-res ProRes) passes**, the fix for task-4 Path B is to reduce the raw screen capture resolution. Write it up as a recommendation, weigh the quality tradeoff, and decide whether to ship it.
- **If T3.5 (no raw camera) passes**, task-4 Path C applies — drop the raw camera writer at 1440p+. Less desirable because it loses a feature.
- **If T3.6 (YCbCr screen source) passes**, the fix is a small `SCStreamConfiguration` change (plus compositor-input adjustments if our CIContext path is currently BGRA-only). Best-case outcome.
- **If a Tier 5 sweep finds a specific `VTCompressionSession` or pool setting that flips failure to success**, task-4 Path A applies — we've identified both a fix and a deeper understanding of what's happening. This is the most desirable outcome because it ships 1440p intact and teaches us something.
- **If a single-variable Tier 5 sweep doesn't flip the failing config to passing, run a combined sweep** with priorities 1 + 2 + 3 (or 1 + 2 + 5) applied simultaneously before declaring the 1440p preset unshippable. Production apps all apply multiple tunings at once (see research doc Area 4); single-variable sweeps may miss combined effects.
- **If no combination of T3.3–T3.6 or Tier 5 combined-sweep passes**, hypothesis H11 ("match Cap's two-writer recipe") is the fallback: drop ProRes from the pipeline, defer all raw screen compositing to post-recording, and validate the two-writer shape in the harness. This is task-4 Path D territory but with an alternate framing — instead of reverting Phase 2 entirely, we keep the two-H.264-writer shape without ProRes, which avoids failure mode 1. Cap is in production with this exact recipe on M-series hardware (research doc Area 4), so it is known-stable.
- **If even H11 fails in the harness**, the hang is more fundamental than any shape change can rescue, and task-4 Path D (revert all the way to 1080p-only) is the only remaining option.

Whatever the result, the output of this task is concrete evidence that informs task-4. Leave this task with "we ran X and it PASSED/FAILED, here's the data", not "I think we should try X".

## Deliverable

1. **Tier 2 configs, runner script, baseline summary** committed to the repo. Summary lives at `test-runs/tier-2-baseline-<date>.md` and records per-config outcomes, interesting observations, and links to the runs that produced them. Run directories themselves stay gitignored.
2. **Tier 3 configs, runner script, baseline summary**, run one config at a time per the safety constraints above. The known-hang T3.2 is the single most important data point in this tier — it's the reference point everything else is compared against.
3. **Tier 4 configs** (if real-capture support lands in the harness as part of this task) and baseline summary.
4. **Tier 5 parameter sweep configs and summaries** for whatever subset of the deep-dive research hypotheses have landed by the time Tier 3 results are in hand.
5. **Updates to `docs/m2-pro-video-pipeline-failures.md`** — the empirical evidence the harness produces should flow back into the failure modes doc as "what we now know" footnotes, particularly in the "What we don't know" subsections. This is the single most valuable long-term artefact of this task.
6. **A findings hand-off note to task-4** summarising which harness-validated path (A / B / C / D from task-4's decision framework) the stabilisation work should take, and why. Either add it as a new section in `docs/tasks-todo/task-4-recording-pipeline-stabilisation.md` under "## Findings hand-off from task-2" or commit a standalone summary document under `docs/research/` or `test-runs/` and link to it from task-4.

## Handoff

This task's outputs are consumed by two places:

1. **Task-4 (recording pipeline stabilisation).** Task-4 is blocked on "what actually works on this hardware". The baseline summaries from this task provide the answer. When task-4 starts, any change that touches the recording pipeline should be validated in the harness first — don't reopen the "change the main app, run a real recording, hope for the best" loop.
2. **`docs/m2-pro-video-pipeline-failures.md`.** Harness findings update the "What we don't know" subsections of each failure mode with concrete answers. This is how the institutional memory stays current as we learn more.

## Adding new tests mid-task

Further research passes may surface new hypotheses that weren't in the original plan. Fold those in by adding new JSON configs to the appropriate tier directory — the harness is designed to make this cheap. If a new hypothesis doesn't obviously belong in an existing tier, add it to the tier that matches its risk level (Tier 2 for two-writer tests, Tier 3 for three-writer, Tier 5 for parameter sweeps on an existing config).
