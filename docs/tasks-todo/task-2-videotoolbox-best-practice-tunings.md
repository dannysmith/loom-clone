# Task 2 — VideoToolbox / ScreenCaptureKit / CVPixelBufferPool best-practice tunings

Apply the set of VideoToolbox, ScreenCaptureKit, and CVPixelBufferPool configuration knobs that the research pass in `docs/research/11-m2-pro-video-pipeline-deep-dive.md` identified as best-practice — the ones OBS, FFmpeg, HandBrake, and Cap all use and that we currently don't. These changes are high-confidence regardless of whether they fix failure mode 4 on their own: they match what every comparable production app does, they are supported by Apple's framework headers, and they reduce our IOSurface working set in ways that cost us nothing.

This task is **independent of task-1 (harness test execution)** and **independent of task-4 (pipeline stabilisation)**. It can run in parallel with either. The point is to get the main app onto a known-best-practice baseline so that task-1's tier tests and task-4's stabilisation work are both operating against a pipeline that already reflects the state of the art, not one we know is leaving tuning knobs on the table.

## Scope

- **In scope:** tunings applied to the existing recording pipeline in `app/LoomClone/Pipeline/` and `app/LoomClone/Capture/` that the research doc § Area 2 labelled **high** confidence and that all three of OBS / FFmpeg / HandBrake (or all of Cap / OBS / FFmpeg / HandBrake where applicable) agree on.
- **Out of scope:** anything where the research doc flagged confidence as **medium** or **low**; anything where comparable apps disagree; shape changes to the pipeline (e.g. dropping ProRes or matching Cap's two-writer recipe — those belong in task-4).
- **Out of scope:** the harness. If a tuning needs to be validated in the harness before being applied to the main app, do that via task-1's Tier 5 infrastructure (the harness already supports per-writer `tunings` dicts). This task is about the main app.

## Prerequisites — verify current state first

Before changing anything, audit what the main app currently does. The research doc's Area 2 catalogue was built from Apple headers, WWDC transcripts, and comparable-app source code — it did not read the Swift source of this project. Several of the tunings below may already be set; others may need to be added. Either way, the first step is a read-only audit.

Files to read in full before making any change:

- `app/LoomClone/Pipeline/WriterActor.swift` — the composited HLS writer
- `app/LoomClone/Pipeline/RawStreamWriter.swift` — the raw H.264 / ProRes / audio writers
- `app/LoomClone/Pipeline/CompositionActor.swift` — the CIContext compositor
- `app/LoomClone/Capture/ScreenCaptureManager.swift` — the SCStream configuration
- `app/LoomClone/Capture/CameraCaptureManager.swift` — the AVCaptureSession configuration
- `app/LoomClone/Pipeline/RecordingActor.swift` — the top-level coordinator

For each tuning below, answer before editing:

1. Is it already set? What value?
2. Is it set via `outputSettings` dictionary on `AVAssetWriterInput`, or via direct property-set on a `VTCompressionSession`, or via `SCStreamConfiguration`?
3. Does the change affect only one writer or all writers?

Record the current state in a short audit note in the task body (or in the commit message) so future readers can see what changed and what didn't.

## The tunings

Each tuning below includes: what to change, where in the code it likely lands, the primary source evidence, and a short note on risk. All source references are verbatim from Apple headers (mirrored at `xybp888/iOS-SDKs` and `phracker/MacOSX-SDKs`) or from comparable-app source lines cited in the research doc Area 4.

### 1. ScreenCaptureKit pixel format → `420v`

**Change.** Set `SCStreamConfiguration.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange` (`'420v'`) in `ScreenCaptureManager`. Currently likely BGRA (the AppKit-friendly default).

**Why.** Apple's own 4K/60 example in WWDC22 session 10155 ("Take ScreenCaptureKit to the next level") sets this format. Cap uses it (`crates/recording/src/sources/screen_capture/macos.rs`). Per-frame screen IOSurface footprint drops from 4 bpp to 1.5 bpp — at 1440p that is ~14.7 MB → ~5.5 MB per frame, multiplied across queue depth and encoder working sets. Both the H.264 and ProRes hardware paths prefer YCbCr internally, so BGRA forces a colour-conversion stage we don't need.

**Risk.** Non-trivial if the compositor currently reads BGRA from the SCStream output and expects RGBA inputs. `CIImage(cvPixelBuffer:)` handles `420v` natively, but any code path that pokes at raw bytes (e.g. a `CVPixelBufferGetBaseAddress` call) will need to adapt. Verify the compositor and any direct-read paths handle biplanar YCbCr before changing the format.

**Validation.** After the change, record a short screen clip via the main app at the 1080p preset and visually inspect the composited HLS output for colour correctness. If the hue is off, the compositor is either declaring the wrong input colour space or the writer output is missing a matching colour-properties attachment.

**Source.** Research doc § Area 2 "ScreenCaptureKit configuration catalogue" row 1 (`pixelFormat`); WWDC22/10155 transcript at <https://developer.apple.com/videos/play/wwdc2022/10155/>; Apple sample code "Capturing screen content in macOS" at <https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-in-macos>; Cap source at `crates/recording/src/sources/screen_capture/macos.rs` (fetched via raw.githubusercontent.com).

### 2. `VTCompressionSessionPrepareToEncodeFrames` warm-up

**Change.** Before opening the SCStream and before any writer begins accepting frames, call `VTCompressionSessionPrepareToEncodeFrames` on every active `VTCompressionSession` — sequentially, one at a time, on a serial queue.

**Where it lands.** This is the trickiest tuning to apply in practice. Our composited HLS writer and raw H.264 / ProRes writers go through `AVAssetWriter`, which owns its internal `VTCompressionSession`. Three options:

- **(a) AVAssetWriter path — implicit.** `AVAssetWriter.startWriting()` / `startSession(atSourceTime:)` internally calls `VTCompressionSessionPrepareToEncodeFrames` on the writer's internal session. If we simply call `startWriting()` on all writers *before* opening the SCStream and *before* the first frame arrives, we get the warm-up effect without directly poking VT. This is the Cap approach. **Start here.** Verify by reading `WriterActor.swift` and `RawStreamWriter.swift` to see whether they currently call `startWriting()` eagerly at recording-start or lazily on the first frame.
- **(b) Serial warm-up ordering.** Make sure writer 1's `startWriting()` completes before writer 2's starts, and so on — not because Apple documents a requirement but because the research doc's hypothesis H7 is that three parallel allocations during the first few hundred milliseconds is the vulnerable window. Serialising removes the race at the cost of a brief startup delay.
- **(c) Direct `VTCompressionSession` access.** If we ever add a code path that creates a `VTCompressionSession` directly (e.g. for a bespoke encoder), always call `VTCompressionSessionPrepareToEncodeFrames` immediately after creation. Do not defer it to first-frame time.

**Why.** `VTCompressionSession.h` verbatim: *"You can optionally call this function to provide the encoder with an opportunity to perform any necessary resource allocation before it begins encoding frames. … If this isn't called, any necessary resources will be allocated on the first `VTCompressionSessionEncodeFrame` call."* Our spindump shows the hang is on exactly that allocation path (`com.apple.videotoolbox.preparationQueue` waiting on IOSurface allocation inside IOGPUFamily). OBS, FFmpeg, and HandBrake all call this function explicitly.

**Risk.** Low for option (a) — it's the same sequence of calls in a more controlled order. Option (b) adds measurable latency to recording start (probably tens of ms), which should be acceptable but worth confirming the UI feels responsive.

**Validation.** After the change, run `log stream --predicate 'subsystem == "com.apple.videotoolbox"'` while starting a recording. The allocation events should happen before the first `metronome` tick, not during it. If they still appear during the recording phase, the warm-up ordering isn't working.

**Source.** Research doc § Area 2 "`VTCompressionSessionPrepareToEncodeFrames` — definitive answer"; VTCompressionSession.h at `xybp888/iOS-SDKs`; OBS encoder.c line 802 at <https://raw.githubusercontent.com/obsproject/obs-studio/master/plugins/mac-videotoolbox/encoder.c>; FFmpeg videotoolboxenc.c line 1658; HandBrake encvt.c line 1574.

### 3. `kVTCompressionPropertyKey_RealTime = kCFBooleanFalse` on all `VTCompressionSession` instances

**Change.** On every `VTCompressionSession` that the pipeline uses (whether owned directly or through `AVAssetWriter`'s `outputSettings[AVVideoCompressionPropertiesKey]` dictionary), set `kVTCompressionPropertyKey_RealTime` to `kCFBooleanFalse`. The AVAssetWriter path is via `AVVideoCompressionPropertiesKey` in the `outputSettings` dict passed to `AVAssetWriterInput.init(mediaType:outputSettings:)`, with key `"RealTime"` (or `AVVideoMaxKeyFrameIntervalKey`-adjacent documented equivalents — read the `AVVideoSettings.h` header to find the exact key name for the AVFoundation bridge).

**Verify first:** our current main app may or may not set this. The default (NULL / unset) is documented as "unknown," which is what Cap currently does (they rely on `setExpectsMediaDataInRealTime(true)` at the AVAssetWriterInput layer instead). Setting it explicitly to `false` is what OBS, FFmpeg, and HandBrake do.

**Why.** OBS issue #5840 documents that setting `RealTime = true` on M1/M2 caused "heavy framedrops" and that *"removing the `RealTime` property makes the HW VideoToolbox very reliable"*. OBS's fix landed in PR #5809 — they moved to `kCFBooleanFalse` explicitly. FFmpeg made the same change earlier. The mechanism is undocumented but the production-app convergence is strong signal. The concern is that on our three-session + compositor pipeline this setting may affect how the encoder reserves and releases IOSurface backing, which is the resource that deadlocks us.

**Risk.** Medium. OBS's fix was for framedrops, not hangs, and we're applying it to a configuration none of those projects run. If we see increased end-to-end latency in the composited HLS output after this change, that's the tradeoff and it's worth measuring. Task-1 Tier 5 sweep 4 will validate this empirically in the harness.

**Validation.** Start a 1080p recording after the change, confirm HLS segment cadence stays at 4.000 s ± 8 ms (the same bar Phase 2's validation used), and confirm Xcode console shows zero `kIOGPUCommandBufferCallback*` errors.

**Source.** Research doc § Area 4 "OBS Studio patterns" and § Area 2 "VTCompressionSession property catalogue" row `RealTime`; OBS issue #5840 at <https://github.com/obsproject/obs-studio/issues/5840>; OBS PR #5809 at <https://github.com/obsproject/obs-studio/pull/5809>; OBS encoder.c lines 789–795; FFmpeg videotoolboxenc.c line 1606; HandBrake encvt.c lines 1531–1535.

### 4. `kVTCompressionPropertyKey_AllowFrameReordering = false` on H.264 writers

**Change.** On the composited HLS writer and the raw H.264 camera writer (if it uses H.264), set `AVVideoAllowFrameReorderingKey = false` in the compression properties dict. This disables B-frames.

**Verify first:** Cap already sets this (<https://raw.githubusercontent.com/CapSoftware/Cap/main/crates/enc-avfoundation/src/mp4.rs>, `MP4Encoder::init_with_options`). Our main app may already do the same — check `WriterActor.swift` and `RawStreamWriter.swift` before changing anything.

**Why.** `VTCompressionProperties.h` verbatim: *"Enables frame reordering. In order to encode B frames, a video encoder must reorder frames … True by default. Set this to false to prevent frame reordering."* Disabling frame reordering removes the encoder's B-frame reorder buffer and every IOSurface reference it would otherwise hold. HLS low-latency playback does not require B-frames; disabling them costs us nothing in this pipeline. ProRes does not use B-frames, so this property is a no-op on the ProRes writer.

**Risk.** Low. HLS works without B-frames. Measurable but small bitrate efficiency loss (B-frames improve compression by a few percent) — acceptable tradeoff.

**Validation.** Record at 1080p, verify segment cadence and file sizes are sane, play back the HLS output in Safari or a video player and confirm it plays cleanly.

**Source.** Research doc § Area 2 "VTCompressionSession property catalogue" row `AllowFrameReordering`; VTCompressionProperties.h at `xybp888/iOS-SDKs`; Cap source `crates/enc-avfoundation/src/mp4.rs` ~line 200.

### 5. `kVTCompressionPropertyKey_MaxFrameDelayCount` bounded

**Change.** On every `VTCompressionSession` (via `AVAssetWriter`'s `AVVideoCompressionPropertiesKey` dict or direct VT), set `MaxFrameDelayCount` to a small finite value. Suggested starting points: `1` for the ProRes screen writer, `2` for the H.264 composited HLS writer, `2` for the H.264 camera writer. The current default is `kVTUnlimitedFrameDelayCount` — the documented worst case for working-set size.

**Why.** `VTCompressionProperties.h` verbatim: *"The maximum frame delay count is the maximum number of frames that a compressor is allowed to hold before it must output a compressed frame. It limits the number of frames that may be held in the 'compression window'. If the maximum frame delay count is M, then before the call to encode frame N returns, frame N-M must have been emitted. The default is kVTUnlimitedFrameDelayCount."* Each held frame retains its source IOSurface plus internal reference frames. Bounding this bounds the encoder's working set. HandBrake is the only production app we examined that sets this explicitly (`libhb/platform/macosx/encvt.c` lines 1553–1558) — they treat it as a documented performance/memory knob.

**Risk.** Low-to-medium. Bounding the window too aggressively (e.g. `0`) may introduce measurable end-to-end latency in the HLS output. Start with `2` and measure. Task-1 Tier 5 sweep 2 will validate this in the harness across values `1, 2, 4`.

**Validation.** Same as tuning 3 — HLS segment cadence, zero GPU errors, visual correctness.

**Source.** Research doc § Area 2 row `MaxFrameDelayCount`; VTCompressionProperties.h at `xybp888/iOS-SDKs`; HandBrake encvt.c lines 1553–1558.

### 6. `kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder = true` (diagnostic safety net)

**Change.** Pass `kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder = kCFBooleanTrue` in the `encoderSpecification` argument when creating a `VTCompressionSession` directly. For AVAssetWriter-owned sessions, this isn't directly settable; the analogous guard is to read `kVTCompressionPropertyKey_UsingHardwareAcceleratedVideoEncoder` on the session (once AVAssetWriter has created it) and log / assert if it returns `false`.

**Why.** `VTCompressionProperties.h` verbatim explanation of the failure cases for this property: *"Hardware acceleration may be unavailable for a number of reasons. A few common cases are: – the machine does not have hardware acceleration capabilities – the requested encoding format or encoding configuration is not supported – **the hardware encoding resources on the machine are busy**."* That last bullet is hard documentary evidence that Apple itself acknowledges the system can run out of hardware encoder slots. Setting this to `true` means silent software fallback fails with an error code (`-12908` / `-12915`) instead of dragging the GPU into a deadlock or producing dramatically slower-than-expected output. This is pure diagnostic — it doesn't fix anything, but it changes a silent pathology into a loud one.

**Risk.** Low. On M2 Pro the hardware encoder is always available for our formats; this should never fail in steady state. If it does fail, that's useful information.

**Validation.** Check on startup that every session creation logs "using hardware accelerated encoder = true". If not, the session config is wrong and needs to be fixed before the other tunings can be meaningfully tested.

**Source.** Research doc § Area 2 row `RequireHardwareAcceleratedVideoEncoder`; VTCompressionProperties.h at `xybp888/iOS-SDKs`.

### 7. `kVTCompressionPropertyKey_PixelBufferPoolIsShared` audit (diagnostic, not a sweep)

**Change.** Immediately after each `VTCompressionSession` is created (or each `AVAssetWriterInput` is added and its `pixelBufferAdaptor.pixelBufferPool` is first accessed), read `kVTCompressionPropertyKey_PixelBufferPoolIsShared` via `VTSessionCopyProperty`. Log the value. If it returns `false`, log a warning.

**Why.** `VTCompressionProperties.h` verbatim: *"Indicates whether a common pixel buffer pool is shared between the video encoder and session client. False if separate pools are used due to incompatible pixel buffer attributes."* A `false` here means the source pixel format, geometry, or attachments don't match what the encoder wants, and the system is silently running a second IOSurface pool to bridge the gap — doubling the encoder's memory footprint. This is a pure sanity check: any `false` indicates a mismatch we can fix by adjusting the source pixel buffer attributes. Regardless of whether it changes the 1440p hang, this should always be an assertion on the main app's pipeline.

**Risk.** None. Read-only check.

**Validation.** Start a recording; confirm every writer logs `pool-shared = true` on creation.

**Source.** Research doc § Area 2 row `PixelBufferPoolIsShared`; VTCompressionProperties.h at `xybp888/iOS-SDKs`.

## What's deliberately NOT in this task

These tunings are in the research doc Area 2 shortlist but have been left out of this task on purpose, either because they're medium-confidence (need empirical validation in task-1 first) or because they conflict with each other:

- **`kVTCompressionPropertyKey_MaximizePowerEfficiency`** — trade-off with `RealTime = false`. Leave alone until task-1 data.
- **`CVPixelBufferPool` age and threshold tuning (`kCVPixelBufferPoolMaximumBufferAgeKey`, `kCVPixelBufferPoolAllocationThresholdKey`)** — medium confidence per research doc. Task-1 Tier 5 sweep 6 will validate.
- **Dropping `SCStreamConfiguration.queueDepth`** — medium confidence. Trade-off with capture frame rate stability. Task-1 Tier 5 sweep 8 will validate.
- **Sub-native-resolution `SCStreamConfiguration.width` / `height`** — this is task-4 Path B territory (reduce raw screen capture resolution as a fix for failure mode 4). Belongs in task-4, not here.
- **Shape changes** (drop ProRes, drop the raw camera writer at 1440p, match Cap's two-writer recipe) — task-4.
- **Per-writer heartbeat supervisor** (research doc H12) — this is a pipeline-resilience improvement, not a VideoToolbox tuning. Add to task-4 follow-ups if the harness demonstrates the hang cannot be cleanly caught in userspace.

## Implementation protocol

1. **Audit first.** For each tuning, read the existing code and record the current state. Commit the audit notes (or put them in the PR description) so future readers can see what changed.
2. **One tuning per commit.** Apply tunings 1–7 as separate commits (or separate small PRs). If any regresses something, reverting is trivial.
3. **Validate each commit at the 1080p preset.** Never test these against 1440p on the current `main` — 1440p hangs the Mac until task-4 lands. Use the 1080p preset's proven-stable configuration as the validation bar: 30 s → 1 min → longer, with zero `kIOGPUCommandBufferCallback*` errors and 4.000 s ± 8 ms HLS segment cadence. This matches Phase 2's validation protocol.
4. **Run `log stream --predicate 'subsystem CONTAINS "videotoolbox" OR subsystem CONTAINS "coremedia"'` during each validation** and grep the output for any new error or warning that wasn't present before. Commit the log snippets to the PR description if anything interesting shows up.
5. **Do not touch the main pipeline's shape.** No writers added or removed, no resolution changes, no compositor rewrites. Only the tunings above.

## Exit criteria

- [ ] Each of tunings 1–7 has been either applied (with a commit), or explicitly documented as already-in-place in the audit, or flagged as blocked (with a one-line explanation).
- [ ] All tunings applied are validated against the 1080p preset with the Phase 2 validation protocol (30 s → 1 min → longer, zero GPU errors, healthy segment cadence).
- [ ] `log stream` logs captured during validation show no new errors or warnings compared to the pre-change baseline.
- [ ] A short "tunings audit" note is committed to the task (in the commit message, PR description, or a run-notes file) recording what was changed, what was already in place, and what was deferred.
- [ ] Tunings 1–7 do not touch the 1440p preset. That's task-4's job once task-1 has data.

## Handoff

- **To task-1:** the harness already has its own writers with their own `tunings` dicts, and Tier 5 sweeps parameterise tunings independently. This task does not change the harness. If task-1's Tier 5 sweeps want to validate any of these tunings in isolation, they do so via the harness's `tunings` dict — see `app/TestHarness/README.md` § "Writer tunings". The main-app changes from this task don't flow back into the harness.
- **To task-4:** task-4 applies shape changes and preset-level decisions based on task-1 data. By the time task-4 starts, the main-app pipeline should already be on these best-practice tunings. If task-4 needs to roll back a tuning because it regresses something at 1440p, that's a fine outcome — at least we'll know the tuning was tried.
- **To `docs/m2-pro-video-pipeline-failures.md`:** if applying any of these tunings changes the behaviour of any known failure mode (even failure mode 1's segment cadence degradation), record the observation as a "what we now know" footnote under that failure mode.

## Cross-task references

- `docs/research/11-m2-pro-video-pipeline-deep-dive.md` — the research doc whose Area 2 catalogue is the source of these tunings.
- `docs/m2-pro-video-pipeline-failures.md` — the institutional memory the tunings are meant to reduce the surface area of.
- `docs/tasks-todo/task-1-run-test-harness-tests.md` — the harness execution task. Runs in parallel with this task; their outputs feed task-4 together.
- `docs/tasks-todo/task-4-recording-pipeline-stabilisation.md` — the task that resolves the 1440p hang. Depends on task-1 data. Task-2 should be shipped first so task-4 is working against a best-practice baseline.
- `app/TestHarness/README.md` — for the harness-side analogue of these tunings if any of them needs to be validated via the harness first.
