# Task: Improving A/V sync accuracy for camera-only mode

Follow-up to `docs/tasks-done/task-2026-04-16-1-av-sync.md`. That task got the file-timestamp alignment within 1ms and removed every obvious recording-time drift source. The pipeline is solid for `screenOnly` and `screenAndCamera` — the PiP is small enough that sub-frame drift isn't that perceptible.

The problem that remains is `cameraOnly` "talking-head" recordings. At that scale, the residual 5-30ms mismatch reads as "uncanny valley" — the lips don't quite match the words. This task explores what can be done on top of the already-landed work to get camera-only recordings genuinely frame-accurate.

## Why residual error still exists

Three things are left even with hardware capture PTS on both sides:

1. **Mic and camera live on separate `AVCaptureSession` instances.** `MicrophoneCaptureManager.startCapture` and `CameraCaptureManager.startCapture` each build their own `AVCaptureSession`. Each session has its own `synchronizationClock` (the renamed `masterClock`). Apple's docs are explicit that this is a sync hazard — multi-session setups don't share a clock and the host-time mapping for each session can have slightly different slew/latency characteristics. A developer-forum thread shows ~1s offset between parallel sessions in pathological cases; in practice we're likely seeing tens of milliseconds, which is exactly our bug.
2. **"Hardware PTS" means different things on each side.** Camera PTS is frame-exposure-start (or frame-arrival-at-host for UVC cameras that don't honour the convention). Audio PTS is the first sample of an A/D buffer, after the device's built-in latency and any Core Audio safety offset. They both claim to be "hardware PTS" but they're pointing at asymmetric events in the real world. Core Audio exposes the corrections needed (`kAudioDevicePropertyLatency`, `kAudioDevicePropertySafetyOffset`, per-stream latency) — we just don't apply them.
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

**Confirmed: no meaningful downsides.** Research and review of Apple's SDK headers, developer forums, and comparable apps (OBS, Panopto, Cap) confirm:

- **Performance:** Adding an `AVCaptureAudioDataOutput` + audio device input to the camera's session does not degrade video frame delivery. Audio and video run on separate internal pipelines within the session. `alwaysDiscardsLateVideoFrames = true` remains effective. This is the standard configuration Apple documents and expects.
- **Audio quality:** Audio sample buffers from `AVCaptureAudioDataOutput` are delivered in the same format (sample rate, bit depth, channels, buffer size) regardless of whether the session also has video. `sessionPreset` does not affect audio output format. When `device.activeFormat` is set explicitly (which our code does), the session flips to `.inputPriority` and stops managing formats entirely.
- **`synchronizationClock` guarantee:** The SDK header states: *"All capture output sample buffer timestamps are on the masterClock timebase."* With a shared session, audio and video PTS values are directly comparable with sub-millisecond residual offset (hardware-level ADC vs sensor readout). This eliminates the 5-30ms cross-session jitter entirely.
- **Failure domain coupling:** If the camera crashes/disconnects mid-recording, the shared session dies and the mic goes with it. This is acceptable: a mid-recording camera loss is already catastrophic. `AVCaptureSessionRuntimeErrorNotification` is available for future recovery work but not required. Mitigated further by our decision to keep a standalone mic session running in parallel (see Phase 1).

### 2. HAL input latency compensation

Core Audio exposes per-device input latency via four properties, all in frames (divide by sample rate for seconds):

| Property | Scope | What it represents |
|---|---|---|
| `kAudioDevicePropertyLatency` | Input | Device-level ADC latency |
| `kAudioDevicePropertySafetyOffset` | Input | HAL safety margin to prevent glitching |
| `kAudioStreamPropertyLatency` | Per input stream | Per-stream pipeline latency |
| `kAudioDevicePropertyBufferFrameSize` | Global | IO buffer size |

Total latency formula (matching Cap's implementation in `crates/audio/src/latency.rs`):

```
device_frames = kAudioDevicePropertyLatency + kAudioDevicePropertySafetyOffset + max(stream latency across input streams)
total_latency = (device_frames / sample_rate) + (buffer_frame_size / sample_rate)
```

**Bridging AVCaptureDevice to AudioDeviceID:** `AVCaptureDevice.uniqueID` for audio devices is the same string as Core Audio's device UID. Use `kAudioHardwarePropertyTranslateUIDToDevice` with the UID as a qualifier to get the `AudioDeviceID` needed for property queries.

**Direction of offset:** The audio PTS represents when audio data was delivered to the host. The actual acoustic event happened `L` seconds *earlier*. To align audio with video (where PTS reflects sensor exposure time), subtract `L` from audio PTS: `correctedPTS = originalPTS - totalInputLatency`.

**Over-correction risk:** It's possible AVFoundation already partially compensates for HAL-reported latency internally when constructing the sample buffer's PTS. If so, subtracting the full HAL value would overshoot. Phase 0 will establish baseline values for our devices; Phase 2 will apply the correction and verify with clap tests. If clap tests show audio moving to the *wrong* side of video, we know AVFoundation was already compensating and we back off.

Typical values: ~2-5ms for built-in mics, ~10-20ms for USB mics, ~80-200ms for Bluetooth (AirPods). Cap enforces a 120ms minimum floor for Bluetooth devices.

### 3. Camera's own microphone as sync reference

Proposed earlier in the conversation as a way to cross-correlate cross-device. In principle: if the camera has a built-in mic AND its audio PTS is sampled against the same session clock as the camera's video, then correlating camera-mic audio against main-mic audio tells you the inter-device offset.

Ruled out — two reasons:

1. **Camera may not have a mic.** Pro cameras via capture cards, some webcams, and cameras where the user doesn't want that mic enabled would all fall back to other solutions anyway.
2. Once we have per-device waveform/motion calibration between the main mic and the camera's *video* stream, correlating with a second mic adds complexity without adding information — and only works for a subset of setups.

Not pursuing.

### 4. Per-device waveform/motion calibration

Cap's open-source implementation is the reference here (`/Users/danny/dev/Cap/crates/audio/src/sync_analysis.rs`, `crates/recording/src/sync_calibration.rs`, local on this machine). The algorithm correlates audio energy transients with video motion peaks to infer the systematic offset between audio and video for a given device pair. It's passive, runs on every recording, refines over time via exponential-decay weighted average, and requires zero user interaction. The learned offset is applied at record time as a PTS adjustment.

**Not pursuing for now.** Our assessment is that this is only worth building if Phase 1 + Phase 2 don't close the gap. The approach has genuine value — it's device-independent and corrects for any source of offset, including ones that can't be computed from first principles (like capture cards that lie about their latency). But if we know the device latency from HAL properties and have eliminated cross-session clock jitter, the remaining error is likely below the perceptibility threshold. Cap implements this because they don't use a single shared session — their Rust capture layer uses separate audio and video pipelines, so they have more residual error to correct for. See "Deferred options" at the end for more detail.

### 5. Post-hoc ML sync detection (SyncNet / Synchformer / mouth-landmark correlation)

Researched but ranked lower. SyncNet's temporal granularity is one video frame (33ms at 30fps), which is at the coarse end of our problem. The Apple Vision mouth-landmark approach (`VNDetectFaceLandmarksRequest`) is more promising for camera-only but is a larger implementation effort. Not pursuing unless Phase 1 + Phase 2 fail to close the gap.

## Recommended approach

Two-phase fix, preceded by a diagnostic:

0. **HAL latency diagnostic** — query Core Audio input latency properties for our actual mic devices. Read-only experiment that informs Phase 2.
1. **Single `AVCaptureSession` for mic + camera** — eliminates the cross-session clock jitter that is the primary source of the 5-30ms error. Also embeds audio in `camera.mp4` and maintains an independent `audio.m4a` via the standalone mic session.
2. **HAL input latency compensation** — removes the systematic "audio PTS is late by X ms" bias. Applied to the composited/HLS path's audio. Informed by Phase 0 measurements.

## Implementation Pkan - Phases

### Phase 0: HAL latency diagnostic exploration

Query Core Audio's HAL input latency properties for each available mic device and print the results. This is a read-only diagnostic — no recording pipeline changes. The goal is to understand what values we're working with before committing to Phase 2.

**What to query:** The four properties listed in § "Solutions explored > HAL input latency compensation" above. For each mic device: resolve `AVCaptureDevice.uniqueID` → `AudioDeviceID` via `kAudioHardwarePropertyTranslateUIDToDevice`, then query device latency, safety offset, stream latency, and buffer frame size. Compute total input latency in milliseconds.

**Devices to test:** MacBook built-in mic, Blue Yeti (USB), AirPods (Bluetooth). Caldigit TS4 3.5mm audio input if convenient but not required.

**Reference algorithm (from Cap's `crates/audio/src/latency.rs`, `compute_input_latency`):**

```
Given: device (AudioDeviceID), sample_rate, fallback_buffer_frames

1. transport_type = query kAudioDevicePropertyTransportType (global scope)
   → classify: Bluetooth/BLE → wireless, ContinuityCapture → continuity, else → wired

2. device_latency_frames = query kAudioDevicePropertyLatency (INPUT scope)     [default 0]
   safety_offset_frames  = query kAudioDevicePropertySafetyOffset (INPUT scope) [default 0]
   buffer_frames         = query kAudioDevicePropertyBufferFrameSize (global)   [default fallback]
   stream_latency_frames = max(kAudioStreamPropertyLatency across input streams) [default 0]

   To get input streams: query kAudioDevicePropertyStreams (INPUT scope),
   then for each stream query kAudioStreamPropertyLatency. Take the max.

3. effective_rate = device's nominal sample rate (or fallback to sample_rate)

4. device_latency_secs = (device_latency_frames + safety_offset_frames + stream_latency_frames) / effective_rate
   buffer_latency_secs = buffer_frames / effective_rate
   total_latency_secs  = device_latency_secs + buffer_latency_secs
```

All property queries use `AudioObjectGetPropertyData` with `AudioObjectPropertyAddress`. Scope is `kAudioObjectPropertyScopeInput` for device/safety/stream properties, `kAudioObjectPropertyScopeGlobal` for buffer size. Element is `kAudioObjectPropertyElementMain` throughout.

Cap also detects transport type to enforce minimum latency floors for wireless devices (~120ms for Bluetooth, similar for Continuity Camera). Worth logging transport type in the diagnostic output.

**Output:** Table of values per device. This informs whether Phase 2 is worth doing (USB mic showing 15ms = yes, built-in mic showing 2ms = maybe, AirPods showing 150ms = definitely yes for Bluetooth).

**Implementation:** This can be a standalone function added to the app and called from `prepareRecording` with results printed to console, or a throwaway test — whatever is quickest. The important thing is seeing real numbers from our actual hardware.

### Phase 1: Single AVCaptureSession + audio in camera.mp4

The main change. Eliminate cross-session clock jitter by putting camera and mic in one `AVCaptureSession` when both are selected. Also embed audio in `camera.mp4` for better manual recovery. Keep the standalone mic session running for `audio.m4a`.

**Audio routing architecture:**

When camera + mic are both selected:
- **CameraCaptureManager** starts a shared session containing both camera video input/output AND mic audio input/output. The session's `synchronizationClock` applies to both.
  - Camera video → `handleCameraFrame` (as today)
  - Mic audio (from shared session) → composited/HLS writer + camera.mp4 raw writer (audio track)
- **MicrophoneCaptureManager** ALSO starts with its own standalone session, as it does today.
  - Audio → `audio.m4a` raw writer ONLY. Does NOT feed the composited/HLS path.
- The standalone mic session code is unchanged from today. It always runs when a mic is selected.

When no camera, mic selected (screen-only mode):
- **MicrophoneCaptureManager** starts standalone session.
  - Audio → composited/HLS writer + `audio.m4a` raw writer (current behaviour, unchanged).

This means `MicrophoneCaptureManager` itself doesn't change at all. It always starts, always runs, always delivers samples. What changes is where its output gets routed — and `CameraCaptureManager` gains an optional audio capture capability.

**Key changes:**

1. **CameraCaptureManager** gains the ability to accept an optional mic `AVCaptureDevice` at start time. When provided, it adds an `AVCaptureDeviceInput` (audio) + `AVCaptureAudioDataOutput` to its session and delivers audio samples via a new callback (e.g. `onAudioSample`). When not provided, audio-only behaviour is unchanged.
2. **Camera raw writer** (`camera.mp4`) gains an audio track. Currently `RawStreamWriter` with kind `.videoH264` is video-only. Extend it to support video+audio for the camera case. Audio samples from the shared session go to both the HLS writer and this raw writer.
3. **RecordingActor's audio routing** in `wireCaptureCallbacks` / `handleAudioSample` branches on whether a camera is present: if yes, HLS audio comes from the shared session; if no, HLS audio comes from the standalone mic (current path). The standalone mic always feeds the raw `audio.m4a` writer regardless.
4. **Writer warm-up ordering** must be preserved. The VideoToolbox tunings from `docs/tasks-done/task-2026-04-14-1-videotoolbox-best-practice-tunings.md` require writers to warm up before SCStream opens. The camera raw writer (now with audio) is still constructed after `cameraCapture.startCapture()` returns (it needs the delivered dims), which is fine — the important thing is that the HLS writer and screen/audio raw writers warm up in the quiet window before SCStream, as they do today.

**What doesn't change:**
- ScreenCaptureKit path — completely independent, untouched.
- The composited/HLS output format (H.264 video + AAC audio) — identical.
- The metronome, compositor, PTS stamping logic — identical.
- `sessionPreset` handling — audio doesn't participate; explicit `activeFormat` still works.
- All VideoToolbox tunings (`RealTime = false`, `AllowFrameReordering = false`, `MaxFrameDelayCount = 2`, hardware encoder requirement) — these are on the writers, not the capture sessions.

**Why keep the standalone mic session when camera is present?** Two reasons: (a) the standalone session code has to exist anyway for the no-camera case, so running it always is zero additional code complexity; (b) if the camera session crashes, `screen.mov` survives (ScreenCaptureKit) and `audio.m4a` survives (standalone session), giving enough material for a manual FinalCut recovery of screen+voice content — which in many screen-share-heavy recordings is the important part.

Running two sessions with the same mic device simultaneously is fine on macOS — audio devices are multi-client by design (unlike cameras, which are exclusive-access). The performance cost is negligible.

**Test:** Camera-only 1-minute clap test, measure audio-to-video offset with ffprobe. Expectation: residual error drops from 5-30ms variable to sub-5ms stable.

### Phase 2: HAL input latency compensation

Query Core Audio once when the mic starts, apply a fixed offset to audio PTS in the composited/HLS path.

**What to do:**

1. Add a helper that, given an `AVCaptureDevice` (audio), resolves the underlying `AudioDeviceID` and queries the four HAL properties, returning total input latency in seconds. Cap's `compute_input_latency` in `crates/audio/src/latency.rs` is the reference implementation — same properties, same formula.
2. Call this helper once during `prepareRecording` for the selected mic device.
3. Apply the offset to audio PTS in the composited/HLS path: `correctedPTS = originalPTS - hardwareLatency`. This adjustment sits alongside the existing `relativePTS = originalPTS - recordingStartTime` calculation in `handleAudioSample` (or its equivalent after Phase 1's routing changes). Apply to the HLS writer path only — the raw `audio.m4a` doesn't need it since it's a safety-net file for manual recovery.
4. Store the queried latency value in the recording timeline under `inputs.microphone` so we can diagnose later and verify it against clap-test measurements.

**Whether to apply this to the camera.mp4 audio track too:** Probably yes, since the camera.mp4 is meant to be a properly-synced A/V file. But verify with a clap test first — if Phase 1's shared session already makes the camera.mp4 sync tight, the HAL correction on that path may not be needed.

**Informed by Phase 0:** If the diagnostic shows that the relevant devices (built-in mic, Yeti) report small latency values (< 3ms), the practical benefit of this phase is marginal and it could be deferred. If AirPods show 100ms+, that alone justifies this phase. The Phase 0 data drives the decision.

**Test:** Same clap test as Phase 1, compare results. If audio-to-video offset improved further, keep it. If it got worse (audio now ahead of video where it was behind before), AVFoundation was already compensating and we should back off — either reduce the correction or remove it.

## Edge cases

**Camera selected but camera device has no built-in mic.** Normal case for built-in FaceTime camera + external mic, or camera-via-capture-card + audio interface. No impact — Phase 1 puts both into the same session regardless of where the mic physically is.

**"None" selected for camera.** Only `screenOnly` mode is available (enforced by `availableModes` in `RecordingCoordinator`). No camera session exists. `MicrophoneCaptureManager` runs standalone, feeds both the HLS writer and `audio.m4a` — current behaviour, unchanged. Phase 2 (HAL latency compensation) still applies.

**"None" selected for mic.** No A/V sync problem exists — there's no audio track. Camera session is video-only. No `audio.m4a` or `camera.mp4` audio track. All phases skip cleanly.

**Camera source is a capture card / DSLR via HDMI.** The shared session treats whatever `AVCaptureDevice` is selected as the camera. `synchronizationClock` still applies — the session handles the clock domain conversion internally regardless of device type.

**User mid-recording mutes or unplugs the mic.** Already handled by the existing pipeline. If the mic is on the shared session and the mic device is disconnected, the session posts `AVCaptureSessionRuntimeErrorNotification`. The camera side dies too (coupled failure domain). The standalone mic session also loses its device. `screen.mov` survives via ScreenCaptureKit. This is the expected degradation path.

**Camera disconnected mid-recording.** Shared session dies — camera.mp4 and HLS audio stop. `screen.mov` (ScreenCaptureKit) and `audio.m4a` (standalone mic session) survive. Enough for manual recovery of screen+voice content.

**First recording after Phase 1 lands.** No per-device calibration needed — the `synchronizationClock` improvement is structural, not learned. Every recording benefits immediately.

**Continuity Camera / iPhone as webcam.** Transport type `continuityCaptureWireless`. Wireless transports have larger inherent latency. Phase 2's HAL query reads the device's reported latency regardless of transport. Worth an explicit clap test on an iPhone-as-webcam recording since Continuity latency is large enough that mistakes would be visible.

## Deferred/Disgarded options

These are not planned for this task. Noted here for context in case Phase 1 + Phase 2 don't fully close the gap.

**Per-device waveform/motion calibration (Cap-style).** Passive algorithm that correlates audio energy transients with video motion peaks to infer per-device-pair offset. Advantages: device-independent, self-refining. Disadvantages: significant implementation effort (server-side analysis, new DB table, client-side fetch at record time), and the problem it solves (systematic per-device bias) should largely be addressed by Phase 1 (eliminates cross-session jitter) and Phase 2 (removes known HAL-reported bias). Cap's reference implementation is at `/Users/danny/dev/Cap/crates/audio/src/sync_analysis.rs` and `/Users/danny/dev/Cap/crates/recording/src/sync_calibration.rs` if needed later.

**Vision-framework mouth-motion detection.** `VNDetectFaceLandmarksRequest` gives lip-contour points at <10ms/frame on Apple Silicon. Cross-correlate mouth-open-area against audio energy with parabolic sub-sample interpolation. Strictly better than generic motion correlation for camera-only but much heavier to implement. Only relevant if talking-head recordings still read as slightly off after everything else lands.

## Open questions

1. **Does Phase 1 alone close the gap?** If moving to a single `AVCaptureSession` drops the residual error below the perceptibility threshold, Phase 2 becomes polish rather than necessity. Worth landing Phase 1 as a self-contained change and measuring before committing to Phase 2.
2. **Does AVFoundation already partially compensate for HAL-reported latency?** If Phase 2 makes sync worse rather than better, that's the answer — back off. The clap test is the arbiter.
3. **Anchoring against `synchronizationClock` explicitly.** Once mic and camera share a session (Phase 1), is it worth changing `commitRecording`'s anchor from "latest cached frame's capturePTS" to `CMClockGetTime(session.synchronizationClock)` with the same maxAnchorAge safety? They're probably equivalent when the session is shared, but explicit is better than accidental. Worth a careful read during implementation.

## References

- **Previous task**: `docs/tasks-done/task-2026-04-16-1-av-sync.md` — what we already fixed and how. Phases 1-5 of the original sync work.
- **VideoToolbox tunings task**: `docs/tasks-done/task-2026-04-14-1-videotoolbox-best-practice-tunings.md` — writer tunings (`RealTime`, `AllowFrameReordering`, `MaxFrameDelayCount`, hardware encoder requirement, warm-up ordering) that must be preserved during Phase 1's restructuring.
- **Pipeline doc**: `docs/developer/recording-pipeline.md` — architecture refresher.
- **Audio post-processing doc**: `docs/developer/audio-post-processing.md` — server-side audio chain (highpass → arnndn → loudnorm). Not directly relevant to sync but documents what happens to audio after recording.
- **Cap's latency source** (local): `/Users/danny/dev/Cap/crates/audio/src/latency.rs` — working reference for Phase 0 and Phase 2.
- **Cap's sync calibration source** (local): `/Users/danny/dev/Cap/crates/audio/src/sync_analysis.rs`, `/Users/danny/dev/Cap/crates/recording/src/sync_calibration.rs` — reference for deferred waveform calibration option.
- **Apple docs**: `AVCaptureSession.synchronizationClock`, WWDC 2019 Session 249 (Multi-Camera Capture) — Apple's own guidance on shared-session sync.
- **Core Audio property keys**: `kAudioDevicePropertyLatency`, `kAudioDevicePropertySafetyOffset`, `kAudioDevicePropertyBufferFrameSize`, `kAudioStreamPropertyLatency` — the Phase 0/2 inputs.
- **Core Audio device bridge**: `kAudioHardwarePropertyTranslateUIDToDevice` — converts `AVCaptureDevice.uniqueID` to `AudioDeviceID` for HAL property queries.
