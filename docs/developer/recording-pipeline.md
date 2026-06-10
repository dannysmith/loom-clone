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

This source-PTS freshness gate is the primary monotonicity defence. The encoder-level monotonicity check survives as a safety net — post [task-21](../tasks-done/task-2026-05-11-21-output-frame-cadence-rework.md) it should never fire on the happy path; any fire surfaces as a `monotonicity.rejected` event in `recording.json`.

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

When a capture source dies or stalls mid-recording, the failure is detected, surfaced to the user as a warning pill in the recording panel, and recorded in the timeline. Detection lives in `RecordingActor+SourceHealth.swift`; the UI is `WarningBannerView` / `WarningPill` driven by `RecordingCoordinator.activeWarnings`. Three complementary mechanisms run:

- **Staleness watchdog** (`checkSourceHealth()`, run periodically off the metronome/health loop). Compares now against each source's last-delivery host time. Thresholds: screen 2s, camera 1s, audio 2s. On breach it records a `source.{screen,camera,audio}.stale` event and fires a pill; when the source delivers again the warning clears and a `source.*.recovered` event is recorded. Fires once per stall, re-arms after recovery.
- **Capture-error handlers.** Each capture manager forwards `AVCaptureSession.runtimeErrorNotification` / `wasInterruptedNotification` (camera, mic) and the `SCStreamDelegate` stop-with-error (screen) into RecordingActor, which records `source.{...}.failed` and fires a pill.
- **Quality-degradation monitor** (`checkQualityHealth()`, same ~2Hz health loop). Catches the failure the staleness watchdog is blind to — see below.

Severity is mode-aware: losing a source the active mode depends on (screen in `screenOnly`, camera in `cameraOnly`) is `.critical`; a degraded-but-still-useful loss (the PiP camera in `screenAndCamera`) is `.warning`.

### Live quality degradation (camera capture-PTS corruption)

The staleness watchdog only catches *silence*. The failure that actually ruins recordings — the CMIO `-12743` synchronizer meltdown (#30/#44) — is **not** silence: the camera keeps delivering frames at roughly the right rate while feeding **corrupt, non-monotonic capture PTS** (frames stamped ~2s in the past; fabricated repeats). A garbage video timeline against a clean audio timeline *is* the A/V desync, and because frames never stop for a full second, the camera-stale watchdog barely fires.

`checkQualityHealth()` makes that visible while it's happening. It keys on the one invariant the whole pipeline rests on — **the camera's capture-PTS timeline advances monotonically** — rather than curve-fitting a detector to the meltdown's symptoms. (The metronome reject counters were tried and *refuted* against the labelled 2026-06-06 recordings: the post-#21 source-PTS freshness gate absorbs corrupt frames before they reach the encoder monotonicity guard, so a severe meltdown can show `rejectMonotonicity = 0`.)

- **The predicate** lives in `CameraCadenceMonitor` (`Helpers/`, pure + unit-tested). It ingests each camera frame's capture PTS and flags a *non-monotonic event* when the frame fails to advance past the **high-water mark** (the highest PTS seen so far) by more than 1ms — covering backward jumps, zero gaps, and duplicate/fabricated PTS. The high-water reference (not the immediately-previous frame) is load-bearing: the meltdown's severe form is a *sustained backward shift* — the timeline jumps ~4s into the past then runs forward at the normal interval, so those catch-up frames look healthy against the previous frame (+33ms) but are all behind the high-water mark. This was confirmed against a real ZV-1 meltdown (`2dee88cf`, 2026-06-09), where a 32-frame flood registered as a single event under a previous-frame predicate and never fired. It reports **degraded** once a small number of events land within a short trailing window, and **recovers** (hysteretically) only once the window goes fully quiet. The window is timed on the host clock — not capture PTS, which is the thing being judged.
- **Why it's robust to any camera, not just the ZV-1.** It's rate-agnostic and VFR-safe by construction: a real camera at 24/25/29.97/30/60fps or honest VFR produces forward-advancing PTS and trips nothing ("below-target-but-steady is fine; *destabilising* is the signal"). A dropped/stuttering frame is a *large forward* gap, also fine. The boundary is categorical (healthy = exactly zero non-monotonic frames), so the window/count numbers are debounce, not calibrated thresholds.
- **Wiring.** Fed from `recordCameraFrameForDiagnostics` (`RecordingActor+FrameDiagnostics.swift`, the existing camera measurement point) and evaluated from the health loop. On transition it fires a single `.qualityDegraded` pill (`.warning` severity — output is still being produced; the user's call to pause/stop/carry on) and records `quality.degraded` / `quality.recovered` timeline events carrying the windowed non-monotonic count and measured camera fps. A forensic `cameraNonMonotonicPTS` counter is also carried in `diagnostics.json` counters + periodic snapshots so a recording's firing window can be cross-checked against the extracted `-12743` flood.
- **Preview.** The same `CameraCadenceMonitor` runs in `CameraPreviewManager` (the preview shares the device + CMIO path, so a stuttering preview predicts a stuttering recording). When the preview feed goes non-monotonic it sets `previewFeedUnstable`, surfaced as a gentle pre-record note in the popover preview pane. There is no clean app-level API to reset a wedged USB/CMIO device, so the guidance is reconnect / see logs.

This task **observes** the violation; task 3 (#30) **enforces** the same invariant — the camera raw-writer monotonicity guard (see [Raw writer failures](#raw-writer-failures)) and, primarily, the ceiling-not-floor frame-rate handling that stops the ZV-1 fabrication at its root (see [Camera (AVCaptureSession)](#camera-avcapturesession)).

### Screen capture (SCStream)

`ScreenCaptureManager` forwards `stream(_:didStopWithError:)` to `handleScreenCaptureError`, which records `source.screen.failed` and fires a pill. For a silent stall (no error, just no frames), the staleness watchdog fires `source.screen.stale` after 2s. At the pipeline level the single-slot `latestScreenFrame` cache retains the last frame and the freshness gate rejects every tick; after 1s the keep-alive fires at ~1Hz, so the output holds frozen pixels at low cadence rather than hard-freezing.

### Camera (AVCaptureSession)

`CameraCaptureManager` forwards session runtime errors and interruptions to `handleCameraSessionError` / `handleCameraSessionInterrupted` (→ `source.camera.failed` + pill); a silent stall trips `source.camera.stale` after 1s. At the pipeline level the FIFO drains naturally — in `cameraOnly` the metronome skips every tick; in `screenAndCamera` the PiP overlay disappears but screen recording continues.

**Frame-rate handling (ceiling, not floor).** `capFrameRateIfSupported` sets at most `activeVideoMinFrameDuration` — a *ceiling* ("don't deliver faster than target") — and never `activeVideoMaxFrameDuration` (a *floor*). The floor is what triggered the ZV-1 CMIO `-12743` meltdown (#30): a UVC camera advertising a 30fps rate it can't sustain (the ZV-1 exposes a single discrete 720p30 format but delivers ~24fps) gets asked to *fabricate* the missing frames to hold the floor, corrupting its capture-PTS timeline and desyncing A/V. The ceiling is applied only when the format has rate **headroom** (`shouldCapRate` — it can run faster or slower than target); for a format **rate-locked to the target** (the ZV-1's sole `30-30` range) it sets nothing, because setting the ceiling there drags `activeVideoMaxFrameDuration` up to the target and re-imposes the floor. The post-#21 cadence model already produces correct output from whatever the camera delivers, so a free-running camera needs no pinning. FaceTime (sustains 30+) and the Cam Link 4K (advertises 25-60, floor lands at 25) never melt down even with a floor — only a camera that *can't meet* its floor does. See `app/LoomClone/CLAUDE.md` "Camera format selection" for the full history (#34 added the floor; pre-#34 set neither for the ZV-1 and ran clean).

### Microphone (AVCaptureSession)

`MicrophoneCaptureManager` forwards session errors/interruptions to `handleMicSessionError` / `handleMicSessionInterrupted` (→ `source.audio.failed` + pill); a silent stall trips `source.audio.stale` after 2s (the warning pill it raises is the `.audioMissing` kind). The prepare-time guard still applies: `startCaptureSources()` waits up to 1 second for the first audio sample, but continues recording even if audio never arrives.

### Shared session coupling

When camera and mic share an `AVCaptureSession` (for AV sync — see the "shared session" design in `CameraCaptureManager`), disconnecting the camera kills the entire session, including its mic audio track. This used to silently kill audio in the composited output. It now fails over: on camera-session death, `failoverSharedSessionAudio` flips routing so the standalone `MicrophoneCaptureManager` session (always running, writing `audio.m4a`) starts feeding the HLS writer, and an `audio.failover` event is recorded. Audio continues — degraded by the reintroduced cross-session clock jitter, but not lost.

### Raw writer failures

Handled via `RawStreamWriter`. Each writer checks `writer.status == .failed` on append and sets a `hasFailed` flag. On transition to `.failed`, `makeFailure(from:)` snapshots the `AVAssetWriter.error` into a `WriterFailure` (`description`, `code`, `domain`) **and walks the `NSUnderlyingError` chain** (and the `NSMultipleUnderlyingErrors` variant) to the deepest error, recording `underlyingCode`/`underlyingDomain`/`underlyingDescription`. This is what surfaces the real VideoToolbox/CMIO code behind a generic top-level `AVErrorUnknown` (`-11800`) — see #30. The snapshot lands in `lastFailure` so it survives after the writer is nilled out. `checkRawWriterStatus()` (segment boundaries) and the stop-time `finish()` → `FinishResult` (`.ok` / `.neverStarted` / `.failed(WriterFailure)`) both emit a `raw.writer.failed` event carrying all of those fields. Raw writer failures do **not** stop the recording — the HLS path is independent.

**Camera raw-writer monotonicity guard (defence-in-depth).** `handleCameraFrame` drops any camera frame whose retimed PTS doesn't strictly advance past the last appended one (tracked in `lastRawCameraAppendedPTS`, counted as `cameraRawFramesSkipped`). `AVAssetWriter` rejects a non-monotonic sample by failing the whole writer — one backward/duplicate PTS from a corrupt feed would otherwise leave an unplayable `camera.mp4` (#30's `-16364`). Skipping the bad frame leaves the master truncated-but-playable. This is the enforcement counterpart to task 2's quality *warning*: same high-water invariant, applied to the one path (the raw writer) the composited/emit path's freshness gate doesn't already protect. It does **not** repair or re-stamp PTS — that would be its own desync. With the rate-unlock above removing the fabrication trigger, it should rarely fire.

### HLS writer health

`checkHLSWriterHealth()` runs at segment boundaries (from `handleSegment`). If the HLS writer has entered `.failed`, it records `writer.hls.failed`, fires a critical pill, and escalates as a **terminal** error — unlike a raw-writer failure (recoverable; HLS continues), the primary output is dead, so the coordinator runs a clean stop with the footage saved up to that point.

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
- **Events:** timestamped log of commits, stops, mode switches, pauses, resumes, segment emissions, upload outcomes, composition failures/rebuilds, and source-health events (`source.*.stale`/`.failed`/`.recovered`, `audio.failover`, `writer.hls.failed`, and `raw.writer.failed` carrying its top-level **and** deepest-underlying NSError `code`/`domain`). v3 adds `keepalive.emitted` (one per static run) and `monotonicity.rejected` (every safety-net fire — should be zero on healthy recordings). The `chapter.marker` kind carries `data: { id: "<uuid>" }` and is emitted when the user presses the bookmark button in the recording panel — `t` is the user-visible clock time (frozen at the pause-start value if the recording was paused at the moment of the press).
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

A third local artifact, **`os-log.ndjson`**, is written by a detached post-stop task: the slice of the macOS unified log covering the recording's time window, filtered to our subsystem (`is.danny.LoomClone`) plus the Apple CoreMediaIO / CoreMedia / VideoToolbox subsystems. It captures the Apple-side camera/encoder errors (e.g. the CMIO `-12743` synchronizer floods) that originate outside our process and so never reach our own logs. It's read from the OS's already-persisted store via `OSLogStore(scope: .system)` — available because the app is not sandboxed and runs as admin — and **never** written on the recording hot path (log volume during recording is itself a frame-drop cause; see #3). Local-only, never uploaded; streamed and capped to bound size. See `Helpers/LogExtractor.swift`; re-runnable for any past recording from the Recordings settings tab.

## Coordinator and UI

`RecordingCoordinator` lives on the main actor and bridges the UI to the pipeline. Key responsibilities:

- **State machine:** `.idle` → `.countdown` → `.recording` → `.stopped` → `.idle`. SwiftUI observes this for panel content.
- **Device enumeration:** Refreshes display/camera/mic lists when the popover opens, polls every 2s for hot-plug detection.
- **Preview lifecycle:** Starts/stops camera and screen previews based on popover visibility, source selection, and current mode. Previews are torn down when not visible to save resources. The camera preview also publishes live `previewMetadata` (delivered resolution + measured/advertised frame rate); the popover shows a subtle badge that flags when the camera's rate falls below the selected target (e.g. a 25fps PAL camera against a 30fps target) so a misconfigured device is visible before recording.
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
| Source health + warning detection          | `Pipeline/RecordingActor+SourceHealth.swift`        |
| Live quality-degradation warning           | `Pipeline/RecordingActor+QualityHealth.swift`       |
| Camera capture-PTS cadence predicate       | `Helpers/CameraCadenceMonitor.swift`                |
| Post-stop OS-log extraction                | `Helpers/LogExtractor.swift`                        |
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
