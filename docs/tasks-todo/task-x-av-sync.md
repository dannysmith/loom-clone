# Task: Audio/Video sync investigation

Symptom reported 2026-04-16: in recordings made by the macOS app, audio
is ~250ms ahead of video. Most obvious in camera-only mode (talking-head
lip sync), still slightly perceptible in screen+camera with the PiP in
the corner.

Two root causes have been fully resolved. A third (perceived lag
during fast speech in camera-only mode) has been diagnosed; one
hardware check and one small code change remain.

## Completed

### Phase 1 — Fix stamped-PTS mismatch between audio and video (commit `8eb50fd`)

The metronome was stamping composited video frames with
`CMClockGetTime()` at emit time. Audio was stamped with the sample
buffer's hardware PTS. Camera/screen capture has ~40-80ms pipeline
latency, so the visible pixels at PTS `T` were actually captured
~50ms before `T` — while audio at PTS `T` reflected when sound hit
the mic. Net: audio ~50ms ahead of video.

Also, `recordingStartTime` was anchored to `CMClockGetTime()` at
commit. The cached camera frame at that moment had a `capturePTS`
~43ms in the past, so it was rejected by the `>= 0` guard and the
metronome had to wait for a fresh camera frame (~71ms). First audio
PTS landed near the anchor; first video PTS landed ~70ms later.
Compounded with the above to give a ~105ms audio-leads-video gap in
the fMP4/derivative output.

Fix: (a) metronome stamps composited frames with the source's
`capturePTS`, not wall-clock-now; (b) `recordingStartTime` is
anchored to the most recent cached source frame's `capturePTS`
(bounded to 100ms stale as a safety net against USB hiccups).

After fix: audio and video within 1ms in the output container.
Verified via ffprobe on the derivative MP4.

### Phase 2 — Scrubbing doesn't work in browser (commit `26ff261`)

Found incidentally during A/V investigation. Hono's `serveStatic`
from `hono/bun` doesn't honour HTTP Range requests. Browser sends
`Range: bytes=X-Y` when seeking in an MP4; server returned 200 OK
with the whole file and no `Content-Range` header; `<video>`
couldn't seek, restarted playback from zero every time the scrubber
moved.

Fix: replaced the `/data/*` mount with a Range-aware handler that
serves 206 Partial Content, advertises `Accept-Ranges: bytes`,
preserves MIME types for `.m3u8`/`.m4s`/`.mp4`, and guards path
traversal.

## Key learnings from this session

1. **Audio and video both need to be stamped at "when did this content
   hit the hardware", not "when did I hand it to the encoder".**
   Capture pipelines have non-trivial latency (40-80ms on built-in
   cameras, more on USB). A wall-clock-at-emit PTS bakes that latency
   into the video timeline asymmetrically.

2. **`recordingStartTime = CMClockGetTime()` at commit is wrong when
   one source has higher capture latency than another.** The right
   anchor is the source's own `capturePTS` at the moment of commit,
   with a sanity bound.

3. **AAC encoder priming pushes audio PTS ~34ms before the nominal
   timeline start.** With a 10-second priming offset this is fine
   (priming sits inside the buffer). Without it, audio appears to
   start earlier than the anchor.

4. **The metronome dropping on duplicate PTS produces visible
   stutters when source fps < metronome fps.** 25fps camera + 30fps
   metronome → ~20 skips/second → inter-emit gaps of 36-88ms instead
   of a consistent 40ms. Amplifies perceived lag during rapid speech.

5. **Hono `serveStatic` doesn't implement HTTP Range.** Any project
   using it to serve MP4/long media files has broken scrubbing.

6. **The Sony ZV-1 over USB advertises exactly one format:
   1280x720 at 25fps.** Confirmed via format enumeration. This is
   a camera-body menu setting (NTSC/PAL region and/or USB Streaming
   mode), not something our AVCaptureDevice code can override.

7. **A single-slot `latestCameraFrame` cache drops source frames
   whenever the consumer falls behind.** FaceTime test: 30fps
   camera delivered 367 frames, composited output contained 277 —
   90 frames (25%) were overwritten before the metronome could
   read them. Gap histogram was binary (33ms or 67ms, nothing in
   between), confirming the loss mechanism. This is architectural,
   not a timing bug: any single-slot polling scheme will drop
   frames when the producer runs faster than the consumer's read
   cycle. Fix is to drive emission from frame arrival, not from a
   polled cache.

## Completed (cont.)

### Phase 3 — Identify why camera delivered 25fps (resolved 2026-04-16)

Diagnostic logging added to `CameraCaptureManager.swift` enumerated
every format + supported fps range. Three controlled recordings:

**ZV-1 in PAL mode (recording `1282a58e`):** advertised exactly
one format `1280x720 420v fps=[25-25]`. `bestFormat()` returned
`nil`. Camera delivered 25fps. **Hardware setting**, not code.

**FaceTime HD Camera (recording `a8b87415`):** all 7 formats
advertised `fps=[15-30]`. `bestFormat()` picked 1920x1080 @ 30fps
correctly. Raw `camera.mp4`: `r_frame_rate=30000/1001` — 29.97fps
delivery. Perceptual result: "MUCH better, definitely good enough."

**ZV-1 in NTSC mode (recording `3e2c654a`, after user switched the
camera's region setting):** advertised `1280x720 420v fps=[30-30]`.
Camera now delivers 29.97fps (NTSC). Perceptually on par with
FaceTime. Note `bestFormat()` still returned `nil` here — see the
filter-bug fix below.

**Bonus finding and fix — strict-30 filter bug.** Our
`bestFormat()` filter compared `minFrameDuration <= 1/30 AND
targetDur <= maxFrameDuration`. NTSC cameras have
`minFrameDuration = 1001/30000 ≈ 33.367ms`, which is slightly
*larger* than `1/30 = 33.333ms`, so the check failed and the
filter silently rejected any camera that only advertises NTSC
rates. The `.high` preset fallback happened to pick the same
format, so output was fine — but the filter was defeated. Fixed
in this task by swapping the duration-based comparison for a
rate-based one with a small tolerance
(`maxFrameRate >= 29.0`), which lets NTSC 29.97 through and still
rejects PAL 25. The matching `activeVideoMinFrameDuration` code
now picks the fastest duration the format advertises, capped at
1/30, instead of hardcoding `1/30` (which would silently no-op on
NTSC devices).

**Unexpected new finding — single-slot cache drops source frames.**
Even with a 30fps camera, the composited output landed at ~22.6fps
(277 frames from 367 source frames in the FaceTime test). Gap
histogram: 186 at 33.3ms, 90 at 66.7ms, zero in between. **90
camera frames were lost by being overwritten in the
`latestCameraFrame` cache before the metronome could read them.**
This is a real bug, not just a cosmetic phase-drift issue — it
fundamentally reshapes Phase 4 below.

## Remaining work

### Phase 4 — Stop dropping source frames in the cache

**Revised understanding (2026-04-16):** the original Phase 4 was
framed as "don't skip on duplicate PTS; emit duplicates with
synthesized timestamps." That's wrong — it treats the symptom. The
real issue is that the `latestCameraFrame` cache is a single-slot
overwrite buffer: camera delivers at 30fps, metronome reads at its
own cadence, and whenever the metronome falls behind by even one
camera frame, that frame is lost forever. FaceTime test lost 25% of
source frames this way.

The fix: stop consuming camera frames via a polled cache. Instead,
drive composited emission *from* the camera-frame-arrival path, so
every camera frame gets composited and emitted exactly once at its
native capture PTS. The metronome becomes the backstop for
screen-only mode (where we do want synthetic 30fps cadence over a
static screen) rather than the authoritative clock for all modes.

Rough sketch (not prescriptive):

- In `handleCameraFrame`, after caching, dispatch a "compose+emit
  using this frame's capturePTS" task.
- Metronome loop only runs in screen-only mode (no camera source),
  or as a keepalive that emits the last-known frame if no camera
  arrival has happened in > 200ms (handles USB hiccups).
- `latestCameraFrame` still exists for screen+camera mode (so
  screen ticks have a camera frame to composite over), but a
  camera-driven emit path exists alongside it.

Open questions to work out during implementation:

- **Screen+camera mode**: who drives emit? Camera arrival (30fps
  camera, irregular screen sampling) or screen arrival (30fps
  screen, camera downsampled)? Camera arrival probably — matches
  lip-sync priority and screen content typically doesn't change
  fast enough for sampling jitter to matter.
- **Writer back-pressure**: `AVAssetWriterInput.isReadyForMoreMediaData`
  must be respected. Currently the metronome sleeps; the new
  handler would need to drop frames or queue if the writer isn't
  ready. Dropping is fine — unlikely to happen in practice.
- **Monotonicity**: still need the `lastEmittedVideoPTS` guard,
  just as a safety check.

Relevant code: `RecordingActor.handleCameraFrame`,
`RecordingActor.emitMetronomeFrame`,
`RecordingActor.metronomeLoop`.

### Phase 5 — Remove diagnostic logging

Once Phase 4 is settled and the A/V pipeline is verified healthy
one more time, strip the temporary logging:

- `[camera-diag]` block in `CameraCaptureManager.startCapture`.
- `[avsync]` per-event logs in
  `RecordingActor.handleCameraFrame`,
  `RecordingActor.handleScreenFrame`,
  `RecordingActor.handleAudioSample`,
  `RecordingActor.emitMetronomeFrame`.
- `[avsync-stats]` per-second summary in
  `RecordingActor.flushAVSyncStatsIfDue` and all the counter
  state around it (prefixed `stats*`).

## Related files

- `app/LoomClone/Pipeline/RecordingActor.swift` — metronome, PTS
  stamping, anchor, stats instrumentation.
- `app/LoomClone/Capture/CameraCaptureManager.swift` — format
  selection, frame-rate configuration.
- `server/src/index.ts` — `/data/*` Range-aware handler.
