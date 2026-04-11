# Task 0D — Compositor Error Handling & Camera Adjustments

Two related improvements to the macOS recording pipeline that were originally planned as Phase 3 and Phase 4 of task-0A, then split into this separate task when task-0A got paused pending deeper investigation of the M2 Pro video pipeline failures.

**Phase 1** (originally task-0A Phase 3) plumbs proper error handling into `CompositionActor` so render failures surface as structured results instead of silently dropped frames, and adds a teardown-and-rebuild recovery path for poisoned `CIContext` state.

**Phase 2** (originally task-0A Phase 4) adds live white-balance and brightness sliders for the camera feed, applied to the composited HLS stream and all live previews but NOT to the raw `camera.mp4` master file.

## Prerequisites

This task is **blocked** until the following are true:

1. **`docs/m2-pro-video-pipeline-failures.md` has been read** by whoever picks this up. Understanding the failure modes is load-bearing for doing this work safely.
2. **Task-0B is complete or substantially complete.** The research deliverable (`docs/research/11-m2-pro-video-pipeline-deep-dive.md` or similar) must exist and be reviewed. Its findings may change how Phase 1 of this task is implemented — for example, if task-0B discovers that a specific `CIContext` initialisation pattern or Metal device configuration avoids the failure modes we've seen, Phase 1 should incorporate that.
3. **Task-0C is complete or substantially complete.** The isolation test harness at `app/TestHarness/` must exist and be usable. Any changes this task makes to `CompositionActor` should be validated in the harness BEFORE being tested in the main app.
4. **Task-0A's Phase 2b situation has been resolved.** The `main` branch currently includes committed Phase 2b code (the 1440p preset) that reproduces failure mode 4. Before this task can start, task-0A's Phase 2b must be either:
   - Reverted (restore 1080p as the max preset), OR
   - Replaced with a fix validated via task-0C's harness
   - In either case, recording at any available preset on the `main` branch must be safe before this task begins.

If any of the above are not true, stop and escalate. Do not start this task in a half-prepared state.

## Context

Read these documents in this order before starting:

1. `docs/m2-pro-video-pipeline-failures.md` — all four failure modes, especially failure modes 3 and 4 (the ones that informed why Phase 1 of this task matters more than we originally thought).
2. `docs/tasks-todo/task-0A-encoder-contention-and-camera-pipeline.md` — the precursor task. Especially its `Current status` block at the top and the Phase 2b section, so you understand what state the pipeline is in when this task begins.
3. `docs/research/11-m2-pro-video-pipeline-deep-dive.md` (or whatever task-0B's deliverable is called) — may contain findings that change Phase 1's implementation approach.
4. `docs/tasks-todo/task-0C-isolation-test-harness.md` — so you know how to validate changes in the harness.
5. `docs/requirements.md` — product requirements, especially the camera-related Nice-to-Haves section.

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

### Dependencies on task-0B findings

Task-0B is researching `VTCompressionSession` and `CIContext` configuration knobs we're not currently using. Some of what it finds may affect Phase 1's implementation:

- **Alternative CIContext initialisation patterns.** If task-0B finds that `CIContext(mtlDevice:)` behaves differently from `CIContext(mtlCommandQueue:)` in resource allocation or error reporting, the rebuild path in Phase 1 should use whichever gives better behaviour.
- **Different `CIRenderDestination` configurations.** If task-0B finds that setting `.alphaMode`, `.isFlipped`, or other properties on `CIRenderDestination` affects whether CoreImage uses an intermediate buffer, we should apply those in Phase 1's refactored path.
- **Stall detection mechanisms we don't know about.** If task-0B surfaces a Metal or CoreImage API for detecting in-progress-command-buffer state (beyond what `waitUntilCompleted` gives), use it.

If task-0B's deliverable doesn't address any of these, proceed with the implementation outline below.

### Behaviour after this lands

- `CompositionActor.compositeFrame` uses `startTask(toRender:to:)` and checks the returned `CIRenderTask` for errors via `waitUntilCompleted`, with a wall-clock timeout to catch stalls.
- On a render error, the compositor tears down and rebuilds its `CIContext` and underlying `MTLCommandQueue` before returning to the metronome. The next frame is rendered against the fresh context.
- If rebuild also fails (the Metal device itself is wedged), the compositor signals `RecordingActor` to end the recording cleanly with a user-visible error ("Recording stopped: GPU became unresponsive. Your recording has been saved up to this point.") rather than silently producing a corrupted recording.
- Recovery events are logged so we can correlate them with system state in future incident analysis. Logs include: event name, time since recording start, number of consecutive render failures, whether rebuild succeeded.

### Implementation outline

**`CompositionActor.swift`** — refactor the render path. Sketch (may be adjusted based on task-0B findings):

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

### Testing in the harness

Before landing in the main app, use task-0C's harness to validate:

1. **Happy path**: the refactored render path produces the same output as the current one for a known-good 1080p recording. Byte-compare HLS segments if possible.
2. **Induced render failure**: add a harness test that injects a `CIRenderTask` error after N frames (via a special CIContext subclass or a test hook) and confirms:
   - The error is returned up to the metronome
   - `rebuildContext()` is called
   - Recording continues
   - Output is clean
3. **Induced terminal failure**: force two consecutive rebuild failures and confirm:
   - Recording stops cleanly
   - `stopRecording` completes
   - Local files are intact
   - An error is published to the coordinator
4. **Stall detection**: inject a 3-second artificial delay in the render path and confirm the timeout fires, the result is `.stallTimeout`, and rebuild is attempted.

These tests should all be in the harness, not in the main LoomClone app, so we can iterate on them without risking a hang in the real recording pipeline.

### Exit criteria

- [ ] `CompositionActor.compositeFrame` uses `startTask(toRender:to:)` + `waitUntilCompleted` wrapped in a stall timeout
- [ ] `CompositionError` is defined and returned as a `Result` from `compositeFrame`
- [ ] `CompositionActor` can rebuild its `CIContext` + `MTLCommandQueue` on demand via a `rebuildContext()` method
- [ ] `RecordingActor.metronomeLoop` handles render errors by attempting rebuild, and handles rebuild failures by triggering a clean recording stop
- [ ] A user-visible alert / notification surfaces when recording ends due to a terminal GPU error
- [ ] Rebuild events and terminal errors are logged and appear in `recording.json` as telemetry counters
- [ ] **Harness: induced render failure test** passes (recording continues through a single injected error, one rebuild event logged, final output is clean)
- [ ] **Harness: induced terminal failure test** passes (two consecutive rebuild failures → clean stop, alert shown, local files intact)
- [ ] **Harness: stall detection test** passes (artificial 3s delay → `.stallTimeout` returned → rebuild attempted)
- [ ] No regression on the happy path — a normal 1080p recording in the main app matches Phase 2's validated output
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

Call this stage on the `latestCameraImage` path **only** — after receiving a camera frame and before storing it for composition. This way:

- The composited HLS output gets adjusted frames (because it consumes from `latestCameraImage`)
- The PiP overlay window — which reads from the same adjusted image — also gets adjusted frames
- The raw `camera.mp4` writer — which consumes the original `CMSampleBuffer` from capture, not the CIImage — is untouched

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

### Performance consideration carried over from task-0A

Adding a new filter stage to the camera path has a measurable GPU cost per frame. After the failures documented in `docs/m2-pro-video-pipeline-failures.md`, we are justifiably cautious about adding GPU work to the compositor. Before this phase ships, run the change through task-0C's harness at the same configurations that were validated in task-0A Phase 2 (especially 1080p preset with all writers active). Confirm no new GPU errors, no change in segment cadence, no increased IOSurface pressure. If any of those regress, back off and investigate.

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
- [ ] **Harness validation**: a Tier 3 run of the harness with adjustments applied shows no new GPU errors, no segment cadence regression, and no IOSurface pressure increase compared to the baseline without adjustments

---

## Sequencing

1. **Verify prerequisites** are all true (see the Prerequisites section at the top). If any are not, stop and escalate.
2. **Read the context** documents in the order specified.
3. **Implement Phase 1** (compositor error handling). Validate in the harness before touching the main app.
4. **Commit Phase 1**. Integrate into the main app. Run a normal 1080p recording to confirm happy path.
5. **Implement Phase 2** (camera adjustments). Validate in the harness. Confirm no regression versus Phase 1 baseline.
6. **Commit Phase 2**.
7. **Update** `docs/tasks-todo/task-0-scratchpad.md` — the "Camera Adjustments" entry (if it still exists) should be marked as done or removed.
8. **Update** `docs/m2-pro-video-pipeline-failures.md` if any new observations came out of harness runs during this task.

Each phase must leave the app in a shippable state so we can stop between phases if priorities change.

## Follow-ups not in this task

- **Metronome skipping CIContext in single-source modes.** In `cameraOnly` mode the compositor currently runs a full render every metronome tick even though there's no screen to composite. An optimisation would skip the render and feed the camera frame directly to the HLS writer. Not in scope here because it's orthogonal to both error handling and adjustments.
- **Broader camera testing matrix.** Testing with multiple cameras (built-in FaceTime HD, USB ZV-1, Continuity Camera, Elgato Cam Link, generic USB webcams) is a future task.
- **Persistent camera adjustment defaults.** If the user wants their WB/brightness adjustments to survive app relaunches, we'd add UserDefaults persistence. Deliberately excluded here to match the existing no-persistence stance on source selection.
- **Exposure compensation via `AVCaptureDevice.exposureTargetBias`** as an alternative to `CIExposureAdjust`. Uses the device's hardware ISP instead of a Core Image filter. Potentially better quality and lower GPU cost, but only works on devices that support it (built-in cameras do, USB devices generally don't). Could be a future improvement once the harness confirms the Core Image path is stable.

## Briefing for the implementing session

If running this task with a subagent, the briefing should include:

1. **Read these files in this order:**
   - `docs/m2-pro-video-pipeline-failures.md` (full — required context for understanding why this task is careful about the compositor)
   - `docs/tasks-todo/task-0A-encoder-contention-and-camera-pipeline.md` (especially the Current status block and the Phase 2b section — so you know what state the pipeline is in)
   - `docs/research/11-m2-pro-video-pipeline-deep-dive.md` or equivalent task-0B output (may contain findings that change Phase 1's approach)
   - `docs/tasks-todo/task-0C-isolation-test-harness.md` and the harness code at `app/TestHarness/` (so you know how to validate changes)
   - `docs/tasks-todo/task-0D-compositor-error-handling-and-camera-adjustments.md` (this doc, in full)
   - `app/LoomClone/Pipeline/CompositionActor.swift` (the file being modified in both phases)
   - `app/LoomClone/Pipeline/RecordingActor.swift` (touched by Phase 1 for error propagation)
   - `app/LoomClone/App/RecordingCoordinator.swift` (touched by Phase 2 for adjustments state)
   - `app/LoomClone/UI/MenuView.swift` (touched by Phase 2 for slider UI)

2. **Verify prerequisites** explicitly before starting. In particular: confirm `main` is safe to record on (no Phase 2b landmine), and the harness exists and can run the validation tests.

3. **Do not start with the main app.** Phase 1's first work should be implementing the refactored render path **in the harness** as a test configuration. Once it's validated there, bring it into the main app.

4. **Commit in sequence**: Phase 1 lands first, validated and committed, before Phase 2 begins. Do not batch them into one PR.

An example prompt for the subagent:

> Implement task-0D (compositor error handling and camera adjustments) in the LoomClone codebase. Before starting, verify the prerequisites at the top of `docs/tasks-todo/task-0D-compositor-error-handling-and-camera-adjustments.md` are all true — especially that task-0B research is complete, task-0C harness is usable, and task-0A's Phase 2b situation has been resolved so recording on `main` is safe. Read the context files in the order specified. Implement Phase 1 (compositor error handling) first, validating each change in the isolation harness before touching the main app. Commit Phase 1. Then implement Phase 2 (camera adjustments), again validating in the harness. Do not modify the recording pipeline in ways that aren't covered by this task.
