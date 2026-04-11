# Task 0A — Encoder Contention, Camera Pipeline & Adjustments

Three related issues in the macOS recording pipeline, sequenced so each phase builds on the foundation of the previous one and can be committed independently.

**The core finding**: Our current approach runs three concurrent hardware H.264 encode sessions (composited HLS + raw `screen.mp4` + raw `camera.mp4`) on an M2 Pro that has a single media-engine video encode block. The time-slicing budget is exceeded and the hardware encoder back-pressures, which visibly manifests as `CIContext.render()` timing out with `kIOGPUCommandBufferCallbackErrorTimeout` — the CIContext is a downstream symptom, not the cause. A dedicated `MTLCommandQueue` does **not** isolate us: the Metal command scheduler and VideoToolbox both arbitrate through the same IOKit command-buffer queue.

**The fix**, in summary: stop running three concurrent H.264 sessions. Move the heaviest raw stream (`screen.mp4`) to the ProRes engine — a separate silicon block on M*Pro and M*Max chips that's currently idle in our pipeline. Along the way, fix missing colourspace metadata on camera buffers (which is independently causing CIContext to run an expensive multi-stage colour conversion chain every frame), plumb proper error handling into the compositor so we can detect and recover from future stalls, and finally build camera adjustment controls on the now-stable foundation.

Read `docs/requirements.md` for product context, `task-0-scratchpad.md` for the historical framing of these issues, and the Background section below before starting any phase.

---

## Background: why this is the plan

### The current three-encoder design

`RecordingActor.prepareRecording` instantiates:

1. A composited HLS writer at the chosen output preset (H.264, 6 Mbps @ 1080p). Frames come from the metronome at 30 fps; each one is composited via `CompositionActor.compositeFrame`, which calls `CIContext.render(to:bounds:colorSpace:)` at `CompositionActor.swift:114`.
2. A raw `screen.mp4` writer at native display resolution (H.264, 25–60 Mbps depending on height). Consumes `CMSampleBuffer`s directly from ScreenCaptureKit — no CIContext involvement.
3. A raw `camera.mp4` writer at the camera's native format (H.264, 12 Mbps). Consumes `CMSampleBuffer`s directly from AVCaptureSession — no CIContext involvement.

All three run concurrently through VideoToolbox's hardware H.264 path.

### What's actually breaking

On M2 Pro (Mac14,9):

- 2 encoders: stable.
- 3 encoders: `CIContext.render()` hits `kIOGPUCommandBufferCallbackErrorTimeout`, then `kIOGPUCommandBufferCallbackErrorSubmissionsIgnored` on every subsequent render. The metronome falls behind (segments stretch from 4 s to 8 s). The recording survives but degrades.

The `finishWriting` hang guard is already in place so this doesn't cause full hangs, just quality degradation.

### Why the CIContext isn't the real culprit

From Apple docs and community evidence (OBS, HandBrake, Sunshine, Blender, Unity):

- **M2 Pro has one video encode engine.** Apple had to issue a public correction on their own spec page over this. M1 Pro, M2 Pro, and M3 Pro all have a single H.264/HEVC engine; only Max and Ultra variants get multiple.
- **VideoToolbox defaults to hardware H.264** on Apple Silicon and won't silently fall back to software. `AVAssetWriter` is a thin wrapper over `VTCompressionSession`; switching APIs doesn't change contention.
- **Apple publishes no concurrent-session limit.** The single media engine time-slices between compression sessions, and three high-bitrate streams (especially one at native 4K) exceeds its budget.
- **Dedicated `MTLCommandQueue` does not isolate CIContext from encoder contention.** The Metal scheduler and VideoToolbox share a front-end arbiter through the same IOKit command-buffer queue. When the encoder back-pressures, CIContext command buffers wait behind it, hit the GPU watchdog, and time out. The CIContext errors are symptoms of a jammed encoder, not a CIContext bug.
- **ScreenCaptureKit cannot deliver pre-encoded samples.** SCStream always yields uncompressed `CVPixelBuffer`s — there is no passthrough-without-re-encode path for the screen stream.

### The ProRes escape hatch

The M*Pro media engine has a **separate ProRes encode block** distinct from the H.264/HEVC block. It's the same silicon that's marketed to pros for real-time multi-stream ProRes editing. In our pipeline it's completely unused.

The OBS community hit exactly this problem and the standard workaround is to move the heaviest passthrough stream to ProRes 422 Proxy. This fits us well:

- Raw `screen.mp4` is a master file we'll re-encode or transcode later anyway — its on-disk bitrate during capture doesn't matter downstream.
- ProRes 422 Proxy at 4K is roughly 350–500 Mbps (~5–8× the H.264 size). Within modern SSD write rates; not an issue for a single-user recording tool.
- The code change is small: swap the codec key on one AVAssetWriter output.
- No server-side impact — raw files aren't uploaded today.

This leaves the H.264 engine running two streams (composited HLS + raw camera) that it demonstrably handles, and puts the heavy stream on silicon that's otherwise idle.

### Untagged camera buffers make CIContext more expensive

Independently of the encoder issue: camera frames from USB devices (ZV-1 and many others) arrive without `kCVImageBufferYCbCrMatrixKey`, `kCVImageBufferTransferFunctionKey`, or `kCVImageBufferColorPrimariesKey`. CIContext can't skip colour management on untagged buffers, so it runs a full `colormatrix → clamp → alpha_swizzle → curve → colormatrix → curve → colormatrix` chain every frame.

Apple's TN2227 and QA1839 are the authoritative reference: attach Rec. 709 metadata on ingest, and set `AVVideoColorPropertiesKey` on the writer outputs to match, and the conversion graph collapses to near-noop.

This fix is orthogonal to the encoder contention — it reduces CIContext workload regardless of how many encoders are running. Doing it first gives us a cleaner baseline for testing the ProRes switch.

### CIContext error-handling is blind

`compositeFrame` uses the void `ciContext.render(to:bounds:colorSpace:)` method (`CompositionActor.swift:114`). It has no return value, no error object, and no task handle. The first time we discover a failed render is when the *next* render also fails. The task-based API `startTask(toRender:to:)` returns a `CIRenderTask` with immediate `NSError` feedback and lets us detect stalls with our own timeout rather than the OS watchdog.

Once we have structured error feedback we can wire up a recovery path: on error, rebuild the `CIContext` + `MTLCommandQueue`; if rebuild also fails, end the recording cleanly with a user-visible error. This is belt-and-braces for unexpected future environments (different cameras, bigger displays, thermal events).

---

## Phase 1 — Rec 709 colour metadata on camera buffers

### Goal

Stop CIContext running the expensive multi-stage colourspace conversion chain on every camera frame by tagging camera pixel buffers with explicit Rec. 709 metadata at the point they enter the pipeline, and matching the writer-side output colour properties.

### Behaviour after this lands

- Every camera frame passing through `CameraCaptureManager`'s delegate callback has `kCVImageBufferYCbCrMatrixKey`, `kCVImageBufferColorPrimariesKey`, and `kCVImageBufferTransferFunctionKey` set to `ITU_R_709_2` before it reaches any downstream consumer.
- All `AVAssetWriter` video outputs (composited HLS, raw screen, raw camera) declare `AVVideoColorPropertiesKey` matching Rec. 709, so the writer doesn't do its own redundant conversion.
- Xcode Instruments' Metal System Trace shows the CIContext render step dropping the `colormatrix → clamp → alpha_swizzle → curve → colormatrix → curve → colormatrix` chain for camera-sourced frames, collapsing to a near-noop colour path.

### Implementation outline

**`CameraCaptureManager.swift`** — in the capture delegate callback, before forwarding the sample buffer:

```swift
let attachments: [CFString: Any] = [
    kCVImageBufferYCbCrMatrixKey: kCVImageBufferYCbCrMatrix_ITU_R_709_2,
    kCVImageBufferColorPrimariesKey: kCVImageBufferColorPrimaries_ITU_R_709_2,
    kCVImageBufferTransferFunctionKey: kCVImageBufferTransferFunction_ITU_R_709_2,
]
if let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) {
    CVBufferSetAttachments(pixelBuffer, attachments as CFDictionary, .shouldPropagate)
}
```

Use `.shouldPropagate` so CIImage and AVAssetWriter both see the attachments.

Introspect the camera format at startup (already partially happens in `bestFormat`) and log the input's active pixel format, YCbCr matrix (if any), transfer function, and colour primaries. This gives us a diagnostic trail for debugging future cameras.

**`WriterActor.swift`** — add `AVVideoColorPropertiesKey` to `videoSettings`:

```swift
AVVideoColorPropertiesKey: [
    AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
    AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
    AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
]
```

**`RawStreamWriter.swift`** — same addition on both the raw screen and raw camera video outputs.

**`CompositionActor.swift`** — the `render(...)` call already passes `CGColorSpace(name: .itur_709)`. Leave it. Add a line-level comment explaining the tagging contract so future-us doesn't get confused.

**Screen buffers** — ScreenCaptureKit frames on macOS 14+ already arrive tagged. Verify this in the Instruments trace; if they're untagged in some config (e.g. HDR display capture), add tagging at the `ScreenCaptureManager` boundary as well. Otherwise leave screen buffers alone.

### Exit criteria

- [ ] Camera pixel buffers exit `CameraCaptureManager` with all three colour attachments set
- [ ] All three `AVAssetWriter` video outputs declare `AVVideoColorPropertiesKey`
- [ ] Xcode Instruments Metal System Trace of a live recording shows the CIContext render step no longer running the multi-stage colour conversion chain on camera frames (compare before/after traces)
- [ ] Composited HLS playback colour is visually indistinguishable from before (sanity check that we haven't introduced a colour error)
- [ ] Raw `camera.mp4` opened in QuickTime shows correct colour
- [ ] Raw `screen.mp4` opened in QuickTime shows correct colour
- [ ] Camera format introspection logs are visible on startup and include pixel format, matrix, transfer function, primaries
- [ ] A 5-minute recording on M2 Pro with display + camera + mic shows no behavioural regression

---

## Phase 2 — Move raw screen.mp4 to ProRes 422 Proxy

### Goal

Eliminate hardware H.264 encoder contention during recording by moving the raw screen stream off the H.264 engine onto the separate ProRes silicon block. Restore stable recording on M2 Pro with all three writers active.

### Behaviour after this lands

- `raw/screen.mp4` becomes `raw/screen.mov`, written via `AVVideoCodecType.proRes422Proxy` to an `AVAssetWriter` with file type `.mov`.
- Composited HLS writer and raw `camera.mp4` writer are unchanged — both still H.264 via VideoToolbox.
- During recording on M2 Pro with display + camera + mic at native 4K screen + 1080p camera, no `kIOGPUCommandBuffer*` timeouts occur. The composited metronome maintains its 4-second segment cadence.
- On-disk file size for `screen.mov` is 5–8× larger than the previous H.264 `screen.mp4` at the same content. Acceptable — this is a master file; downstream uploads/transcodes will shrink it.
- `recording.json` `rawStreams.screen` block is updated to reflect the new codec (`prores422proxy`) and filename. The `bitrate` field becomes approximate (ProRes is roughly CBR-per-frame, not target-bitrate), so record the observed average instead.

### Why ProRes 422 Proxy (not 422 / 422 HQ / 4444)

- **Proxy** is the lightest ProRes variant — ~45 Mb/s at 1080p, ~180 Mb/s at 4K. Still visually excellent for a master we'll re-encode from.
- **422 / 422 HQ / 4444** give more headroom but at much higher bitrates (up to ~1 Gb/s at 4K for 4444). We don't need editorial-grade quality; we need "higher quality than our H.264 master and offloadable to the ProRes engine."
- Proxy keeps disk write rates well within SSD headroom and leaves the ProRes engine with spare capacity.

### Implementation outline

**`RawStreamWriter.swift`** — extend the `Kind` enum:

```swift
enum Kind {
    case videoH264(width: Int, height: Int, bitrate: Int)
    case videoProRes(width: Int, height: Int)   // NEW
    case audio(bitrate: Int)
}
```

Split the writer initialisation based on kind:

- `.videoH264` → existing path, `AVFileType.mp4`, `AVVideoCodecType.h264`.
- `.videoProRes` → new path, `AVFileType.mov`, `AVVideoCodecType.proRes422Proxy`. No `AVVideoCompressionPropertiesKey` (ProRes doesn't take the same settings dict).

**`RecordingActor.swift`** — change the raw screen writer instantiation from `.videoH264` to `.videoProRes`. Keep the camera writer on `.videoH264`.

**File extension / path** — update `screen.mp4` → `screen.mov` throughout: `RecordingActor.prepareRecording`, `recording.json` timeline construction, cleanup paths, and any tests.

**`recording.json`** — adjust `rawStreams.screen` schema:

```json
"rawStreams": {
  "screen": {
    "filename": "screen.mov",
    "width": 3840, "height": 2160,
    "videoCodec": "prores422proxy",
    "averageBitrate": 187500000,
    "bytes": 4221111222
  }
}
```

Camera and audio blocks unchanged.

**Logging** — add a one-time startup log line reporting "Raw screen writer: ProRes 422 Proxy at {width}x{height}" so we can see in crash reports what the writer was configured with.

### Validation procedure (hardware-dependent)

This phase must be validated on M2 Pro hardware before merging. The architectural claim is "ProRes engine has enough headroom for 4K 422 Proxy concurrent with our two H.264 streams" and that's empirical, not documented.

1. Build the phase locally.
2. Record a 10-minute session with display + camera + mic at the highest preset available (4K if the display supports it, otherwise 1440p or 1080p).
3. During the recording, in Activity Monitor's GPU pane, observe Media Engine utilisation and GPU utilisation. Expectation: both engines are used; GPU is mostly idle.
4. In the terminal run `log stream --predicate 'subsystem CONTAINS "Metal"'` during the recording and watch for any `kIOGPUCommandBufferCallback*` errors. Expectation: none.
5. Open Xcode Instruments → Metal System Trace → record a 2-minute window → confirm no command-buffer timeouts.
6. On recording stop, confirm:
   - `screen.mov` plays in QuickTime at native resolution, no dropped frames, decodes at real-time speed.
   - Composited HLS segments are a consistent ~4 seconds each (not stretched).
   - Raw `camera.mp4` is stable.
7. Check disk-space impact: `screen.mov` at 4K for 10 min should be roughly 15–25 GB depending on content.

If step 4 or 5 surfaces errors, **stop and escalate** — the ProRes engine isn't giving us the headroom we hoped for, and we need a contingency.

### Contingencies if ProRes doesn't relieve contention

Ranked by preference:

1. **Reduce ProRes resolution.** Write `screen.mov` at a scaled-down resolution (e.g. 2560×1440 for a 4K display), not native. Still ProRes, still on the dedicated engine, less data throughput. We lose some master-file fidelity but the raw file is still usable for re-composition.
2. **Force one H.264 stream to software encode** via `VTSessionSetProperty` with `kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder = false` on the raw camera writer. Apple's docs imply this is allowed; community reports are thin. Software H.264 at 720p/12 Mbps is tractable on modern CPUs.
3. **Drop the raw camera H.264 writer and re-derive it from a higher-quality composited track.** Changes the master-file story significantly — lose this as a last resort.
4. **Disable live composited HLS** and only write raw streams during recording, compositing post-stop. Breaks "URL on clipboard within seconds of stop" — the principle we care about most. True last resort.

### Exit criteria

- [ ] `RawStreamWriter.Kind` has a `.videoProRes` case and the existing H.264 case is renamed `.videoH264`
- [ ] Raw screen writer is instantiated with `.videoProRes` at native display resolution
- [ ] Output filename is `screen.mov`, file type is `.mov`, codec key is `AVVideoCodecType.proRes422Proxy`
- [ ] `recording.json` `rawStreams.screen` block is updated to reflect the codec change
- [ ] **On M2 Pro**: a 10-minute recording with display + camera + mic at the highest available preset produces no `kIOGPUCommandBufferCallback*` errors (verified via `log stream` or Instruments)
- [ ] Composited HLS segments are a consistent ~4 seconds each throughout the 10-minute recording
- [ ] `screen.mov` plays cleanly in QuickTime at native resolution
- [ ] Activity Monitor GPU pane shows Media Engine + ProRes engine both in use during recording
- [ ] Raw `camera.mp4` is unchanged in behaviour (still H.264, still 12 Mbps, still at native camera format)
- [ ] Composited HLS upload pipeline is unchanged — recording still ends with a working playback URL
- [ ] Cancelling a recording cleans up `screen.mov` along with everything else

---

## Phase 3 — Plumb error handling into the compositor

### Goal

Replace the void-return `CIContext.render(to:bounds:colorSpace:)` with the task-based `startTask(toRender:to:)` API so we get structured error feedback, can detect stalls with our own timeout, and can attempt recovery before the OS watchdog fires. Add a teardown-and-rebuild recovery path for poisoned CIContexts.

### Why this matters even after Phase 2

Phase 2 removes the *known* source of GPU contention. Phase 3 is defense-in-depth for the *unknown* — a different camera, a bigger display, thermal throttling, a future macOS that changes arbitration behaviour. The current code silently drops frames on CIContext failure; we should fail loudly and, when possible, recover.

### Behaviour after this lands

- `CompositionActor.compositeFrame` uses `startTask(toRender:to:)` and checks the returned `CIRenderTask` for errors (via `waitUntilCompleted`).
- On a render error, the compositor tears down and rebuilds its `CIContext` and `MTLCommandQueue` before returning to the metronome. The next frame is rendered against the fresh context.
- If rebuild also fails (i.e. the device itself is wedged), the compositor signals the `RecordingActor` to end the recording cleanly with a user-visible error ("Recording stopped: GPU became unresponsive. Your recording has been saved up to this point.") rather than silently producing a corrupted recording.
- Recovery events are logged so we can correlate with system state.

### Implementation outline

**`CompositionActor.swift`** — refactor the render path. Sketch:

```swift
func compositeFrame(...) -> Result<CVPixelBuffer, CompositionError> {
    // ... existing composite graph building ...

    let destination = CIRenderDestination(pixelBuffer: output)
    destination.colorSpace = CGColorSpace(name: CGColorSpace.itur_709)

    do {
        let task = try ciContext.startTask(toRender: composited, to: destination)
        try task.waitUntilCompleted()
        return .success(output)
    } catch {
        return .failure(.renderFailed(error))
    }
}

private func rebuildContext() -> Bool {
    guard let device = MTLCreateSystemDefaultDevice(),
          let queue = device.makeCommandQueue() else {
        return false
    }
    ciContext = CIContext(
        mtlCommandQueue: queue,
        options: [.cacheIntermediates: false]
    )
    return true
}
```

Define a `CompositionError` enum: `.renderFailed(Error)`, `.rebuildFailed`, `.noOutputBuffer`.

**`RecordingActor.swift`** — the metronome loop handles the `Result`:

- `.success` → append to writer (existing path).
- `.failure(.renderFailed)` → log; invoke `compositionActor.rebuildContext()`; if rebuild succeeds, skip this frame and continue; if rebuild fails, propagate `.failure(.rebuildFailed)` upward.
- `.failure(.rebuildFailed)` → trigger clean stop via the existing `stopRecording` path with an error flag; surface a user-visible alert via the coordinator.

**Stall detection** — `waitUntilCompleted()` blocks indefinitely in principle. Wrap it in a dispatch-semaphore-based timeout (e.g. 2 seconds — generous for one frame) so we detect stalls before the GPU watchdog fires at ~5 seconds. On timeout, treat the same as a render error and trigger rebuild.

**Error surfacing** — add a publishing channel from `RecordingCoordinator` that the recording panel (or an alert) can observe for terminal recording errors. Minimal UI: a modal sheet or notification that says "Recording stopped due to a GPU error. Your recording is saved up to this point." This path is reached only if rebuild fails, which should be exceptionally rare after Phase 2.

### Exit criteria

- [ ] `CompositionActor.compositeFrame` uses `startTask(toRender:to:)` + `waitUntilCompleted`
- [ ] `CompositionError` is defined and returned as a `Result` from `compositeFrame`
- [ ] `CompositionActor` can rebuild its `CIContext` + `MTLCommandQueue` on demand via a `rebuildContext()` method
- [ ] `RecordingActor.metronomeLoop` handles render errors by attempting rebuild, and handles rebuild failures by triggering a clean recording stop
- [ ] A user-visible alert / notification surfaces when recording ends due to a terminal GPU error
- [ ] Rebuild events and terminal errors are logged with enough context to diagnose post-hoc
- [ ] **Induced failure test**: temporarily insert code that forces a render error once after 30 seconds — recording continues, logs show one rebuild event, final output is clean
- [ ] **Induced terminal failure test**: force two consecutive rebuild failures — recording stops cleanly, alert shows, local files are intact
- [ ] No regression on the happy path — a normal 10-minute recording has zero rebuild events and output matches Phase 2 quality

---

## Phase 4 — Camera adjustments (white balance & brightness)

### Goal

Give the user live controls for camera white balance and brightness that are reflected in every live preview and the composited output, while leaving `raw/camera.mp4` untouched (so the raw master file is always the sensor's natural output, available for re-processing later).

### Scope

- Two sliders in the popover: **White Balance** (temperature, Kelvin) and **Brightness** (exposure offset, EV stops). Reasonable ranges: 2500–10000K for WB, ±2 EV for brightness.
- A reset button that restores both to "camera default" (no adjustment).
- Adjustments apply to:
  - The popover camera preview
  - The PiP overlay window during recording
  - The composited HLS stream uploaded to the server
- Adjustments do **not** apply to:
  - `raw/camera.mp4` — the master file is always untouched
- Adjustments persist for the duration of the app session but reset on relaunch (no UserDefaults persistence — matches the existing no-persistence decision in the prior task 0A).

### Why this phase comes last

Camera adjustments build directly on the camera pipeline. After Phase 1 the camera buffers are properly tagged, after Phase 2 the encoder contention is gone, and after Phase 3 the compositor has error handling. Adding a new Core Image filter stage on top of a pipeline that's still unstable would make it impossible to tell whether a regression is from the new feature or from pre-existing instability.

### Implementation outline

**New model: `CameraAdjustments`**

```swift
struct CameraAdjustments: Equatable, Sendable {
    var temperature: CGFloat = 6500   // Kelvin
    var brightness: CGFloat = 0       // EV stops

    var isDefault: Bool { temperature == 6500 && brightness == 0 }
}
```

Lives on `RecordingCoordinator` as a published property. Updated from the slider UI. Snapshotted into `CompositionActor` via a dedicated setter.

**`CompositionActor` — new filter stage**

Add a private method `applyAdjustments(_ image: CIImage) -> CIImage` that applies:

- `CITemperatureAndTint` with target neutral derived from the `temperature` slider
- `CIExposureAdjust` with `inputEV` from the `brightness` slider

Call this stage on the `latestCameraImage` path **only** — after receiving a camera frame and before storing it for composition. This way:

- The composited HLS output gets adjusted frames (because it consumes from `latestCameraImage`).
- The PiP overlay window — which reads from the same adjusted image — also gets adjusted frames.
- The raw `camera.mp4` writer — which consumes the original `CMSampleBuffer` from capture, not the CIImage — is untouched.

Critically: the adjustments happen *after* capture buffers have been forked to the raw writer. This is already true structurally because the raw writer and the compositor are on different paths in `RecordingActor.handleCameraFrame` — just make sure the adjustment stage lives on the compositor side of that fork.

**Popover preview**

The current `CameraPreviewManager` uses `AVCaptureVideoPreviewLayer` (hardware path, no CIImage). Options:

1. Switch the preview to a CIImage-based renderer that reads the adjusted image from the compositor.
2. Apply the same adjustments via Core Animation filters (limited — CA doesn't expose temperature/tint the same way).
3. Render a CIImage preview only when adjustments are non-default, fall back to `AVCaptureVideoPreviewLayer` otherwise.

**Recommendation: option 1.** Simplicity and correctness outweigh the per-frame cost for a preview-sized image.

**PiP overlay window during recording**

`CameraOverlayWindow` already reads from the compositor's camera image path. As long as `applyAdjustments` runs before storage in `latestCameraImage`, this is free.

**Slider UI**

Add to `MenuView` (popover): a collapsible "Camera Adjustments" section visible only when a camera is selected. Two `Slider` controls + a "Reset" button. Updates push to `RecordingCoordinator.cameraAdjustments` which forwards to `CompositionActor.setAdjustments(...)`.

### Why apply to the composited HLS and not the raw camera.mp4

The raw camera file is the master. The user might later decide the adjustments were wrong, or want to re-composite with different adjustments, or use the raw footage for something else. Keeping it untouched preserves optionality. The composited HLS is the "quick share" output — adjustments there are what the user sees and shares immediately.

### Exit criteria

- [ ] `CameraAdjustments` model exists with `temperature` and `brightness` fields and an `isDefault` computed property
- [ ] `RecordingCoordinator.cameraAdjustments` is a published property
- [ ] Popover shows two sliders + reset button when a camera is selected; hidden otherwise
- [ ] Moving the white-balance slider visibly warms/cools the popover preview in real time
- [ ] Moving the brightness slider visibly brightens/darkens the popover preview in real time
- [ ] Reset button returns both sliders to default and the preview to unadjusted
- [ ] During a recording with non-default adjustments, the PiP overlay window reflects the adjustments live
- [ ] During a recording with non-default adjustments, the composited HLS stream uploaded to the server reflects the adjustments
- [ ] During a recording with non-default adjustments, `raw/camera.mp4` on disk is **identical** to what the camera sensor produced (verify by recording with heavy adjustment and confirming the raw file looks normal)
- [ ] Adjustments reset on app relaunch (no persistence)
- [ ] No regression on a recording with default adjustments — output matches Phase 3 quality

---

## Sequencing

Phases land in order, each committed independently. Each phase must leave the app in a shippable state so we can stop between phases if priorities change.

- **Phase 1** is low-risk and orthogonal to everything else. Land it first to get a cleaner baseline for Phase 2 testing.
- **Phase 2** is the main architectural fix and the one that unblocks stable recording on M2 Pro. Hardware-dependent — must be validated on real M2 Pro with the full 10-minute stress test before merging. If validation fails, fall back to a contingency (documented in Phase 2) before moving to Phase 3.
- **Phase 3** is defense-in-depth. Lower priority if Phase 2 proves rock-solid, but still recommended — the failure modes of any future hardware/environment shift are unpleasant without it.
- **Phase 4** builds new functionality on the stable foundation and is meaningful only if 1–3 land first.

After all four phases land, the scratchpad entries "GPU contention during recording with multiple concurrent encoders", "Camera feed metadata and colorspace handling", and "Camera Adjustments" are fully addressed.

## Follow-ups not in this task

- **Metronome skipping CIContext in single-source modes.** In `cameraOnly` mode the compositor currently runs a full render every metronome tick even though there's no screen to composite. An optimisation would skip the render and feed the camera frame directly to the HLS writer. Not in scope because (a) it's orthogonal to the contention problem and (b) Phase 1 makes the render much cheaper on its own. Worth revisiting if profiling shows it's still a meaningful cost after this task lands.
- **Broader camera testing matrix.** Phase 1 should include at least a couple of cameras (built-in FaceTime HD, USB ZV-1). A fuller matrix (Continuity Camera, Elgato Cam Link, generic USB webcam) is a future task — the core fix doesn't need it, but confidence in the metadata-tagging approach across hardware comes from breadth.
- **Recovery telemetry.** Phase 3's rebuild events would benefit from being counted and reported somewhere (debug menu counter, or a line in `recording.json`). Not critical path.
