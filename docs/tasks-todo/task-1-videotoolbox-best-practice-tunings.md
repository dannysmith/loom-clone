# Task 1 — VideoToolbox / ScreenCaptureKit / CVPixelBufferPool best-practice tunings

Apply the set of VideoToolbox, ScreenCaptureKit, and CVPixelBufferPool configuration knobs that the research pass in `docs/research/11-m2-pro-video-pipeline-deep-dive.md` identified as best-practice — the ones OBS, FFmpeg, HandBrake, and Cap all use and that we currently don't. These changes are high-confidence regardless of whether they fix failure mode 4 on their own: they match what every comparable production app does, they are supported by Apple's framework headers, and they reduce our IOSurface working set in ways that cost us nothing.

These tunings also happen to be the most plausible specific interventions against the exact kernel signature observed in failure mode 4 (`docs/m2-pro-video-pipeline-failures.md`). That doc's "what we don't know" list explicitly asks three questions this task addresses:

- Whether `VTCompressionSessionPrepareToEncodeFrames` would pre-allocate IOSurface resources in a way that avoids the deadlock → tuning 2.
- Whether any of `RealTime`, `MaxFrameDelayCount`, `AllowFrameReordering`, etc. affect IOGPUFamily's resource allocation behaviour → tunings 3, 4, 5.
- Whether changing `SCStreamConfiguration.pixelFormat` to YCbCr 420 would reduce IOSurface pressure → tuning 1 (already applied in the main app; only the harness still needs catching up).

**This task runs first**, before task-2 (harness test execution). Putting it first means:

- Task-2's Tier 3 tests get to answer a sharper question — "does the hang survive even after best practices?" instead of "does the hang happen on an unaudited baseline?"
- Task-2's Tier 5 parameter sweeps become single-variable experiments against a known-good baseline, not sweeps against a pipeline where other knobs are silently on defaults.
- A Tier 5 sweep of `MaxFrameDelayCount` is only meaningful if the warm-up, pixel format, and `RealTime` settings are already known and stable. This task establishes that known baseline.
- The harness writers get updated alongside the main-app writers, so the harness is exercising the same pipeline shape the main app is — important because Tier 4 (real-capture replacement) ultimately has to match the main app's behaviour.

## Scope

- **In scope (main app):** tunings applied to the existing recording pipeline in `app/LoomClone/Pipeline/` and `app/LoomClone/Capture/` that the research doc § Area 2 labelled **high** confidence and that all three of OBS / FFmpeg / HandBrake (or all of Cap / OBS / FFmpeg / HandBrake where applicable) agree on.
- **In scope (harness):** the same tunings mirrored into `app/TestHarness/Writers/` (`HarnessCompositedHLSWriter`, `HarnessRawH264Writer`, `HarnessRawProResWriter`) and `app/TestHarness/Sources/` where they apply. The harness intentionally doesn't share code with the main app (see `app/TestHarness/CLAUDE.md`), so this is a deliberate copy — not a refactor. For tunings that are parameterisable via `tunings` dicts in the harness's `HarnessConfig`, the new defaults should reflect best practice; the dict can still override for Tier 5 sweep variants.
- **Validation gate:** a manual 1080p recording on the real main app after the tunings are applied, following the Phase 2 staged protocol (30 s → 1 min → longer) with zero `kIOGPUCommandBufferCallback*` errors. **Do not skip this.** The tunings are high-confidence at the "comparable-app" level but have not been validated against this specific pipeline shape.
- **Out of scope:** anything where the research doc flagged confidence as **medium** or **low** (those are Tier 5 sweeps in task-2); anything where comparable apps disagree; shape changes to the pipeline (e.g. dropping ProRes or matching Cap's two-writer recipe — those belong in task-4).
- **Out of scope:** testing the tunings at 1440p. The 1440p preset currently hangs `main` until task-4 resolves it. Validation in this task is strictly at the 1080p preset.

## Audit findings

A read-only pass over `app/LoomClone/Pipeline/{WriterActor,RawStreamWriter,CompositionActor,RecordingActor}.swift`, `app/LoomClone/Capture/{ScreenCaptureManager,CameraCaptureManager}.swift`, and the harness analogues under `app/TestHarness/` established the current state of every tuning in this task:

| # | Tuning | Main app | Harness |
|---|---|---|---|
| 1 | SCStream `420v` | ✅ Already set (`ScreenCaptureManager.swift:41`). Camera delivers 420v too. `CompositionActor` uses `CIImage(cvPixelBuffer:)` — no raw-byte paths. | Not set. `synthetic-screen` maps to `.screenBGRA`. Needs a new `.screen420v` kind. |
| 2 | `VTCompressionSessionPrepareToEncodeFrames` warm-up | Serial already (actor-hop awaits in `commitRecording()`), but writer `startWriting()` happens *after* `screenCapture.startCapture()`. SCStream opens first; writers warm up while SCStream is already allocating IOSurfaces. | Already warms up before the metronome (`HarnessRunner.run()` does serial `for w in writers { w.startWriting() }` before `runMetronome()`). Missing a `harness.warmUp` knob for Tier 5 p7 parallel comparison. |
| 3 | `RealTime = false` | Not set. Both H.264 writers use `expectsMediaDataInRealTime = true` on the input but have no `RealTime` key in `AVVideoCompressionPropertiesKey`. | Not set. Same story. |
| 4 | `AllowFrameReordering = false` | Not set. No `AVVideoAllowFrameReorderingKey` on either H.264 writer. | Not set. |
| 5 | `MaxFrameDelayCount` bounded | Not set (default is `kVTUnlimitedFrameDelayCount`). | Not set. |
| 6 | `RequireHardwareAcceleratedVideoEncoder` | Not set. We never create `VTCompressionSession` directly — every path is through `AVAssetWriter`. The bridged form lives at `AVVideoEncoderSpecificationKey` at the top level of `outputSettings`. | Not set. |
| 7 | `PixelBufferPoolIsShared` readback | **Not implementable through `AVAssetWriter`'s public API.** The property lives on the `VTCompressionSession`, and `AVAssetWriter` doesn't expose its internal session. See the deferred section below. | Same. |

Consequences of the audit that shape the work below:

- **Tuning 1's main-app change is already done.** Only the harness needs to catch up so its synthetic screen source exercises the same pixel path as the live SCStream.
- **Tuning 2 is partly done on both sides** (writers already warm up serially, and in the harness already before the metronome), but the main-app ordering still opens SCStream *before* the warm-up completes. That ordering is what this task changes.
- **Tunings 3–5 are clean mechanical additions** to `AVVideoCompressionPropertiesKey` dicts on both sides.
- **Tuning 6 happens on the enforcement side** (`AVVideoEncoderSpecificationKey`) but the readback/logging form the original task spec described is unreachable — `AVAssetWriter` hides the underlying VT session.
- **Tuning 7 is fully deferred.** The architectural fix that would make it meaningful is a shape change belonging to task-4.

## The tunings

### 1. ScreenCaptureKit pixel format → `420v`

**Main app: already set.** `ScreenCaptureManager.swift:41` sets `config.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange`. Camera also delivers 420v (`CameraCaptureManager.swift:111`). Nothing to change.

**Harness change.** `SyntheticFrameSource` currently has `.screenBGRA` and `.camera420v` kinds. Tier-1 configs use `synthetic-screen`, which maps to `.screenBGRA`. Add a third kind `.screen420v` and flip the `synthetic-screen` config mapping so it defaults to 420v, matching the main-app pixel path. Keep `.screenBGRA` reachable via a new `synthetic-screen-bgra` config kind for the explicit BGRA exception case. `HarnessCompositor` already uses `CIImage(cvPixelBuffer:)` with no raw-byte access, so 420v input is safe there.

**Why.** Apple's own 4K/60 example in WWDC22 session 10155 ("Take ScreenCaptureKit to the next level") sets this format. Cap uses it. Per-frame screen IOSurface footprint drops from 4 bpp to 1.5 bpp — at 1440p that is ~14.7 MB → ~5.5 MB per frame, multiplied across queue depth and encoder working sets.

**Validation.** Tier-1 harness configs must still pass after the flip. No main-app validation required since the main app hasn't changed.

**Source.** Research doc § Area 2 "ScreenCaptureKit configuration catalogue" row 1; WWDC22/10155 transcript at <https://developer.apple.com/videos/play/wwdc2022/10155/>; Cap `crates/recording/src/sources/screen_capture/macos.rs`.

### 2. `VTCompressionSessionPrepareToEncodeFrames` warm-up — move warm-up in front of SCStream

**Main-app change.** In `RecordingActor.prepareRecording()`, move `writer.startWriting()`, `screenRawWriter?.startWriting()`, and `audioRawWriter?.startWriting()` out of `commitRecording()` and into `prepareRecording()`, placed after each writer's `configure()` and after `writer.setOnSegmentReady { ... }` is wired, but **before** `screenCapture.startCapture()`. `commitRecording()` then only anchors the clock, calls `timeline.markStarted()`, and starts the metronome.

`AVAssetWriter.startWriting()` / `startSession(atSourceTime:)` internally calls `VTCompressionSessionPrepareToEncodeFrames` on the writer's internal session. Calling it on all three warmable writers *before* SCStream opens means their IOSurface allocations happen in a quiet window, not while SCK is competing for IOGPUFamily resources.

**The camera raw writer is unavoidably still warmed up at commit time.** It's configured from the live `AVCaptureDevice.activeFormat` dimensions after `cameraCapture.startCapture()` returns, so it can't be constructed any earlier. That's acceptable: by the time the camera raw writer starts, the other three writers have already warmed up, so the writer-to-writer race the task hypothesis describes is still avoided.

Two correctness concerns to handle during implementation:

- The HLS init segment fires out of the delegate as soon as `writer.startWriting()` is called. It will flow through `handleSegment()` before `timeline.markStarted()` is called in commit. Confirm `RecordingTimelineBuilder` accepts a segment record before `markStarted`; if not, adjust sequencing (e.g. call `markStarted()` earlier, or have `handleSegment` tolerate pre-start segments).
- If `prepareRecording()` throws *after* a writer has been started, that writer must be cleaned up rather than leaked. Audit the existing error paths before committing.

**Harness change.** `HarnessRunner.run()` already has the right ordering (`buildWriters()` → serial `for w in writers { w.startWriting() }` → `runMetronome()`). What's missing is a tuning knob for Tier 5 priority 7 to sweep serial vs parallel warm-up. Add `harness.warmUp = "serial" | "parallel"` at the top level of `HarnessConfig` (default `"serial"`); in the parallel branch, dispatch the writer `startWriting()` calls via `withTaskGroup`.

**Why.** `VTCompressionSession.h` verbatim: *"You can optionally call this function to provide the encoder with an opportunity to perform any necessary resource allocation before it begins encoding frames. … If this isn't called, any necessary resources will be allocated on the first `VTCompressionSessionEncodeFrame` call."* Failure mode 4's spindump shows the hang is on exactly that allocation path (`com.apple.videotoolbox.preparationQueue` waiting on IOSurface allocation inside `IOGPUFamily` kext) at ~8 seconds into a recording. OBS, FFmpeg, and HandBrake all call this function explicitly.

**Validation.** After the change, record a 1080p clip via the main app following the 30 s → 1 min → longer protocol. `com.apple.videotoolbox.preparationQueue` events should happen during prepare (before any `metronome` tick), not during the recording phase. Capture `log stream --predicate 'subsystem == "com.apple.videotoolbox"'` output for the PR description.

**Source.** Research doc § Area 2 "`VTCompressionSessionPrepareToEncodeFrames` — definitive answer"; `VTCompressionSession.h`; OBS `encoder.c` line 802; FFmpeg `videotoolboxenc.c` line 1658; HandBrake `encvt.c` line 1574. Failure mode 4 spindump: `docs/m2-pro-video-pipeline-failures.md` § "Failure mode 4".

### 3. `kVTCompressionPropertyKey_RealTime = kCFBooleanFalse`

**Change.** Add `kVTCompressionPropertyKey_RealTime as String: kCFBooleanFalse` to the `AVVideoCompressionPropertiesKey` dict on every H.264 writer — main app (`WriterActor`, `RawStreamWriter .videoH264`) and harness (`HarnessCompositedHLSWriter`, `HarnessRawH264Writer`). Harness gets a new `realTime` tunings key so Tier 5 priority 4 can sweep it across {unset, false, true}.

ProRes writers currently take no compression-properties dict — no-op on that side.

**Why.** OBS issue #5840 documents that setting `RealTime = true` on M1/M2 caused "heavy framedrops" and that *"removing the `RealTime` property makes the HW VideoToolbox very reliable"*. FFmpeg and HandBrake both ship `kCFBooleanFalse`. The mechanism is undocumented but the production-app convergence is strong signal.

**Risk.** Medium. OBS's fix was for framedrops, not hangs, and we're applying it to a configuration none of those projects run. If we see increased end-to-end latency in the composited HLS output after this change, that's the tradeoff and it's worth measuring. Task-2 Tier 5 priority 4 will sweep this directly.

**Validation.** HLS segment cadence stays at 4.000 s ± 8 ms at 1080p; zero `kIOGPUCommandBufferCallback*` errors.

**Source.** Research doc § Area 4 "OBS Studio patterns" and § Area 2 "VTCompressionSession property catalogue" row `RealTime`; OBS issue #5840; OBS PR #5809; OBS `encoder.c` lines 789–795; FFmpeg `videotoolboxenc.c` line 1606; HandBrake `encvt.c` lines 1531–1535.

### 4. `AVVideoAllowFrameReorderingKey = false` on H.264 writers

**Change.** Add `AVVideoAllowFrameReorderingKey: false` to the `AVVideoCompressionPropertiesKey` dict on the composited HLS writer and the raw H.264 camera writer, both sides. Disables B-frames. No-op on ProRes writers (ProRes doesn't use B-frames and has no compression dict).

**Why.** `VTCompressionProperties.h` verbatim: *"Enables frame reordering. In order to encode B frames, a video encoder must reorder frames… True by default. Set this to false to prevent frame reordering."* Disabling frame reordering removes the encoder's B-frame reorder buffer and every IOSurface reference it would otherwise hold. HLS low-latency playback does not require B-frames. Cap already ships this way (`crates/enc-avfoundation/src/mp4.rs`, `MP4Encoder::init_with_options`).

**Risk.** Low. Measurable but small bitrate efficiency loss (B-frames improve compression by a few percent) — acceptable tradeoff.

**Validation.** HLS output plays cleanly in Safari / a media player; segment cadence healthy; no new errors.

**Source.** Research doc § Area 2 row `AllowFrameReordering`; `VTCompressionProperties.h`; Cap source `crates/enc-avfoundation/src/mp4.rs` ~line 200.

### 5. `kVTCompressionPropertyKey_MaxFrameDelayCount` bounded

**Change.**
- **H.264 writers (main app and harness):** set `kVTCompressionPropertyKey_MaxFrameDelayCount as String: 2` in the compression dict.
- **ProRes writers (`RawStreamWriter .videoProRes`, `HarnessRawProResWriter`):** attempt `AVVideoCompressionPropertiesKey: [kVTCompressionPropertyKey_MaxFrameDelayCount as String: 1]`. These writers currently have *no* compression dict at all; the existing code comment explicitly says "ProRes doesn't take the same settings dict as H.264". It's an open question whether `AVAssetWriter` accepts `MaxFrameDelayCount` on a ProRes output. Try it; if `configure()` or `startWriting()` fails, roll the ProRes side of this tuning back, record the result in the audit note, and leave the H.264 sides in place.

Harness adds `maxFrameDelayCount` as a tunings key so Tier 5 priority 2 can sweep {1, 2, 4}.

**Why.** `VTCompressionProperties.h` verbatim: *"The maximum frame delay count is the maximum number of frames that a compressor is allowed to hold before it must output a compressed frame. … The default is kVTUnlimitedFrameDelayCount."* Each held frame retains its source IOSurface plus internal reference frames; bounding this bounds the encoder's working set. HandBrake is the only production app we examined that sets this explicitly (`encvt.c` lines 1553–1558).

**Risk.** Low-to-medium. Bounding too aggressively may introduce measurable end-to-end latency in the HLS output.

**Validation.** Same as tuning 3 — HLS segment cadence, zero GPU errors, visual correctness.

**Source.** Research doc § Area 2 row `MaxFrameDelayCount`; `VTCompressionProperties.h`; HandBrake `encvt.c` lines 1553–1558.

### 6. `kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder = true` (enforcement, no readback)

**Change.** Add `AVVideoEncoderSpecificationKey: [kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder as String: kCFBooleanTrue]` as a **top-level** key in `outputSettings` (next to `AVVideoCodecKey`, not inside `AVVideoCompressionPropertiesKey`) on every H.264 writer, both sides. This bridges into the `encoderSpecification` argument of the `VTCompressionSession` that `AVAssetWriter` creates internally. If the hardware H.264 encoder is unavailable for any reason, `writer.startWriting()` fails with a VT error instead of silently falling back to software.

The ProRes writer is unaffected — the spec key is H.264/HEVC-specific, and ProRes is enforced via codec selection itself.

**The readback form of this tuning is unreachable.** Reading `kVTCompressionPropertyKey_UsingHardwareAcceleratedVideoEncoder` requires calling `VTSessionCopyProperty` on the live session, and `AVAssetWriter` doesn't expose its internal `VTCompressionSession`. We rely on the enforcement form (hard failure at `startWriting()`) as our signal that hardware is active and skip the per-session log event the original task spec described.

**Why.** `VTCompressionProperties.h` verbatim explanation of the failure cases for this property: *"Hardware acceleration may be unavailable for a number of reasons. A few common cases are: – the machine does not have hardware acceleration capabilities – the requested encoding format or encoding configuration is not supported – **the hardware encoding resources on the machine are busy**."* That last bullet is hard documentary evidence that Apple itself acknowledges the system can run out of hardware encoder slots. Setting this to `true` means silent software fallback fails with an error code (`-12908` / `-12915`) instead of dragging the GPU into a deadlock or producing dramatically slower-than-expected output.

**Risk.** Low. On M2 Pro the hardware encoder is always available for our formats; this should never fail in steady state. If it does fail, that's useful information.

**Validation.** `writer.startWriting()` succeeds; no new errors at recording start.

**Source.** Research doc § Area 2 row `RequireHardwareAcceleratedVideoEncoder`; `VTCompressionProperties.h`.

### 7. `kVTCompressionPropertyKey_PixelBufferPoolIsShared` — deferred, not implementable through `AVAssetWriter`

**Not implementable as a live-session check through `AVAssetWriter`'s public API.** The property lives on the `VTCompressionSession`, and `AVAssetWriter` does not expose its internal session anywhere public — we cannot call `VTSessionCopyProperty(_, kVTCompressionPropertyKey_PixelBufferPoolIsShared, _)` on the session the writer is actually using. A throwaway `VTCompressionSession` created with matching settings wouldn't give an accurate answer either, because it wouldn't have the real session's source buffer attributes.

The architectural fix that would *make* `PixelBufferPoolIsShared` true by construction is to feed writers via `AVAssetWriterInputPixelBufferAdaptor` with `sourcePixelBufferAttributes` matching the encoder's preferred input, instead of appending raw `CMSampleBuffer`s. That's a shape change — currently `WriterActor` and `RawStreamWriter` both call `input.append(sampleBuffer)` directly — and it belongs in task-4 alongside the other shape-level decisions.

**Outcome.** Tuning 7 is deferred in this task. No main-app or harness change. Task-4 picks it up as part of the pixel-buffer-adaptor path.

## What's deliberately NOT in this task

These tunings are in the research doc Area 2 shortlist but have been left out of this task on purpose, either because they're medium-confidence (need empirical validation via task-2's Tier 5 sweeps first) or because they conflict with each other:

- **`kVTCompressionPropertyKey_MaximizePowerEfficiency`** — trade-off with `RealTime = false`. Leave alone until task-2 Tier 5 data.
- **`CVPixelBufferPool` age and threshold tuning (`kCVPixelBufferPoolMaximumBufferAgeKey`, `kCVPixelBufferPoolAllocationThresholdKey`)** — medium confidence per research doc. Task-2 Tier 5 priority 6 will validate.
- **Dropping `SCStreamConfiguration.queueDepth`** — medium confidence. Trade-off with capture frame rate stability. Task-2 Tier 5 priority 8 will validate.
- **Sub-native-resolution `SCStreamConfiguration.width` / `height`** — task-4 Path B territory.
- **Shape changes** (drop ProRes, drop the raw camera writer at 1440p, match Cap's two-writer recipe, feed writers via `AVAssetWriterInputPixelBufferAdaptor`) — task-4.
- **Per-writer heartbeat supervisor** (research doc H12) — pipeline-resilience improvement, not a VT tuning. Task-4 follow-ups.

## Implementation protocol

1. **Implement in the main app and the harness together, one tuning at a time.** For each tuning 1–6 being applied, the unit of work is a single commit (or small PR) that touches the main-app side, the harness side, and `app/TestHarness/README.md` § "Writer tunings" if a new tunings key was added. Keeping them in lockstep means the harness is always exercising the same state as the main app — which is the whole point of doing this task before task-2.
2. **Validate each commit at the 1080p preset on the main app.** Never test these against 1440p on the current `main` — 1440p hangs the Mac until task-4 lands. Use the 1080p preset's proven-stable configuration as the validation bar: 30 s → 1 min → longer, with zero `kIOGPUCommandBufferCallback*` errors and 4.000 s ± 8 ms HLS segment cadence. This matches Phase 2's validation protocol.
3. **Smoke-test each commit via the harness at Tier 1.** Existing Tier 1 configs should still pass after each tuning is applied. Run `./app/TestHarness/Scripts/run-tier-1.sh` after each commit. If Tier 1 configs start failing, roll back the commit and investigate. **Do not touch Tier 3 in this task** — that's task-2's job.
4. **Run `log stream --predicate 'subsystem CONTAINS "videotoolbox" OR subsystem CONTAINS "coremedia"'` during each main-app validation** and grep the output for any new error or warning that wasn't present before. Commit the log snippets to the PR description if anything interesting shows up.
5. **Do not touch the main pipeline's shape.** No writers added or removed, no resolution changes, no compositor rewrites. Only the tunings above.
6. **If a tuning breaks at 1080p on the main app or in the harness Tier 1 run**, do not force it through. Roll the commit back, record the observation in the audit notes, and mark the tuning as "tried, regressed, deferred" in the exit criteria. This is a legitimate outcome — it means the research-based high-confidence tuning does not transfer cleanly to our pipeline shape.

## Exit criteria

- [ ] Tunings 1–6 each have a documented outcome: applied, already-in-place (tuning 1 main app), or "tried, regressed, deferred" with a one-line explanation and a link to the commit that was rolled back.
- [ ] Tuning 7 remains deferred with its reasoning captured so task-4 picks it up.
- [ ] All tunings applied are validated against the 1080p preset on the main app with the Phase 2 validation protocol (30 s → 1 min → longer, zero GPU errors, healthy segment cadence).
- [ ] After each tuning commit, `./app/TestHarness/Scripts/run-tier-1.sh` still passes (all Tier 1 configs green). The existing Tier 1 baseline at `test-runs/tier-1-baseline-2026-04-11.md` is the reference.
- [ ] `app/TestHarness/README.md` § "Writer tunings" updated with any new `tunings` keys added during this task (e.g. `realTime`, `maxFrameDelayCount`, `harness.warmUp`, and — if exposed — `allowFrameReordering`).
- [ ] `log stream` logs captured during main-app validation show no new errors or warnings compared to the pre-change baseline.
- [ ] A short "tunings audit" note is committed (in a `docs/` note file or in PR descriptions) recording what was changed, what was already in place, what was tried and rolled back, and what was deferred.
- [ ] Tunings 1–6 do not touch the 1440p preset in either the main app or the harness.
- [ ] The main-app pipeline and the harness writers are in sync on every tuning covered by this task.

## Handoff

- **To task-2 (run harness tests):** this task hands task-2 a harness whose writers are on the same best-practice baseline as the main app. Task-2's Tier 2 and Tier 3 tests then exercise the *same* pipeline shape the main app ships, and Tier 5 sweeps vary individual tunings against that known-good baseline. If task-2 discovers that a tuning this task shipped causes a regression in Tier 3, that's a valid finding — record it in the failures doc and coordinate the rollback with task-4.
- **To task-4 (recording pipeline stabilisation):** task-4 applies shape changes based on task-2's data. By the time task-4 starts, the main-app pipeline should already be on these best-practice tunings. Tuning 7 is explicitly deferred to task-4's scope (the `AVAssetWriterInputPixelBufferAdaptor` path).
- **To `docs/m2-pro-video-pipeline-failures.md`:** if applying any of these tunings changes the behaviour of any known failure mode (even failure mode 1's segment cadence degradation), record the observation as a "what we now know" footnote under that failure mode.

## Cross-task references

- `docs/research/11-m2-pro-video-pipeline-deep-dive.md` — the research doc whose Area 2 catalogue is the source of these tunings. Hypotheses H1–H10 (the non-shape-change hypotheses) trace directly to the tunings in this task.
- `docs/m2-pro-video-pipeline-failures.md` — the institutional memory the tunings are meant to reduce the surface area of. Failure mode 4 is the kernel signature that motivates tuning 2's warm-up reordering.
- `docs/tasks-todo/task-2-run-test-harness-tests.md` — the harness execution task that consumes this task's output.
- `docs/tasks-todo/task-4-recording-pipeline-stabilisation.md` — the task that resolves the 1440p hang. Also picks up the deferred tuning 7 (pixel-buffer-adaptor path).
- `app/TestHarness/README.md` — § "Writer tunings", which this task updates with any new tuning keys.
- `app/TestHarness/CLAUDE.md` — agent notes for the harness; the rule "never touch the main LoomClone recording pipeline from this directory" does not apply in reverse — this task is allowed (and required) to touch both sides.
