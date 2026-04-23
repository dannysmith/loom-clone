# Task: Improving A/V sync accuracy for camera-only mode

Follow-up to `docs/tasks-done/task-2026-04-16-1-av-sync.md`. That task got the file-timestamp alignment within 1ms and removed every obvious recording-time drift source. The pipeline is solid for `screenOnly` and `screenAndCamera` — the PiP is small enough that sub-frame drift isn't that perceptible.

The problem that remains is `cameraOnly` "talking-head" recordings. At that scale, the residual 5–30ms mismatch reads as "uncanny valley" — the lips don't quite match the words. This task explores what can be done on top of the already-landed work to get camera-only recordings genuinely frame-accurate.

## Why residual error still exists

Three things are left even with hardware capture PTS on both sides:

1. **Mic and camera live on separate `AVCaptureSession` instances.** `MicrophoneCaptureManager.startCapture` and `CameraCaptureManager.startCapture` each build their own `AVCaptureSession`. Each session has its own `synchronizationClock` (the renamed `masterClock`). Apple's docs are explicit that this is a sync hazard — multi-session setups don't share a clock and the host-time mapping for each session can have slightly different slew/latency characteristics. A developer-forum thread shows ~1s offset between parallel sessions in pathological cases; in practice we're likely seeing tens of milliseconds, which is exactly our bug.
2. **"Hardware PTS" means different things on each side.** Camera PTS is frame-exposure-start (or frame-arrival-at-host for UVC cameras that don't honor the convention). Audio PTS is the first sample of an A/D buffer, after the device's built-in latency and any Core Audio safety offset. They both claim to be "hardware PTS" but they're pointing at asymmetric events in the real world. Core Audio exposes the corrections needed (`kAudioDevicePropertyLatency`, `kAudioDevicePropertySafetyOffset`, per-stream latency) — we just don't apply them.
3. **USB/UVC cameras (ZV-1, capture cards) are unknowns.** Their reported capture PTS may not reflect sensor exposure time at all, and AVFoundation can't tell us what convention the device is using. Any systematic per-device bias can only be measured, not computed.

So the residual error is mostly *systematic per-device bias* plus a *small amount of cross-session clock jitter* — not random drift.

## Current pipeline reminder

Full walkthrough in `docs/developer/recording-pipeline.md`. The bits that matter here:

- `app/LoomClone/Capture/CameraCaptureManager.swift` — own `AVCaptureSession`, camera-only.
- `app/LoomClone/Capture/MicrophoneCaptureManager.swift` — own `AVCaptureSession`, mic-only.
- `app/LoomClone/Pipeline/RecordingActor+Prepare.swift` — starts both sessions independently in `startCaptureSources`.
- `app/LoomClone/Pipeline/RecordingActor+FrameHandling.swift` — audio samples retimed to `(originalPTS - recordingStartTime) + primingOffset`. Video frames retimed to `(sourcePTS - recordingStartTime) + primingOffset`. `sourcePTS` is the source frame's capture PTS.
- `server/src/lib/derivatives.ts` — `sourceMp4Recipe` runs `ffmpeg -c copy` on the HLS playlist to build `source.mp4`. No re-encode, no sync correction.

## Solutions explored (research phase)

### 1. Single AVCaptureSession for camera + mic

Apple's documented fix for exactly this problem. Adding the mic input to the camera's `AVCaptureSession` makes both outputs timestamped against the session's `synchronizationClock`. No cross-session clock mapping, no drift from that layer.

Low-risk for us because:

- `AVCaptureAudioDataOutput` doesn't participate in `sessionPreset`, so the mic's native format is preserved — `audio.m4a` is byte-identical to today.
- `sessionPreset` is already overridden by the explicit `device.activeFormat = best` line in `CameraCaptureManager`, so the camera's video format isn't affected by adding a mic input.
- Screen capture is ScreenCaptureKit (separate framework) — untouched.

Real trade-offs:

- **Failure domains couple.** If the camera crashes, the mic session dies with it. Today they're independent. Probably fine (a mid-recording camera crash is already catastrophic), but worth calling out.
- **Mic-only recording paths need a branch.** When the user has selected a camera, mic and camera go into one session. When the user has selected "None" for the camera (`screenOnly` mode), the mic still needs its own session since there's no camera session to join. The `prepareRecording` path that selects devices already knows both selections at setup time, so the branch is straightforward.

### 2. HAL input latency compensation

Core Audio exposes per-device input latency via `kAudioDevicePropertyLatency` (input scope), `kAudioDevicePropertySafetyOffset` (input scope), per-stream latency, and buffer frame size. Sum them, divide by sample rate, and that's the systematic amount by which audio PTS is "late" relative to when sound actually hit the diaphragm.

Cap reads these values in their `estimate_input_latency` function. We currently don't. This is likely a meaningful chunk of the per-device bias on USB mics (commonly 10–20ms of reported hardware latency that we're not compensating for).

Implementation is an offset applied to `handleAudioSample`'s `relativePTS` calculation — fixed per mic device, queried once when the mic starts. It applies to the HLS writer path AND the `audio.m4a` raw writer path, since both are on the same timeline.

### 3. Camera's own microphone as sync reference

Proposed earlier in the conversation as a way to cross-correlate cross-device. In principle: if the camera has a built-in mic AND its audio PTS is sampled against the same session clock as the camera's video, then correlating camera-mic audio against main-mic audio tells you the inter-device offset.

Ruled out — two reasons:

1. **Camera may not have a mic.** Pro cameras via capture cards, some webcams, and cameras where the user doesn't want that mic enabled would all fall back to solution #4 anyway.
2. Once we have per-device waveform/motion calibration between the main mic and the camera's *video* stream, correlating with a second mic adds complexity without adding information — and only works for a subset of setups.

Not pursuing.

### 4. Per-device waveform↔motion calibration

Cap's open-source implementation is the reference here (`/Users/danny/dev/Cap/crates/audio/src/sync_analysis.rs`, `crates/recording/src/sync_calibration.rs`, local on this machine). Read these first. The algorithm:

1. **Audio transient detection.** Rolling 10ms RMS window, 2.5ms hop. Compare current frame's dB energy against a 9-frame average. Emit a transient when the current exceeds the average by ≥15dB AND current is ≥-30dB (absolute gate to ignore room-noise dynamics). Strength is the over-threshold amount, capped at 3x.
2. **Video motion detection.** Per-frame luma diff against the previous frame, subsampled every 16 pixels. Frame motion score is mean absolute luma delta / 255. Local maxima with score > 0.3 are "motion peaks".
3. **Correlation.** For each audio transient, find the nearest video peak within ±500ms, weighted by combined strength (audio × video).
4. **Confidence.** Weighted mean offset across events ≥0.5 confidence, then consistency factor `1 / (1 + stddev * 10)`. Discard if overall confidence <0.5.
5. **Persistence.** Store result keyed by `(camera_id, mic_id)`. On subsequent recordings, refine via exponential-decay weighted average of new + historical measurements.

This is passive and silent — it runs on every recording, improves over time, requires zero user interaction. The learned offset is applied to subsequent recordings at record time (as another adjustment to the audio PTS).

We can run this server-side during derivative generation, since the HLS segments converge there and we already have ffmpeg available. Per-device calibration is stored on the server (keyed by device IDs from the recording timeline, which already carries camera and mic `uniqueID`).

Application to camera-only is direct: motion during speech is mouth movement. It's the exact case the algorithm is tuned for.

### 5. Post-hoc ML sync detection (SyncNet / Synchformer / mouth-landmark correlation)

Researched but ranked lower. Summary:

- **SyncNet**: baseline ML model for AV sync. Temporal granularity is one video frame — at 30fps that's 33ms, which is at the coarse end of our problem. No CoreML port; you'd have to convert via ONNX.
- **Synchformer / SparseSync**: newer but actually worse for talking-head — their temporal bins are 200ms for in-the-wild scenes.
- **Apple Vision mouth-landmark cross-correlation**: `VNDetectFaceLandmarksRequest` gives lip-contour points at <10ms/frame on Apple Silicon. Cross-correlate mouth-open-area against audio energy, apply parabolic sub-sample interpolation, can reach 5–15ms accuracy. Same idea as solution #4 but with an explicit face signal rather than generic motion.

The Vision-landmark approach is strictly better than solution #4 for camera-only (face is always visible during a talking-head recording), but it's a bigger implementation effort and only works for that mode. Solution #4 handles all modes uniformly. Recommend solution #4 as the primary path and treat Vision-landmark refinement as a potential Phase 4 if camera-only is still off after #1 + #2 + #4 land.

## Recommended approach

Layered, in order of effort vs. payoff:

1. Single `AVCaptureSession` for mic + camera when both are selected. Apple-documented fix for the cross-session-clock bias. Probably moves the needle on its own.
2. HAL input latency compensation on the mic path. Removes the systematic "reported audio PTS is late by X ms" bias. Cheap, applies to all modes, no user interaction.
3. Per-device waveform/motion calibration. Passive, learned, per-device-pair. Refines over time. Covers anything #1 and #2 don't.
4. (Only if needed after the above) Vision-landmark mouth-motion cross-correlation as a camera-only refinement pass.

## Phases

### Phase 1: Single AVCaptureSession for mic + camera

Merge mic capture into the camera's session when both are selected. The mic still needs a standalone session path for screen-only recording.

- Refactor `CameraCaptureManager` so it can optionally accept a mic device at start time and add an `AVCaptureDeviceInput` + `AVCaptureAudioDataOutput` to its session.
- When the coordinator has selected both a camera and a mic, route both through the camera manager's session. When only a mic is selected (screen-only mode), keep `MicrophoneCaptureManager` as a standalone session.
- Plumb the session reference through so the recording actor can pull `synchronizationClock` if we want to anchor `recordingStartTime` against it explicitly (currently anchoring against the cached frame's capture PTS — still correct, but worth a look).
- No change to PTS stamping logic, no change to raw writers, no change to HLS output format.
- **Test**: camera-only 1-minute clap test, measure audio-to-video offset with ffprobe. Expectation: residual error drops from "10–30ms variable" to "≤5ms and stable across recordings".

### Phase 2: HAL input latency compensation

Query Core Audio once when the mic starts, apply a fixed offset to audio PTS.

- Add a helper (likely in `Pipeline/` or a new `Capture/AudioLatency.swift`) that, given an `AVCaptureDevice`, resolves the underlying `AudioDeviceID` and reads `kAudioDevicePropertyLatency` + `kAudioDevicePropertySafetyOffset` on the input scope, plus per-stream latency and buffer frame size, then returns total-latency-in-seconds.
- Cap's `compute_input_latency` in `crates/audio/src/latency.rs` is the reference. Same Core Audio properties, same formula.
- Wire into `handleAudioSample`: the existing `relativePTS = originalPTS - startTime` becomes `(originalPTS - startTime) - hardwareLatency`. Same offset applied on both the HLS writer path and the raw audio writer path.
- Store the queried latency in the recording timeline under inputs.microphone so we can diagnose later and so the server can see what was applied.
- **Test**: same clap test, compare against Phase 1 result. Expect the systematic bias to drop further — particularly on USB mics where the reported latency is largest.

### Phase 3: Per-device waveform/motion calibration (server-side)

Implement the Cap-style algorithm on the server, during derivative generation, keyed on `(camera.uniqueID, microphone.uniqueID)` from the recording timeline.

- New server-side module (probably `server/src/lib/sync-calibration.ts`) with three responsibilities: (a) extract audio samples and per-frame motion scores from the input, (b) run the transient/peak/correlation/confidence algorithm, (c) persist per-device-pair calibration in a new SQLite table.
- Schema: `device_sync_calibration` with `camera_id`, `mic_id`, `offset_ms`, `confidence`, `measurement_count`, `updated_at`. One row per pair.
- Invocation: new recipe in `derivatives.ts` (after `source.mp4` lands). Runs fire-and-forget. Reads the recording timeline to get camera/mic IDs (and to skip silently if either is missing).
- The algorithm update rule (Cap's exponential-decay blend) keeps the stored value from jumping around per-recording.
- **Application at record time**: at `prepareRecording`, the app fetches the current calibration for `(selectedCamera, selectedMicrophone)` from the server and applies it to audio PTS (adds to Phase 2's hardware-latency offset). First recording of a new device pair has no calibration → no offset applied → runs as Phase 1+2. Second and later recordings get the learned offset.
- Alternative if server-side fetch feels wrong for a recording-path: keep the calibration learned on the server but also return it in the `videos.complete` response, stashed in a per-pair `last_known_offsets.json` on the app side. Either works.
- **Test**: 10 consecutive clap-test recordings, verify the offset converges. Then switch cameras, verify it diverges per-pair correctly.

### Phase 4 (optional — only if still drifting)

Vision-framework mouth-motion detection as a camera-only refinement pass. Probably overkill — worth trying only after Phase 1–3 land and if talking-head recordings still read as slightly off.

- `VNDetectFaceLandmarksRequest` per frame gives lip-contour points.
- Mouth-open-area = polygon area of inner lip contour, per frame.
- Cross-correlate mouth-area signal against log-mel audio energy, parabolic sub-sample peak interpolation. Target accuracy 5–15ms.
- Runs server-side during derivative generation. Only applies to recordings where mode was `cameraOnly` (face is reliably visible).

## Edge cases

**Camera selected but camera device has no built-in mic.** Normal case for built-in FaceTime camera + external mic, or camera-via-capture-card + audio interface. No impact — Phase 1 puts both into the same session regardless of where the mic physically is. Phase 3 correlates against video motion, not camera-audio, so the camera's mic presence is irrelevant.

**"None" selected for camera.** Only `screenOnly` mode is available (enforced by `availableModes` in `RecordingCoordinator`). No camera session exists, so Phase 1 keeps mic on its standalone `AVCaptureSession` (current behavior). Phase 2 (HAL latency compensation) still applies — improves screen-recording sync too. Phase 3 has no camera motion to correlate against, so it skips (already handled in Cap's code: returns early if `camera_device_id` is None). No regression for screen-only recordings.

**"None" selected for mic.** No A/V sync problem exists — there's no audio track. All phases skip cleanly on a nil mic device.

**Camera source is a capture card / DSLR via HDMI.** No camera `uniqueID` instability expected (AVFoundation assigns stable IDs to capture cards). Phase 3 treats each `(camera_id, mic_id)` pair as its own calibration bucket, which handles this naturally — switching cameras mid-session or between sessions just uses a different calibration.

**User mid-recording mutes the mic or unplugs it.** Already handled by the existing pipeline. No new concern for this task.

**First recording of a new device pair.** No historical calibration → Phase 3 applies no offset at record time. The Phase 1 + Phase 2 improvements alone carry that first recording. After Phase 3 lands the offset learned from that first recording, subsequent recordings benefit.

**No face visible during a cameraOnly recording** (e.g. user covered the camera, pointed it at their desk). Phase 3's generic motion detection still works for other kinds of movement. Phase 4 (if we land it) would fall back to Phase 3's motion-score when Vision can't find a face.

**Continuity Camera / iPhone as webcam.** Transport type `continuityCaptureWireless` per Core Audio — Cap's transport detection specifically calls this out because wireless transports have much larger inherent latency. Phase 2's HAL query reads the device's reported latency regardless of transport, so it should already compensate. Worth an explicit test on an iPhone-as-webcam recording though, since Continuity latency is large enough that mistakes would be visible.

## Open questions

1. **Does Phase 1 alone close the gap?** If moving to a single `AVCaptureSession` drops the residual error below the perceptibility threshold, Phases 2–3 become polish rather than necessity. Worth landing Phase 1 as a self-contained change and measuring before committing to the rest.
2. **Server-side vs client-side calibration storage.** Is it better for the server to own the calibration table (applied on recording-complete, returned as a hint for subsequent recordings) or for the app to own it locally (applied at record time, server never sees it)? Server-side feels right because (a) the server is already doing derivative work, (b) learning happens post-recording, (c) the app is single-user so a round-trip on every prepare is fine.
3. **Scope of motion analysis for Phase 3.** Running the correlation on the full `source.mp4` is expensive for long recordings. Cap bounds it to audio-transient windows only. Probably adopt that same bound.
4. **Anchoring against `synchronizationClock` explicitly.** Once mic and camera share a session (Phase 1), is it worth changing `commitRecording`'s anchor from "latest cached frame's capturePTS" to `CMClockGetTime(session.synchronizationClock)` with the same maxAnchorAge safety? Needs a careful read to confirm the two are equivalent when the session is shared — they probably are, but explicit is better than accidental.

## References

- **Cap's calibration source** (local): `/Users/danny/dev/Cap/crates/audio/src/sync_analysis.rs`, `/Users/danny/dev/Cap/crates/recording/src/sync_calibration.rs`, `/Users/danny/dev/Cap/crates/audio/src/latency.rs`. Read these before implementing Phase 2 or Phase 3 — they're the working reference.
- **Previous task**: `docs/tasks-done/task-2026-04-16-1-av-sync.md` — what we already fixed and how.
- **Pipeline doc**: `docs/developer/recording-pipeline.md` — architecture refresher.
- **Apple docs**: `AVCaptureSession.synchronizationClock`, `AVCaptureMultiCamSession`, WWDC 2019 Session 249 (Multi-Camera Capture) — Apple's own guidance on shared-session sync.
- **Apple developer forum thread 742022** — real-world example of multi-session sync drift.
- **Core Audio property keys**: `kAudioDevicePropertyLatency`, `kAudioDevicePropertySafetyOffset`, `kAudioDevicePropertyBufferFrameSize`, `kAudioStreamPropertyLatency` — the Phase 2 inputs.
