# Task: Audio/Video sync investigation

Symptom reported 2026-04-16: in recordings made by the macOS app, audio
is ~250ms ahead of video. Most obvious in camera-only mode (talking-head
lip sync), still slightly perceptible in screen+camera with the PiP in
the corner.

All five phases landed in this task. Output is now within 1ms at the
file-timestamp level, every camera frame reaches the composited
output, and the viewer scrubs correctly.

## Phases

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

Found incidentally during the A/V investigation. Hono's `serveStatic`
from `hono/bun` doesn't honour HTTP Range requests. Browser sends
`Range: bytes=X-Y` when seeking in an MP4; server returned 200 OK
with the whole file and no `Content-Range` header; `<video>`
couldn't seek, restarted playback from zero every time the scrubber
moved.

Fix: replaced the `/data/*` mount with a Range-aware handler that
serves 206 Partial Content, advertises `Accept-Ranges: bytes`,
preserves MIME types for `.m3u8`/`.m4s`/`.mp4`, and guards path
traversal.

### Phase 3 — Identify why camera delivered 25fps (commits `3d96b51`, `172f5f8`, `32f523a`)

Diagnostic logging added to `CameraCaptureManager.swift` enumerated
every format + supported fps range. Three controlled recordings:

**ZV-1 in PAL mode:** advertised exactly one format
`1280x720 420v fps=[25-25]`. Camera delivered 25fps. **Hardware
setting**, not code. User switched the camera to NTSC mode, after
which it advertised `fps=[30-30]` and delivered 29.97fps.

**FaceTime HD Camera (control):** all 7 formats advertised
`fps=[15-30]`. `bestFormat()` picked 1920x1080 @ 30fps correctly.
Raw `camera.mp4`: 29.97fps delivery. Confirmed our code was fine
when the camera cooperated.

**Strict-30 filter bug found and fixed.** Our `bestFormat()` filter
compared `minFrameDuration <= 1/30 AND targetDur <= maxFrameDuration`.
NTSC cameras have `minFrameDuration ≈ 33.367ms`, which is slightly
larger than `1/30 = 33.333ms`, so the check failed and the filter
silently rejected any camera that only advertises NTSC rates. The
`.high` preset fallback happened to pick the same format, so output
was fine — but the filter was defeated. Swapped the duration-based
comparison for a rate-based one with a small tolerance
(`maxFrameRate >= 29.0`), which lets NTSC 29.97 through and still
rejects PAL 25.

**Second crash fix on UVC fixed-rate cameras.** The first attempt at
the filter fix also tried to clamp `activeVideoMinFrameDuration` to
`1/30` unconditionally. UVC cameras like the ZV-1 in NTSC mode
report a fixed range of `1000000/30000030` (≈30fps but not
exactly) — `CMTime(1, 30)` is outside that range, so the setter
throws `NSInvalidArgumentException` (uncatchable from Swift).
Revised to only set the duration when 1/30 actually falls within
the reported range; otherwise leave the camera at its native rate.

### Phase 4 — Stop dropping source frames in the cache (commit `32f523a`)

Even with a 30fps camera, the composited output was landing at
~22.6fps (277 frames from 367 source frames on the FaceTime test).
Gap histogram: binary 33.3ms/66.7ms with nothing between.

Root cause: `latestCameraFrame` was a single-slot cache.
`handleCameraFrame` overwrote it on every delivery. The metronome
polled at its own cadence. Whenever the metronome fell behind by
even one camera frame, that frame was lost — the cache had moved
on. 25% loss on a 30fps camera.

Fix: replace the single-slot cache with a bounded FIFO queue
(capacity 4, drop-oldest). Mode-specific consumption:

- `cameraOnly`: metronome pops one frame per emit, so every
  captured frame reaches the output in order, with its own
  `capturePTS`.
- `screenAndCamera`: metronome peeks the most recent queue entry
  (no pop). Older frames age out via capacity. Same effective
  behavior as the old single-slot cache, which is fine — the PiP
  doesn't need every frame.
- `screenOnly`: queue unused.

To make this correct, `CompositionActor.compositeFrame` now takes
an explicit `cameraBuffer` parameter rather than reading an
internal `latestCameraImage`. The image that gets rendered must
match the PTS the caller stamps — the compositor's own
latest-camera cache could hold a newer frame than the one the
queue popped.

Verified on ZV-1 NTSC (recording `9c6e30bd`): 349 source frames →
349 output frames (no loss). Max gap 48ms, mean 33.4ms, zero gaps
≥ 50ms.

### Phase 5 — Remove diagnostic logging (this commit)

Stripped:

- `[camera-diag]` format enumeration in `CameraCaptureManager.startCapture`.
- `[avsync]` per-event logs in `handleCameraFrame`,
  `handleScreenFrame`, `handleAudioSample`, `emitMetronomeFrame`.
- `[avsync-stats]` per-second summary block + all the `stats*`
  counter state + the inter-emit gap tracking.

Kept: the anchor-staleness warning when the cached source frame at
commit is older than the 100ms safety bound. It's rare and real —
retagged from `[avsync]` to `[recording]`.

Also updated the `metronomeLoop` doc comment, which had gone stale
(it still claimed PTS is derived from wall-clock-now; since Phase 1
it's derived from the source's capture PTS).

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

4. **Hono `serveStatic` doesn't implement HTTP Range.** Any project
   using it to serve MP4/long media files has broken scrubbing.

5. **The Sony ZV-1 over USB advertises a single locked format.** The
   fps is whatever the camera's region switch is set to (PAL = 25,
   NTSC ≈ 29.97). No AVCaptureDevice code can unlock a rate the
   device doesn't advertise — it's a hardware menu setting.

6. **UVC fixed-rate cameras report rates as 100ns-interval integers**,
   which translates to CMTimes like `1000000/30000030` — "effectively
   30fps" but not exactly. Duration comparisons against `CMTime(1, 30)`
   don't match exactly, and setting `activeVideoMinFrameDuration` to a
   value outside the reported range throws `NSInvalidArgumentException`
   (an ObjC exception Swift's `try/catch` can't catch). Always check
   the reported range before setting a duration.

7. **A single-slot `latestCameraFrame` cache drops source frames
   whenever the consumer falls behind.** FaceTime test: 30fps camera
   delivered 367 frames, composited output contained 277 — 90 frames
   (25%) were overwritten before the metronome could read them. Gap
   histogram was binary (33ms or 67ms, nothing in between), confirming
   the loss mechanism. Fix is to replace with a bounded FIFO.

## Cross-references

- `app/LoomClone/Pipeline/RecordingActor.swift` — metronome, PTS
  stamping, anchor, camera frame queue.
- `app/LoomClone/Pipeline/CompositionActor.swift` — cameraBuffer
  parameter on `compositeFrame`.
- `app/LoomClone/Capture/CameraCaptureManager.swift` — format
  selection, NTSC-aware filter, safe duration setting.
- `server/src/index.ts` — `/data/*` Range-aware handler.
- Commits: `8eb50fd`, `26ff261`, `3d96b51`, `172f5f8`, `32f523a`.
