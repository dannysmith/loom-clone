# Recording Pipeline

How the macOS app captures, composites, encodes, and streams video. For what happens once segments reach the server, see [Streaming & Healing](streaming-and-healing.md).

## Architecture at a glance

Four actors, each owning one concern, orchestrated by a coordinator on the main actor:

```
┌─────────────┐     ┌─────────────────────┐     ┌──────────────┐
│   Screen    │     │  Camera + Mic       │     │  Microphone  │
│  Capture    │     │  (shared session)   │     │  (standalone)│
└──────┬──────┘     └──────┬──────────────┘     └──────┬───────┘
       │                   │ video + audio              │ audio
       ▼                   ▼                            ▼
┌───────────────────────────────────────────────────────────────┐
│            RecordingActor (orchestrator)                       │
│   frame caches · metronome · recording clock · pause          │
│   raw safety-net writers (screen.mov, camera.mp4, audio.m4a)  │
└───────────┬───────────────────────────┬───────────────────────┘
            │                           │
            ▼                           ▼
┌───────────────────┐          ┌────────────────┐
│ CompositionActor  │          │  WriterActor   │
│ (Metal / CIContext│──frame──▶│ (AVAssetWriter │
│  rendering)       │          │  HLS fMP4)     │
└───────────────────┘          └───────┬────────┘
                                       │ segments
                                       ▼
                               ┌────────────────┐
                               │  UploadActor   │
                               │ (HTTP PUT to   │
                               │  server)       │
                               └────────────────┘
```

The **RecordingCoordinator** (main actor, SwiftUI-observable) owns the UI state machine, device enumeration, preview lifecycle, and drives start/stop/pause/resume by calling into RecordingActor.

## The recording clock

All timestamps in the system derive from hardware capture PTS — never wall clock. This is what keeps audio and video in sync despite capture pipeline latency.

- **Anchor:** At commit time (T=0), `recordingStartTime` is set to the most recent cached source frame's hardware capture PTS. Not `CMClockGetTime`, not `Date()`.
- **Elapsed time formula:** `(sampleCaptureTime - recordingStartTime) - pauseAccumulator`
- **Why it matters:** Audio samples arrive from the mic with their own hardware PTS. Video frames arrive from the screen/camera with theirs. When camera and mic are both selected, they share a single `AVCaptureSession` (and therefore a single `synchronizationClock`), so their PTS values are directly comparable with sub-millisecond accuracy. When no camera is selected, the standalone mic session's PTS is still on the host time clock. By anchoring to a source frame's PTS rather than a wall-clock snapshot, the start-of-stream for both tracks is inherently aligned.

## Two-phase start

Recording start is split into a slow phase and a fast phase so the UI can show a countdown in parallel with hardware bring-up:

1. **`prepareRecording()`** (slow, ~1–2s):
   - Creates the server session (POST `/api/videos`).
   - Starts capture hardware (screen, camera, mic).
   - Waits for the first audio sample to arrive (confirms mic is delivering).
   - Configures raw safety-net writers.
   - Returns once hardware is warm and ready.

2. **`commitRecording()`** (fast, <1 frame):
   - Anchors `recordingStartTime` to the latest cached frame's PTS.
   - Starts the AVAssetWriter session.
   - Kicks off the metronome.
   - This is T=0.

The coordinator runs the countdown and `prepareRecording()` in parallel. After countdown completes, it awaits prepare (usually already done), then calls commit. Don't collapse these into a single call — the overlap is what makes the UI feel instant.

## Frame flow by mode

The metronome ticks at a wall-clock cadence set by the target frame rate (30fps or 60fps), but the tick interval is a **budget, not a contract**. Output rate tracks whatever the active mode's source is actually delivering — every tick consults the cached source frame and only emits when its `capturePTS` is strictly newer than `lastEmittedSourcePTS`. Stale-source ticks become no-ops; a long-static run triggers a [keep-alive](#keep-alive-for-long-static-sources) emit so HLS segments don't go empty.

This source-PTS freshness gate is the primary monotonicity defence. The encoder-level monotonicity check survives as a safety net — post [task-21](../tasks-todo/task-21-output-frame-cadence-rework.md) it should never fire on the happy path; any fire surfaces as a `monotonicity.rejected` event in `recording.json`.

### `cameraOnly`

Camera delivers frames into a bounded FIFO queue (capacity 8). Each metronome tick pops one frame from the queue. Every popped frame whose `capturePTS` passes the freshness check reaches the output in capture order. Output cadence matches the camera's actual delivery rate: a 30fps camera produces ~30fps output even when the metronome runs at 60fps. When the FIFO is empty, or when a popped frame is older than the last emit (e.g. pause-period leftovers, mode-switch carryover), the tick is a no-op — no synthetic-PTS frames.

### `screenOnly`

Screen frames go into a single-slot cache (latest wins). The metronome reads the cached frame on each tick and emits only when its `capturePTS` advances. ScreenCaptureKit only delivers `.complete` frames on content change, so a static screen produces no real emits — the keep-alive path handles segment hygiene in that case.

### `screenAndCamera`

Screen drives the output cadence (it's the primary content; camera is a PiP overlay). The freshness check runs on `screen.capturePTS`. Each tick peeks (without popping) the most recent camera frame from the FIFO as the overlay content. The camera FIFO accumulates and ages out via the capacity cap; no frames are consumed by this mode.

In all three modes, the emitted frame is stamped with the source frame's hardware capture PTS — not the wall clock at emit time. Audio samples are stamped with their own hardware capture PTS. Both share the same clock domain, which keeps A/V aligned through capture-pipeline latency.

### Keep-alive for long-static sources

When the freshness gate has been skipping for ≥ 1.0s (`host_now - lastEmitHostTime`), the metronome emits a synthetic-PTS repeat of the last cached source frame. This stops AVAssetWriter's 4-second segmenter from cutting empty segments during a static-screen run (which would freeze playback past the gap).

Keep-alive PTS uses the same formula real frames use — `primingOffset + (host_now - start) - pauseAccumulator` — substituting `host_now` for the source capture time. The wall-clock anchor is what keeps audio and video aligned across the static period: audio PTS also advances at wall-clock rate, so a 10s static run produces 10 keep-alives whose PTS spans 10 seconds, matching audio exactly.

Keep-alive intentionally does NOT update `lastEmittedSourcePTS`. When fresh source content eventually arrives, the freshness gate still accepts it — its `capturePTS` will be at least 1s past the keep-alive PTS, comfortably beyond capture-lag noise. This is what prevents the keep-alive from re-introducing the pre-task-21 host-clock-PTS bug.

One `keepalive.emitted` timeline event fires per static run (debounced); subsequent keep-alives in the same run are silent on the timeline.

## Composition (Metal/CIContext)

CompositionActor is stateless between frames — it holds the CIContext and pixel buffer pool, takes inputs, returns a composited pixel buffer. Three code paths:

- **screenOnly:** Scale screen to output dimensions (Lanczos for large downscales, affine otherwise). Center-crop to target aspect ratio.
- **cameraOnly:** Scale camera to output dimensions, apply camera adjustments (temperature/tint + exposure) if non-default.
- **screenAndCamera:** Scale screen as above. Scale camera to overlay diameter (240px at 1080p, proportional at other presets). Apply circle mask. Composite camera circle in bottom-right corner over screen.

Camera adjustments (white balance, exposure) are applied at the composition layer, not at capture. This means the raw `camera.mp4` safety-net file contains unmodified source footage — adjustments only affect the composited HLS stream that viewers watch.

### GPU failure handling

Metal renders can hang or error (documented in `docs/archive/m2-pro-video-pipeline-failures.md`). The pipeline handles this:

1. Each `CIRenderTask` has a 2-second timeout.
2. Render errors or stall timeouts trigger a `rebuildContext()` in CompositionActor — tears down the old CIContext and MTLCommandQueue, creates fresh ones.
3. If the rebuild itself fails, RecordingActor fires a terminal-error callback to the coordinator, which runs a clean stop flow and shows an alert.
4. Composition stats (error count, stall count, rebuild count, terminal flag) are recorded in the timeline for forensics.

## Writer and segmentation

WriterActor wraps AVAssetWriter in HLS fMP4 mode (`.mpeg4AppleHLS` output content type). Configuration:

- **Video:** H.264 High Profile. Base bitrate per resolution preset (8 Mbps at 1080p, 13 Mbps at 1440p); scaled 1.4× at 60fps. Frame rate hint matches the configured fps.
- **Audio:** AAC-LC, 128 kbps, 48 kHz.
- **Segment interval:** ~4 seconds.

Segments are delivered via AVAssetWriterDelegate into an `AsyncStream`. A single consumer task drains this stream in order, recording each segment in the timeline and enqueuing it for upload. This ordering guarantee is critical: `finish()` closes the stream's continuation, and the consumer drains any final segments before returning — so no trailing segment is ever lost at stop time.

### Audio timestamp adjustment

Audio needs special handling because of AAC encoder priming (the encoder emits a few "priming" samples that precede the first real audio). WriterActor owns a `TimestampAdjuster` that:

1. Tracks priming offset (set as `initialSegmentStartTime` on the writer so HLS players know where audio actually starts).
2. Applies the pause accumulator so audio PTS values skip over pauses.

Video PTS comes from the metronome with pauses already subtracted, so it bypasses the adjuster entirely.

## Upload and retry

UploadActor maintains a FIFO queue of pending segments. Processing is serial (one upload at a time, in order). For each segment:

1. Read bytes from local disk (not retained in memory between attempts).
2. Check reachability via `NWPathMonitor` — if network is unsatisfied, wait rather than burning retry budget.
3. PUT to `/api/videos/{id}/segments/{filename}` with `x-segment-duration` header.
4. On success: notify RecordingActor, mark segment uploaded in timeline.
5. On network error: exponential backoff (1s → 2s → 4s → … → 30s cap), retry indefinitely while recording is active.
6. On 401 or missing local file: immediate failure, no retry.

At stop time, the queue gets a 10-second grace window to drain. Anything still pending after that is cancelled and left on local disk for HealAgent to pick up later. The user's clipboard URL is never blocked on upload completion.

## Pause and resume

Pause is a first-class concept in the pipeline, not a stop-and-restart:

**On pause:**
- Metronome cancelled (no more ticks).
- `pauseStartHostTime` recorded.
- Raw writers stop receiving samples.
- Timeline event recorded.

**On resume:**
- Pause duration computed: `now - pauseStartHostTime`.
- Added to `pauseAccumulator`.
- `cameraFrameQueue` drained — any frames captured during the pause are pre-discarded so the metronome doesn't walk through them one tick at a time post-resume.
- `lastEmittedSourcePTS` bumped to `max(it, now)` so any *screen* frame captured during the pause (latestScreenFrame can be overwritten mid-pause) is treated as stale by the freshness gate. Without this bump the mid-pause screen frame would pass the freshness check but compute an encoder PTS behind `lastEmittedVideoPTS` and trip the monotonicity safety net.
- `lastEmitHostTime` bumped to `now` so a long pause isn't misread as a static-source run by the keep-alive path.
- Metronome restarted (drift-corrected sleep resets from tick 0).
- Next audio sample's PTS is retimed by subtracting the accumulated pause total.
- Next video frame from the metronome uses the same accumulator in its elapsed-time calculation.

Result: the output stream has no gap. Segments continue with continuous indexing and monotonic PTS values. The pause just... isn't there in the final video.

## Source failure behaviour

What happens today when a capture source dies mid-recording. GPU/composition failures are handled robustly (see above); source-level failures are not. See `docs/tasks-todo/task-2-source-failure-handling.md` for planned improvements.

### Screen capture (SCStream)

`ScreenCaptureManager` implements the `SCStreamDelegate` method `stream(_:didStopWithError:)` but only logs the error to console. There is no callback to RecordingActor, no timeline event, and no user notification. If SCStream dies, the single-slot `latestScreenFrame` cache retains the last delivered frame and the freshness gate begins rejecting every tick (its `capturePTS` stops advancing). After 1s the keep-alive starts firing at ~1Hz, so the recording continues with frozen pixels at low cadence rather than a hard freeze. The recording appears normal from the pipeline's perspective — just with a static image.

### Camera (AVCaptureSession)

No `AVCaptureSession.runtimeErrorNotification` or `wasInterruptedNotification` observers are registered. If the camera session dies (e.g. USB disconnect), frames stop arriving and the FIFO queue drains naturally. In `cameraOnly` mode the metronome starts skipping every tick (no frames to emit). In `screenAndCamera` mode the PiP overlay disappears but screen recording continues. No detection, no alert, no recovery attempt.

### Microphone (AVCaptureSession)

Same as camera — no session error notifications. If the mic stops delivering, audio goes silent in the output. The only detection is at prepare time: `startCaptureSources()` waits up to 1 second for the first audio sample, but continues recording even if audio never arrives.

### Shared session coupling

When camera and mic share an `AVCaptureSession` (for AV sync — see the "shared session" design in `CameraCaptureManager`), disconnecting the camera kills the entire session, including the mic audio track. The standalone `MicrophoneCaptureManager` session continues running independently and writes to `audio.m4a`, but it does NOT feed the HLS writer — so the composited output loses audio silently. This is the most dangerous failure mode: camera disconnect causes invisible audio death.

### Raw writer failures

Handled via `RawStreamWriter`. Each writer checks `writer.status == .failed` on append and sets a `hasFailed` flag. `checkRawWriterStatus()` is called at segment boundaries and records a timeline event on first detection. At stop time, `finish()` returns a `FinishResult` (.ok / .neverStarted / .failed) that is recorded in the timeline metadata. Raw writer failures do not stop the recording — the HLS path is independent.

### HLS writer health

`WriterActor` does not currently check `writer.status` during operation (unlike raw writers). If the HLS writer enters `.failed` state mid-recording, frames are silently dropped and the failure is only discovered at `finish()` time.

## Mode switching

Switching mode mid-recording is instant:

1. Caller sets `mode` on RecordingActor.
2. Timeline event recorded.
3. Next metronome tick reads the new mode and composes accordingly.

No transition effects, no writer restart, no segment boundary forced. The switch happens on the next frame (~33ms). The output is a hard cut from one composition to another within the same continuous HLS stream.

One edge case: switching INTO `cameraOnly` from a screen mode can show a brief (~100-300ms) warm-up. The camera FIFO inherits frames whose `capturePTS` predates the most recent screen-mode emit; the freshness gate discards them one tick at a time before reaching post-switch fresh content. The viewer sees the last screen frame held for those few hundred ms, then the camera takes over.

## Raw safety-net writers

Three parallel writers run alongside the composited HLS pipeline:

| Writer | Codec                       | File         | Purpose                       |
| ------ | --------------------------- | ------------ | ----------------------------- |
| Screen | ProRes 422 Proxy (hardware) | `screen.mov` | Full-resolution screen master |
| Camera | H.264 High @ 12 Mbps + AAC  | `camera.mp4` | Full-resolution camera master |
| Audio  | AAC-LC 192 kbps             | `audio.m4a`  | Full-quality mic master       |

These write at native resolution and rate (not 30fps, not composited). They exist so that if the HLS path fails or the composition needs re-rendering later, the source material is never lost. They are NOT what viewers watch — the composited HLS segments (and the server's MP4 derivative) are the viewer-facing output.

When camera and mic are both selected, `camera.mp4` includes an audio track from the shared session's mic (making it a self-contained A/V file for manual recovery). The standalone `audio.m4a` is always written separately regardless — it comes from the standalone mic session and serves as an independent safety net.

Raw writers are retimed by the same pause accumulator as the main pipeline, so their timelines align with the composited output.

## Recording timeline

The `RecordingTimeline` is a structured JSON artifact built incrementally during recording and written to `recording.json` at stop. Schema is versioned (`schemaVersion`) — current is v3.

It contains:

- **Session:** video id, slug, initial mode, start/end wall-clock, logical duration.
- **Hardware:** machine model, OS version, architecture.
- **Inputs:** which display, camera, mic were used (ids, names, dimensions). For cameras v3 additionally carries an `advertisedFormats` list (deduplicated by `(width, height, maxFrameRate)`) and a `selectedFormat` block — what AVCaptureSession actually picked plus whether `1/targetFPS` was inside the format's rate range (`didLockRate`).
- **Preset:** output dimensions and bitrate.
- **Segments:** per-segment index, filename, bytes, duration, upload status.
- **Events:** timestamped log of commits, stops, mode switches, pauses, resumes, segment emissions, upload outcomes, composition failures/rebuilds. v3 adds `keepalive.emitted` (one per static run) and `monotonicity.rejected` (every safety-net fire — should be zero on healthy recordings).
- **Raw streams (optional):** codec, dimensions, bitrate, final bytes for each raw writer.
- **Composition stats (optional):** error/stall/rebuild counts, only present if non-zero.
- **Runtime (v3, optional):** aggregate metronome metrics — `effectiveCameraFps`, `effectiveScreenFps`, `outputFps`, camera/screen capture-interval P50 and P95 in ms (estimated from histogram buckets — coarse but enough to answer "is the camera delivering at ~33ms?"), and a `metronome` counter sub-block (`iterations`, `emitOK`, `skipsStale`, `keepAliveEmits`, `monoRejects`).

The timeline serves three purposes: debugging (correlate events with segment boundaries), server-side forensics (what the client believed it uploaded), and as the authoritative segment list for healing (see [Streaming & Healing](streaming-and-healing.md)).

Alongside `recording.json`, a sibling **`diagnostics.json`** is written locally on every stop. This is a permanent, local-only debugging artifact — never uploaded, never served. It carries:

- Per-tick metronome trace (4000-entry ring buffer; the most-recent 4000 ticks for long recordings).
- First 300 camera-frame arrivals and 300 screen-frame arrivals in detail.
- Aggregate counters and bucketed histograms covering the whole recording (camera intervals, screen intervals, queue depths at pop, composition wall time, emit gaps, capture lag, monotonicity-reject deltas).
- Periodic snapshots every ~2s of logical time, so you can see how rates evolved through pauses and mode switches.
- The camera's advertised formats and the format AVCaptureSession actually selected (`activeMin/MaxFrameDuration` and whether the target rate locked).

A condensed view of the same data lands in `recording.json`'s `runtime` block (`effectiveCameraFps`, percentile-summarised intervals, metronome counters). Use that for quick "what happened on this recording?" — drop into `diagnostics.json` when you need per-tick detail.

Schema and ring-buffer semantics are documented on `MetronomeDiagnostics.FullDump` in `Pipeline/RecordingActor+Diagnostics.swift`.

## Coordinator and UI

`RecordingCoordinator` lives on the main actor and bridges the UI to the pipeline. Key responsibilities:

- **State machine:** `.idle` → `.countdown` → `.recording` → `.stopped` → `.idle`. SwiftUI observes this for panel content.
- **Device enumeration:** Refreshes display/camera/mic lists when the popover opens, polls every 2s for hot-plug detection.
- **Preview lifecycle:** Starts/stops camera and screen previews based on popover visibility, source selection, and current mode. Previews are torn down when not visible to save resources.
- **Camera adjustments:** Owns a shared `CameraAdjustmentsState` box passed to CompositionActor. Slider moves update the box; next composition tick reads the values.
- **Healing handoff:** After stop, if the server reports missing segments, passes them to HealAgent for background recovery. Fire-and-forget — the URL is already on the clipboard.

## Where the code lives

| Concern                                    | File                                                |
| ------------------------------------------ | --------------------------------------------------- |
| Orchestrator + clock + pause               | `Pipeline/RecordingActor.swift`                     |
| Two-phase start                            | `Pipeline/RecordingActor+Prepare.swift`             |
| Metronome (drift-corrected tick budget)    | `Pipeline/RecordingActor+Metronome.swift`           |
| Composite, freshness gate, keep-alive      | `Pipeline/RecordingActor+FrameHandling.swift`       |
| GPU failure recovery                       | `Pipeline/RecordingActor+CompositionRecovery.swift` |
| Diagnostics (counters + per-tick trace)    | `Pipeline/RecordingActor+Diagnostics.swift`         |
| Metal/CIContext rendering                  | `Pipeline/CompositionActor.swift`                   |
| AVAssetWriter + HLS segmentation           | `Pipeline/WriterActor.swift`                        |
| Segment upload + retry                     | `Pipeline/UploadActor.swift`                        |
| Post-stop + startup healing                | `Pipeline/HealAgent.swift`                          |
| Raw safety-net writers                     | `Pipeline/RawStreamWriter.swift`                    |
| HTTP client (auth + base URL)              | `Pipeline/APIClient.swift`                          |
| Recording timeline model                   | `Models/RecordingTimeline.swift`                    |
| Mode enum                                  | `Models/RecordingMode.swift`                        |
| Coordinator (UI ↔ pipeline)                | `App/RecordingCoordinator.swift`                    |
| Screen capture                             | `Capture/ScreenCaptureManager.swift`                |
| Camera capture (+ shared mic session)      | `Capture/CameraCaptureManager.swift`                |
| Microphone capture (standalone session)    | `Capture/MicrophoneCaptureManager.swift`            |
| Circle mask for PiP                        | `Helpers/CircleMaskGenerator.swift`                 |
| Timestamp adjuster (audio priming + pause) | `Helpers/TimestampAdjuster.swift`                   |
