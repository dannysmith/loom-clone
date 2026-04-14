# Task-1 tunings — audit note

This note closes out `docs/tasks-todo/task-1-videotoolbox-best-practice-tunings.md`. It records for each of the seven tunings: what the task asked for, what was already in place, what was applied, what was tried and rolled back, and what was deferred. Future readers looking for "why is X set / not set on the writers" should find the answer here.

Context: all tunings were applied with the goal of reducing the main-app pipeline's surface area around failure mode 4 (the IOGPUFamily kernel deadlock, `docs/m2-pro-video-pipeline-failures.md`) while matching what OBS / FFmpeg / HandBrake / Cap all ship. Validation gate was a manual 1080p recording on the main app (display + camera + mic) plus `./app/TestHarness/Scripts/run-tier-1.sh` after every commit. All applied tunings passed both.

## Per-tuning outcomes

### 1. SCStream pixel format → `420v`

**Outcome.** Main app already in place (`ScreenCaptureManager.swift:41`, `CameraCaptureManager.swift:111`). Harness caught up by adding a new `.screen420v` kind to `SyntheticFrameSource` and flipping the `synthetic-screen` config default to map to it. A new `synthetic-screen-bgra` kind preserves the BGRA path for the exception case.

**Commit.** `c719590 task-1 tuning 1: flip harness synthetic-screen default to 420v`.

### 2. Warm up writers before SCStream opens

**Outcome.** Applied on both sides.

Main-app change: `writer.startWriting()` / `screenRawWriter?.startWriting()` / `audioRawWriter?.startWriting()` moved from `commitRecording()` into `prepareRecording()`, placed after `setOnSegmentReady` is wired but before `screenCapture.startCapture()`. `commitRecording()` now only anchors the clock, marks the timeline started, warms up the camera raw writer (which can't be warmed earlier — it's constructed from the live `AVCaptureDevice.activeFormat` dims), and starts the metronome. A new `tearDownWarmedUpWritersOnPrepareFailure()` handles the one post-warm-up throw path.

Harness change: added a top-level `warmUp = "serial" | "parallel"` knob on `HarnessConfig` for the Tier 5 priority 7 sweep. The "serial" path (default) matches the existing ordering; "parallel" uses a `TaskGroup`. As a side effect of adding a defaulted field, wrote a custom `init(from:)` on `HarnessConfig` that uses `decodeIfPresent` for every defaulted field — the existing schema comment called this "tolerant to growth" but Swift's synthesised `Codable` treats defaulted `var`s as required at decode time. Latent bug now fixed; future task-2 Tier 5 configs can add tuning keys without per-config JSON migrations.

**Commit.** `f33cc4e task-1 tuning 2: warm up writers before SCStream opens`.

### 3. `kVTCompressionPropertyKey_RealTime = kCFBooleanFalse` on H.264 writers

**Outcome.** Applied on both sides (main-app `WriterActor` + `RawStreamWriter .videoH264`; harness `HarnessCompositedHLSWriter` + `HarnessRawH264Writer`). Harness gains a `realTime` tunings key for Tier 5 priority 4 sweeps across {unset, false, true}: a JSON `null` value leaves the VT property unset entirely (matching the macOS "unknown" default) for comparison against the explicit bool cases.

**Commit.** `ce4e9c7 task-1 tuning 3: RealTime = false on H.264 writers`.

### 4. `AVVideoAllowFrameReorderingKey = false` on H.264 writers

**Outcome.** Applied on both sides. Harness gains an `allowFrameReordering` tunings key for controlled true/false comparison.

**Commit.** `d342786 task-1 tuning 4: AllowFrameReordering = false on H.264 writers`.

### 5. `kVTCompressionPropertyKey_MaxFrameDelayCount` — **deferred, both variants**

**Outcome.** Deferred. Both H.264 and ProRes variants discovered to be unreachable through `AVAssetWriter`'s public API.

Specifically, two separate `NSException` throws at `AVAssetWriterInput` construction:

- **ProRes:** `AVAssetWriter` rejects *any* `AVVideoCompressionPropertiesKey` dict on a ProRes output. Tier-1 `T1.1-prores-4k-alone` crashed with exit code 134 as soon as we attempted to pass a dict containing `kVTCompressionPropertyKey_MaxFrameDelayCount`.
- **H.264:** `AVAssetWriter` hardcodes this property to exactly `3` for `avc1` and throws `NSInvalidArgumentException` with the message *"For compression property MaxFrameDelayCount, video codec type avc1 only allows the value 3"* for any other value. Tier-1 `T1.2-h264-1080p-alone` crashed with exit code 134 at value `2`.

HandBrake / OBS / FFmpeg can bound this freely because they drive `VTCompressionSession` directly. Our AVAssetWriter-based path cannot — the public API enforces the constraints above. Comments in `WriterActor.swift`, `RawStreamWriter.swift`, `HarnessCompositedHLSWriter.swift`, `HarnessRawH264Writer.swift`, and `HarnessRawProResWriter.swift` record the constraint so future readers don't re-attempt it.

Reaching `MaxFrameDelayCount < 3` is a shape-change job for **task-4** (direct VT or `AVAssetWriterInputPixelBufferAdaptor` path). This is the same architectural direction that also unlocks tuning 7.

**Commit.** `fa8d40e task-1 tuning 5: deferred — AVAssetWriter constraints`. (Commit reverts the failed attempts back to the post-tuning-4 state so the main app doesn't change behaviour from this task entry — main-app 1080p validation wasn't re-run for this commit because the runtime is equivalent to tuning 4.)

### 6. `kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder = true`

**Outcome.** Applied as enforcement on both sides via the top-level `AVVideoEncoderSpecificationKey` in `outputSettings`. If the hardware H.264 encoder is unavailable, `writer.startWriting()` fails loudly with a VT error instead of silently falling back to software.

The readback form of this tuning (reading `kVTCompressionPropertyKey_UsingHardwareAcceleratedVideoEncoder` via `VTSessionCopyProperty` on the live session) is *not* implementable because `AVAssetWriter` doesn't expose its internal `VTCompressionSession`. We rely on enforcement only — "`startWriting()` succeeded" is our signal that hardware is active. ProRes writers are unaffected (the spec key is H.264/HEVC-specific).

**Commit.** `bf728ee task-1 tuning 6: require hardware H.264 encoder`.

### 7. `kVTCompressionPropertyKey_PixelBufferPoolIsShared` — **deferred**

**Outcome.** Deferred, same root cause as tuning 5: the property lives on the `VTCompressionSession`, and `AVAssetWriter` doesn't expose its internal session. A standalone `VTCompressionSession` proxy wouldn't give an accurate answer (it wouldn't have matching source buffer attributes).

The architectural fix that would *make* `PixelBufferPoolIsShared` true by construction is to feed writers via `AVAssetWriterInputPixelBufferAdaptor` with `sourcePixelBufferAttributes` matching the encoder's preferred input, rather than appending raw `CMSampleBuffer`s. That's a shape change belonging to **task-4**.

## What landed on the main app, short version

- **Tunings 1, 3, 4, 6** are applied.
- **Tuning 2** (warm-up reorder) is applied — biggest behavioural change in the task.
- **Tunings 5 and 7** are deferred to task-4 (both require moving off `AVAssetWriter` for encoding).

All applied tunings validated at 1080p with the Phase 2 protocol: zero `kIOGPUCommandBufferCallback*` errors, interior segment cadence inside ±8 ms of 4.000 s, no `videomediaconverter` thread, no hang. Tier 1 harness passes after every commit.

## What this hands to the next tasks

**To task-2 (run harness tests).** The harness writers are now on the same best-practice baseline as the main app, so Tier 2 / Tier 3 tests exercise the same pipeline shape the main app ships. Tier 5 sweeps have functional tunings keys for the parameters this task parameterised (`realTime`, `allowFrameReordering`, `warmUp`). Two Tier 5 priorities from the task-2 doc that were planned here are not reachable on the current shape:

- **Priority 2 (`MaxFrameDelayCount` sweep)** — not possible through `AVAssetWriter`. If task-2 still wants this data, the harness will need the direct-VT path first.
- **Priority 7 (warm-up serial vs parallel)** — is reachable via the `warmUp` knob on `HarnessConfig`.

**To task-4 (recording pipeline stabilisation).** Task-4 inherits two deferred items that both point the same direction:

- Tuning 5 (`MaxFrameDelayCount`) — blocked behind moving off `AVAssetWriter`'s strict H.264 defaults.
- Tuning 7 (`PixelBufferPoolIsShared`) — blocked behind feeding writers via `AVAssetWriterInputPixelBufferAdaptor` with matching source attributes, or driving `VTCompressionSession` directly.

Both unlock together if task-4 decides the shape change is worth it. Until then, they are accepted trade-offs.

**To `docs/m2-pro-video-pipeline-failures.md`.** No failure-mode behaviour changed during this task's validation runs (1080p was already known-stable). Failure mode 4 (1440p deadlock) has not been re-tested — that's explicitly out of scope for task-1 and belongs to task-2's Tier 3.

## Commit trail

```
bf728ee task-1 tuning 6: require hardware H.264 encoder
fa8d40e task-1 tuning 5: deferred — AVAssetWriter constraints
d342786 task-1 tuning 4: AllowFrameReordering = false on H.264 writers
ce4e9c7 task-1 tuning 3: RealTime = false on H.264 writers
f33cc4e task-1 tuning 2: warm up writers before SCStream opens
c719590 task-1 tuning 1: flip harness synthetic-screen default to 420v
9d7602e Update task doc
```
