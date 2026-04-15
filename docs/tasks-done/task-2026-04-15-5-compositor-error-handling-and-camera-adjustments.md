# Task 5 — Compositor Error Handling & Camera Adjustments

Two related improvements to the macOS recording pipeline. Both were originally planned as later phases of task-0A and then split out so they didn't interleave with the M2 Pro failure-mode investigation; that investigation is now closed (see `docs/m2-pro-video-pipeline-failures.md`) and this task picks up where it left off.

**Phase 1** plumbs proper error handling into `CompositionActor` so render failures surface as structured results instead of silently dropped frames, and adds a teardown-and-rebuild recovery path for poisoned `CIContext` state.

**Phase 2** adds live white-balance and brightness sliders for the camera feed, applied to the composited HLS stream and all live previews but NOT to the raw `camera.mp4` master file.

## Why these two phases are in the same task

Phase 1 (error handling) and Phase 2 (camera adjustments) are related in two ways:

- Both touch `CompositionActor` as their primary surface. Doing them together avoids two separate refactoring passes on that file.
- Phase 2 adds a new Core Image filter stage to the compositor, which is exactly the kind of change that benefits from Phase 1's error handling landing first. If we add a per-frame filter and it occasionally misbehaves, we want the structured error path to catch it rather than silently dropping frames.

They don't have to be implemented in the same PR, but Phase 1 should land before Phase 2 in the same task.

---

## Phase 1 — Plumb error handling into the compositor

### Goal

Replace the void-return `ciContext.render(to:bounds:colorSpace:)` in `CompositionActor.compositeFrame` with the task-based `startTask(toRender:to:)` API so we get structured error feedback, can detect stalls with our own timeout, and can attempt recovery before the OS watchdog fires. Add a teardown-and-rebuild recovery path for poisoned `CIContext` state, and surface terminal failures to the user instead of silently degrading.

### Why this matters

The 2026-04-11 failure modes 2 and 4 taught us that silent CIContext failures on M2 Pro can escalate into kernel-level system hangs within seconds. The existing code in `CompositionActor.swift:114` uses the void-return `render` method — it has no return value, no error object, no task handle, and no way for the metronome to know a render failed until the next render also fails (which, in both incident cases, was too late).

Failure mode 3 (the 4K preset H.264 cascade) was userspace-recoverable but still resulted in thousands of `kIOGPUCommandBufferCallback*` errors flooding the log, a 5-second screen freeze, and a degraded recording. With structured error handling, we could have caught the first GPU error and either stopped the recording cleanly or rebuilt the CIContext mid-recording.

Failure mode 4 (the 1440p preset IOGPUFamily deadlock) was **not** userspace-recoverable — by the time the user-space GPU watchdog would have fired, the kernel was already wedged. Structured error handling wouldn't have caught failure mode 4 in the userspace pipeline, but a stall-detection timeout (wrapping `waitUntilCompleted`) might have given us a few seconds of warning before WindowServer's watchdog killed the system. Worth having either way.

### Relevant research

The M2 Pro video-pipeline research pass has shipped at `docs/research/11-m2-pro-video-pipeline-deep-dive.md`. Consult it when implementing the rebuild path, particularly:

- **`CIContext` initialisation patterns** — `CIContext(mtlDevice:)` vs `CIContext(mtlCommandQueue:)` and their resource-allocation / error-reporting differences. The rebuild path should use whichever is more robust.
- **`CIRenderDestination` configuration** — `.alphaMode`, `.isFlipped`, and related properties can affect whether CoreImage uses an intermediate buffer.
- **Stall detection** — check whether any Metal/CoreImage APIs beyond `waitUntilCompleted` are useful for detecting in-progress-command-buffer state.

If the research doc doesn't address a specific question, proceed with the implementation outline below.

### Behaviour after this lands

- `CompositionActor.compositeFrame` uses `startTask(toRender:to:)` and checks the returned `CIRenderTask` for errors via `waitUntilCompleted`, with a wall-clock timeout to catch stalls.
- On a render error, the compositor tears down and rebuilds its `CIContext` and underlying `MTLCommandQueue` before returning to the metronome. The next frame is rendered against the fresh context.
- If rebuild also fails (the Metal device itself is wedged), the compositor signals `RecordingActor` to end the recording cleanly with a user-visible error ("Recording stopped: GPU became unresponsive. Your recording has been saved up to this point.") rather than silently producing a corrupted recording.
- Recovery events are logged so we can correlate them with system state in future incident analysis. Logs include: event name, time since recording start, number of consecutive render failures, whether rebuild succeeded.

### Implementation outline

**`CompositionActor.swift`** — refactor the render path. Sketch (may be adjusted based on findings in `docs/research/11-m2-pro-video-pipeline-deep-dive.md`):

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

Define a `CompositionError` enum: `.renderFailed(Error)`, `.rebuildFailed`, `.noOutputBuffer`, `.stallTimeout`.

**`RecordingActor.swift`** — the metronome loop handles the `Result`:

- `.success` → append to writer (existing path).
- `.failure(.renderFailed)` → log; invoke `compositionActor.rebuildContext()`; if rebuild succeeds, skip this frame and continue; if rebuild fails, propagate `.failure(.rebuildFailed)` upward.
- `.failure(.rebuildFailed)` → trigger clean stop via the existing `stopRecording` path with an error flag; surface a user-visible alert via the coordinator.
- `.failure(.stallTimeout)` → treat as a render error; attempt rebuild.

**Stall detection** — `waitUntilCompleted()` blocks indefinitely in principle. Wrap it in a dispatch-semaphore-based timeout (e.g. 2 seconds — generous for one frame but well below the ~5 s GPU watchdog threshold). On timeout, return `.failure(.stallTimeout)`. **Note: this will not catch failure mode 4** (kernel-level deadlock happens before command submission, so neither the timeout nor the GPU watchdog sees anything to time out on). It's still worth implementing for the cases where it does help.

**Error surfacing** — add a publishing channel from `RecordingCoordinator` that the recording panel (or an alert) can observe for terminal recording errors. Minimal UI: a modal sheet or notification that says "Recording stopped due to a GPU error. Your recording is saved up to this point." This path is reached only if rebuild fails.

**Recovery telemetry** — add a `renderErrorCount` and `rebuildSuccessCount` to `RecordingTimeline` that captures the recording.json output. Zero-value in normal operation; non-zero values give us post-hoc visibility if we hit this path.

### Validation strategy

**Default to validating in the main app, not the harness.** The 2026-04-14 task-2 close-out documented that the harness's synthetic Tier 3 runs do not reliably reproduce the failure modes the main app sees under real capture (the harness's real-capture path is itself broken — see `app/TestHarness/README.md` § "Active limitations"). Iterating on the main app is the more reliable signal here. Only fall back to the harness if a specific change starts producing main-app failures we can't diagnose in place.

What "validate in the main app" means concretely for Phase 1:

1. **Happy path**: a normal 1080p recording end-to-end produces a clean HLS stream, no `kIOGPUCommandBufferCallback*` errors in `log stream`, segment cadence stable. Compare segment durations in `recording.json` against pre-change baseline.
2. **Induced render failure**: temporarily inject a `CIRenderTask` error after N frames via a debug-only test hook in `CompositionActor` (e.g. a `#if DEBUG` injection point that returns a synthetic error from the next render). Confirm the metronome receives the failure, `rebuildContext()` runs, and recording continues with the rebuilt context. Remove the hook after validation, or guard it behind a build flag that's off by default.
3. **Induced terminal failure**: force two consecutive rebuild failures via the same hook and confirm recording stops cleanly, `stopRecording` completes, the local safety-net files are intact, and a user-visible alert appears.
4. **Stall detection**: inject a 3-second artificial delay in the render path and confirm the timeout fires, the result is `.stallTimeout`, and rebuild is attempted.

The injection hooks (2/3/4) are a small amount of throwaway scaffolding — they can be deleted once the change has been exercised, or kept behind a debug flag if useful for future regression checks.

### Exit criteria

- [ ] `CompositionActor.compositeFrame` uses `startTask(toRender:to:)` + `waitUntilCompleted` wrapped in a stall timeout
- [ ] `CompositionError` is defined and returned as a `Result` from `compositeFrame`
- [ ] `CompositionActor` can rebuild its `CIContext` + `MTLCommandQueue` on demand via a `rebuildContext()` method
- [ ] `RecordingActor.metronomeLoop` handles render errors by attempting rebuild, and handles rebuild failures by triggering a clean recording stop
- [ ] A user-visible alert / notification surfaces when recording ends due to a terminal GPU error
- [ ] Rebuild events and terminal errors are logged and appear in `recording.json` as telemetry counters
- [ ] **Main-app induced render failure** passes (recording continues through a single injected error, one rebuild event logged, final output is clean)
- [ ] **Main-app induced terminal failure** passes (two consecutive rebuild failures → clean stop, alert shown, local files intact)
- [ ] **Main-app stall detection** passes (artificial 3s delay → `.stallTimeout` returned → rebuild attempted)
- [ ] No regression on the happy path — a normal 1080p recording matches the pre-change baseline (segment cadence, byte sizes within noise)
- [ ] No new `log stream` GPU errors appear during a normal 1080p recording

---

## Phase 2 — Camera adjustments (white balance & brightness)

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
- Adjustments persist for the duration of the app session but reset on relaunch (no UserDefaults persistence — matches the existing no-persistence decision in the prior task 0A for source selection).

### Why this phase comes second in this task

Camera adjustments add a new per-frame Core Image filter stage on the compositor's camera path. Phase 1 of this task makes the compositor safer to modify — render errors now surface as structured results, a broken filter stage would produce catchable errors instead of silent frame drops, and the rebuild path gives us a safety net. Doing Phase 2 on top of Phase 1 is strictly safer than doing it on the current compositor code.

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

Call this stage on the `latestCameraImage` path **only** — after receiving a camera frame and before storing it for composition. This gives adjusted frames to the composited HLS output, because that path reads from `latestCameraImage`. The raw `camera.mp4` writer consumes the original `CMSampleBuffer` from capture, not the CIImage, so it stays untouched. This fork is already structurally correct in `RecordingActor.handleCameraFrame` — just make sure the adjustment stage lives on the compositor side of it.

**The popover preview and the on-screen overlay both consume raw camera CMSampleBuffers, NOT the compositor's CIImage path.**

This is a deliberate latency optimisation in the existing code:

- `CameraPreviewManager` runs its own lightweight `AVCaptureSession` and exposes raw `CMSampleBuffer`s via an `onSampleBuffer` callback that feeds an `AVSampleBufferDisplayLayer` (`CameraPreviewView` → `CameraPreviewLayerView`). Hardware path, no per-frame CPU work.
- `CameraOverlayWindow` is fed via `RecordingActor.setOverlayCallback`, which fires from the camera capture queue *before* the actor hop, with the raw `CMSampleBuffer`. Same `AVSampleBufferDisplayLayer` underneath.

Both bypass the compositor entirely. So Phase 2 needs an explicit second filter application path on the preview/overlay side. Two options:

1. **Filter into a new sample buffer, feed that to the existing `AVSampleBufferDisplayLayer`.** Render the adjusted CIImage into a CVPixelBuffer (preview-sized for the popover; native for the overlay), wrap it back into a CMSampleBuffer, enqueue. Keeps the existing display layer architecture; adds per-frame CIContext work on the preview/overlay paths.
2. **Do nothing for preview/overlay; only apply adjustments on the recording path.** The popover preview and on-screen overlay would show the unadjusted feed; the recording would have adjustments. Clearly wrong from a UX perspective ("what you see is what you get" is the whole point of the sliders).

**Recommendation: option 1, applied to BOTH the popover preview and the overlay.** Each path gets its own small CIContext (or shares one via a singleton helper) sized to its display surface. Per-frame cost is small at preview/overlay sizes (240×240 to ~360×202).

A practical sub-decision: when `CameraAdjustments.isDefault == true`, fast-path back to enqueueing the original sample buffer. Avoids paying the filter cost when the user hasn't touched the sliders.

**Slider UI**

Add to `MenuView` (popover): a collapsible "Camera Adjustments" section visible only when a camera is selected. Two `Slider` controls + a "Reset" button. Updates push to `RecordingCoordinator.cameraAdjustments` which forwards to `CompositionActor.setAdjustments(...)`.

### Performance consideration

Adding a new filter stage to the camera path has a measurable GPU cost per frame. The pipeline is now stable under the task-1 tunings (see `docs/m2-pro-video-pipeline-failures.md` § Resolution) — before merging, do a real recording at 1440p with both filters at non-default settings and confirm: no new `kIOGPUCommandBufferCallback*` errors in `log stream`, segment cadence in `recording.json` stays around 4 s ± 50 ms, no visible UI stutter. If anything regresses, fall back to the harness for finer-grained bisection.

### Why apply to the composited HLS and not the raw camera.mp4

The raw camera file is the master. The user might later decide the adjustments were wrong, or want to re-composite with different adjustments, or use the raw footage for something else. Keeping it untouched preserves optionality. The composited HLS is the "quick share" output — adjustments there are what the user sees and shares immediately.

### Exit criteria

- [ ] `CameraAdjustments` model exists with `temperature` and `brightness` fields and an `isDefault` computed property
- [ ] `RecordingCoordinator.cameraAdjustments` is a published property
- [ ] Popover shows two sliders + reset button when a camera is selected; hidden otherwise
- [ ] Moving the white-balance slider visibly warms/cools the popover preview in real time
- [ ] Moving the brightness slider visibly brightens/darkens the popover preview in real time
- [ ] Reset button returns both sliders to default and the preview to unadjusted (and fast-paths back to the unfiltered sample buffer)
- [ ] During a recording with non-default adjustments, the PiP overlay window reflects the adjustments live
- [ ] During a recording with non-default adjustments, the composited HLS stream uploaded to the server reflects the adjustments
- [ ] During a recording with non-default adjustments, `raw/camera.mp4` on disk is **identical** to what the camera sensor produced (verify by recording with heavy adjustment and confirming the raw file looks normal)
- [ ] Adjustments reset on app relaunch (no persistence)
- [ ] **Main-app validation**: a real 1440p recording with both adjustments at non-default values shows no new `kIOGPUCommandBufferCallback*` errors in `log stream` and segment cadence in `recording.json` stays around 4 s ± 50 ms

---

## Sequencing

1. **Read the context** documents in the order specified in the briefing below.
2. **Implement Phase 1** (compositor error handling) directly in the main app. Validate the happy path with a normal 1080p recording, then exercise induced render / terminal / stall scenarios via the debug-only injection hooks described above. Only fall back to the harness if a problem appears that's awkward to bisect in-place.
3. **Commit Phase 1.**
4. **Implement Phase 2** (camera adjustments) directly in the main app. Validate as described in Phase 2's exit criteria. Same harness-as-fallback policy.
5. **Commit Phase 2.**
6. **Update** `docs/tasks-todo/task-0-scratchpad.md` — the "Camera Adjustments" entry (if it still exists) should be marked as done or removed.
7. **Update** `docs/m2-pro-video-pipeline-failures.md` if any new observations come out of validation during this task.

Each phase must leave the app in a shippable state so we can stop between phases if priorities change.

## Follow-ups not in this task

- **Metronome skipping CIContext in single-source modes.** In `cameraOnly` mode the compositor currently runs a full render every metronome tick even though there's no screen to composite. An optimisation would skip the render and feed the camera frame directly to the HLS writer. Not in scope here because it's orthogonal to both error handling and adjustments.
- **Broader camera testing matrix.** Testing with multiple cameras (built-in FaceTime HD, USB ZV-1, Continuity Camera, Elgato Cam Link, generic USB webcams) is a future task.
- **Persistent camera adjustment defaults.** If the user wants their WB/brightness adjustments to survive app relaunches, we'd add UserDefaults persistence. Deliberately excluded here to match the existing no-persistence stance on source selection.
- **Exposure compensation via `AVCaptureDevice.exposureTargetBias`** as an alternative to `CIExposureAdjust`. Uses the device's hardware ISP instead of a Core Image filter. Potentially better quality and lower GPU cost, but only works on devices that support it (built-in cameras do, USB devices generally don't). Could be a future improvement once the harness confirms the Core Image path is stable.

## Briefing for the implementing session

If running this task with a subagent, the briefing should include:

1. **Read these files in this order:**
   - `docs/m2-pro-video-pipeline-failures.md` (full — required context for understanding why this task is careful about the compositor, and the Resolution section for the current pipeline state)
   - `docs/research/11-m2-pro-video-pipeline-deep-dive.md` (research pass — may inform Phase 1's rebuild path and CIContext/destination configuration)
   - `app/TestHarness/README.md` (how to use the harness for validating changes; note the "Active limitations" section about real-capture)
   - `docs/tasks-todo/task-5-compositor-error-handling-and-camera-adjustments.md` (this doc, in full)
   - `app/LoomClone/Pipeline/CompositionActor.swift` (the file being modified in both phases)
   - `app/LoomClone/Pipeline/RecordingActor.swift` (touched by Phase 1 for error propagation)
   - `app/LoomClone/App/RecordingCoordinator.swift` (touched by Phase 2 for adjustments state)
   - `app/LoomClone/UI/MenuView.swift` (touched by Phase 2 for slider UI)

2. **Default to validating in the main app.** The harness is a fallback for when a specific change resists in-place diagnosis — not the first stop. The 2026-04-14 task-2 close-out documented that the harness's synthetic Tier 3 runs do not reliably reproduce the failure modes the main app sees under real capture, and the harness's real-capture path itself has an unresolved delivery bug.

3. **Commit in sequence**: Phase 1 lands first, validated and committed, before Phase 2 begins. Do not batch them into one PR.

An example prompt for the subagent:

> Implement task-5 (compositor error handling and camera adjustments) in the LoomClone codebase. Read the context files in the order specified in the briefing section. Implement Phase 1 (compositor error handling) first, validating in the main app via the debug injection hooks described in the doc. Commit Phase 1. Then implement Phase 2 (camera adjustments), again validating in the main app. Use the test harness only as a fallback for problems that are hard to bisect in place. Do not modify the recording pipeline in ways that aren't covered by this task.
