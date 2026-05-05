# Task: Source failure detection, notification, and recovery

https://github.com/dannysmith/loom-clone/issues/6

The recording pipeline has robust handling for GPU/composition failures (detect → rebuild → escalate) and network/upload failures (retry → heal). But capture source failures — camera disconnect, mic death, screen capture errors — are completely invisible. If a source dies mid-recording, frames/samples silently stop arriving. The user has no indication anything is wrong until they stop and review the footage.

This task adds detection for source failures, surfaces warnings in the floating toolbar, and implements automatic audio failover when the shared camera+mic session dies (the single most dangerous failure mode, since it silently kills audio).

Related: dannysmith/loom-clone#18 tracks mid-recording source *switching* (deferred — not in scope here).

## Current state

### What's handled

- **GPU/composition failures**: 2s stall timeout → CIContext rebuild → terminal error escalation → coordinator shows alert and stops recording. Timeline events for every stage.
- **Raw writer failures**: Detected at segment boundaries via `checkRawWriterStatus()`, logged in timeline, recording continues via HLS path. `RawStreamWriter.finish()` returns `FinishResult` with error details.
- **Upload/network failures**: Exponential backoff, `NWPathMonitor` pause/resume, `HealAgent` post-stop recovery.

### What's not handled

- **Screen capture (SCStream)**: `didStopWithError` delegate logs to console only. No callback to RecordingActor, no timeline event. If SCStream dies, the single-slot cache retains the last frame and the metronome emits frozen pixels indefinitely.
- **Camera (AVCaptureSession)**: No `AVCaptureSessionRuntimeErrorNotification` or `InterruptionNotification` subscribed. If the session dies, the FIFO drains and the metronome starts skipping ticks (cameraOnly) or loses the PiP (screenAndCamera). No detection, no alert.
- **Microphone (AVCaptureSession)**: Same — no error notifications. Audio just goes silent. The 1s pre-commit arrival check is the only guard, and it continues recording even on timeout.
- **Shared session coupling**: When camera + mic share a session (for AV sync), camera disconnect kills the entire session — both video AND audio stop. The standalone mic is still running but only feeds `audio.m4a`, not HLS. Result: camera disconnect = silent audio death in the composited output.
- **HLS writer health**: Unlike raw writers (polled at segment boundaries), `WriterActor` never checks `writer.status`. If it enters `.failed` mid-recording, frames are silently dropped.
- **No frame freshness checks**: A 10-second-old screen frame is treated identically to a fresh one.
- **No silence detection**: If the mic delivers zero-amplitude audio (or stops entirely), nothing notices.

### Failure mode matrix (current behaviour)

| Source lost | screenOnly | screenAndCamera | cameraOnly |
|---|---|---|---|
| Screen | Video frozen, no alert | Screen frozen, PiP continues, no alert | N/A |
| Camera | N/A | PiP disappears, screen continues, no alert | Video stalls (metronome skips), no alert |
| Mic/audio | Silent audio, no alert | Silent audio, no alert | Silent audio, no alert |
| Shared session dies | N/A | Screen OK, PiP gone, audio silently dies | Video stalls, audio silently dies |

## Design decisions

### No camera restart on failure

When the camera session dies, we do NOT attempt to restart it. Reasons:

- Physical disconnect (the most common scenario): there's nothing to restart until the device is plugged back in. Auto-detecting the device returning and restarting is mid-recording source switching (deferred to #18).
- Session errors without physical disconnect are rare, and restarting is risky (the error might recur, session startup blocks).
- Camera loss is visible — the user can see the PiP vanish or the camera-only view freeze. Audio loss is *invisible* — that's the dangerous one worth auto-recovering.

The failover is: detect camera/session death → fail over audio → warn the user → let them decide whether to stop.

### Silence detection: two tiers

**Tier 1 — "Mic is dead"**: No audio samples arriving at all, or pure digital silence (near-zero RMS, below -80dBFS) for >5 seconds. This is unambiguous — a working mic with a human nearby always has some room noise.

**Tier 2 — "Something might be wrong"**: Audio arriving but at a flat, low-variance noise floor for an extended period. The signal characteristic: speech has high dynamic range (silence punctuated by bursts). A disconnected XLR or broken preamp gives a *consistent* noise floor with very little amplitude variance. If RMS stays in a narrow band (~3dB range) without any transient rising above the noise floor for >30 seconds, that's suspicious. This warning is **dismissible** — the user taps it and it doesn't reappear for the rest of the recording. This prevents false positives during long silent demos.

### Black frame detection: camera only

Screen capture can legitimately show dark content (terminal, dark mode IDE). Camera being all-black means something is wrong (lens cap, dead sensor, broken capture card). Only detect black frames from the camera source.

### Warning UI

Warnings appear as small pill-shaped banners immediately above the floating toolbar. They persist until the condition resolves or the user dismisses them. Multiple warnings can stack vertically (e.g. camera lost + audio silent simultaneously). Warnings should be colour-coded by severity:

- **Critical** (red-tinted): source completely lost, data at risk. Examples: screen capture died in screenOnly, camera died in cameraOnly, HLS writer failed.
- **Warning** (amber-tinted): degraded but still recording something useful. Examples: PiP lost in screenAndCamera, tier 1 mic silence, tier 2 mic suspicion, camera black frames.

### Health watchdog thresholds

- **Screen**: no new `.complete` frame for >2 seconds. SCStream on an idle desktop still sends frames at the configured minimum interval, so absence means the stream is broken, not just "nothing changed on screen."
- **Camera**: FIFO empty for >1 second. Camera delivers at 30fps steady state, so 1 second of nothing is 30 missed frames.
- **Mic**: no audio sample for >2 seconds. Audio arrives in tiny continuous chunks when active.

## Phases

### Phase 1: Detection and notification infrastructure

The foundation: detect when sources fail, surface it to the user, and record it for diagnostics.

**Capture manager error propagation:**

1. `ScreenCaptureManager`: Add an `onStreamError: (@Sendable (Error) -> Void)?` callback. Wire `stream(_:didStopWithError:)` to fire it instead of just logging.
2. `CameraCaptureManager`: Subscribe to `AVCaptureSession.runtimeErrorNotification` and `AVCaptureSession.wasInterruptedNotification` on the session. Add `onSessionError: (@Sendable (Error) -> Void)?` and `onSessionInterrupted: (@Sendable (AVCaptureSession.InterruptionReason) -> Void)?` callbacks.
3. `MicrophoneCaptureManager`: Same as camera — subscribe to session notifications, add error/interruption callbacks.

**Health watchdogs in RecordingActor:**

Add a periodic health check (piggyback on metronome ticks or run a separate lightweight timer) that tracks:

- `lastScreenFrameTime`: updated in `handleScreenFrame`. If `now - lastScreenFrameTime > 2s` and mode uses screen → fire screen-stale event.
- `lastCameraFrameTime`: updated in `handleCameraFrame`. If `now - lastCameraFrameTime > 1s` and mode uses camera → fire camera-stale event.
- `lastAudioSampleTime`: updated in `handleAudioSample` / `handleMicAudioSample`. If `now - lastAudioSampleTime > 2s` → fire audio-missing event.

Each watchdog fires once on first detection (deduped), resets if the source resumes delivering.

**HLS writer health check:**

Add a `checkWriterStatus()` call in `WriterActor` (or poll from RecordingActor at segment boundaries, matching the raw writer pattern). If `writer.status == .failed`, escalate as a terminal error — HLS writer failure is far more severe than a raw writer failure.

**Timeline events:**

New event types: `source.screen.failed`, `source.camera.failed`, `source.audio.failed`, `source.screen.stale`, `source.camera.stale`, `source.audio.missing`, `writer.hls.failed`.

**Warning state on RecordingCoordinator:**

Add an observable `activeWarnings: [RecordingWarning]` array to the coordinator. RecordingActor fires a callback when warning state changes. The coordinator publishes it for UI.

**Floating toolbar warning UI:**

A new `WarningBannerView` above the toolbar. Each warning is a small pill with icon + short text (e.g. "Camera disconnected", "No audio detected"). Styled with the severity colour coding (red for critical, amber for warning). Tappable to dismiss (for dismissible warnings like tier 2 silence). Multiple warnings stack vertically.

### Phase 2: Shared session audio failover

The critical recovery: when the camera's shared session dies, automatically route HLS audio from the standalone mic.

**Detection:**

RecordingActor receives the camera session error callback (from Phase 1). When `sharedSessionAudioActive` is true and the shared session dies:

1. Set `sharedSessionAudioActive = false`.
2. The standalone mic (already running, already delivering to `handleMicAudioSample`) now routes through `handleAudioSample` → HLS writer, because `sharedSessionAudioActive` is false.
3. Record a `source.audio.failover` timeline event marking the switch point.
4. Surface toolbar warning: "Camera disconnected — audio continues via mic" (amber, not critical — audio is saved).

**PTS considerations:**

After failover, the standalone mic's clock is not on the shared session's `synchronizationClock`. This reintroduces the 5-30ms cross-session jitter that the shared session was designed to eliminate. This is acceptable for a degraded mode — better than silence. The PTS values should still be monotonic since both clocks derive from host time and we compute relative to `recordingStartTime`.

**Mode-specific severity after shared session death:**

- `screenAndCamera` → screen continues, PiP disappears, audio fails over. Amber warning. Recording is still useful.
- `cameraOnly` → video stalls (metronome has nothing to emit), audio fails over. This is effectively "audio-only recording" until stop. Critical warning — the user almost certainly wants to stop.

### Phase 3: Content quality warnings

Lower priority — these catch quality problems rather than data-loss problems.

**Mic silence detection (tier 1 — dead mic):**

Track RMS amplitude of incoming audio buffers over a rolling window (~1 second). If RMS stays below -80dBFS for 5 consecutive seconds, fire a `source.audio.silence` warning. This catches muted system inputs and dead devices that still technically "deliver" zero samples.

**Mic silence detection (tier 2 — suspicious signal):**

Track both RMS level and RMS variance over a longer rolling window (~5 seconds). If the signal stays in a narrow amplitude band (~3dB range) without any transient above the noise floor for 30 consecutive seconds, fire a `source.audio.suspicious` warning. This catches disconnected XLR cables, broken preamps, and similar faults that produce flat noise. This warning is **dismissible** — once dismissed it does not reappear for the remainder of the recording.

**Camera black frame detection:**

Sample the luminance of camera frames periodically (not every frame — every Nth frame or once per second). If average luminance is below a threshold (close to zero) for >3 consecutive samples, fire a `source.camera.black` warning. This catches lens caps, dead sensors, and capture cards sending black. Only applies to camera frames, not screen capture.

### Phase 4: Update Docs, Tests & Cleanup

1. Are there any tests we should add at all here which we haven't already?
2. Is there any cleanup or refactoring we should do to ensure the code we've touched is clean and nice.
3. Update recording-pipeline.md to reflect the current state and ensure our evergreen dev doc contains info on all this as needed. Also check any other developer docs, CLAUDE.md or AGENTS.md to see if they need updating for correctness.

## Files likely touched

| Concern | File |
|---|---|
| Screen error propagation | `Capture/ScreenCaptureManager.swift` |
| Camera/mic error propagation | `Capture/CameraCaptureManager.swift`, `Capture/MicrophoneCaptureManager.swift` |
| Health watchdogs, failover logic | `Pipeline/RecordingActor.swift`, `Pipeline/RecordingActor+FrameHandling.swift` |
| HLS writer health | `Pipeline/WriterActor.swift` |
| Timeline event types | `Models/RecordingTimeline.swift` |
| Warning state, UI bridge | `App/RecordingCoordinator.swift` |
| Warning banner UI | `UI/` (new view) |
| Silence/black frame analysis | `Pipeline/RecordingActor+FrameHandling.swift` or new extension |
