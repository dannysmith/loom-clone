# Phase 0: Prototype

Validate the recording pipeline and explore the desktop app UI. Build a Swift app and a local server that together prove the core capture → composite → segment → upload → playback flow works.

This prototype may become the real app, or it may be thrown away. Either outcome is fine — the goal is to retire technical risk and nail down the interaction design before committing to full implementation.

Read `requirements.md` for product context and `docs/plan.md` for the full architecture and technology choices.

---

## Progress

### What's built and working

**Desktop App** (`app/`):
- Menu bar app with NSPopover UI (device pickers, mode selector, record button)
- Floating NSPanel for recording controls (stop, pause/resume, mode switch, timer)
- Screen capture via ScreenCaptureKit (1920x1080 @ 30fps)
- Camera capture via AVCaptureSession (independent session)
- Microphone capture via AVCaptureSession (independent session)
- Core Image + Metal compositing (all three modes: screen-only, camera-only, screen+camera with circle overlay)
- Mode switching mid-recording (unified host clock timestamps)
- AVAssetWriter producing fMP4 HLS segments (H.264 High 6Mbps, AAC-LC 128kbps, 4s segments)
- Segment upload to local server via URLSession
- Local safety net (segments saved to ~/Library/Application Support/)
- Screen recording permission detection with settings link and retry flow
- Global keyboard shortcuts (Cmd+Shift+R/P/M)
- Pause/resume working
- Multiple recordings in same session working

**Local Server** (`server/`):
- Hono + Bun on localhost:3000
- POST /api/videos, PUT segments, POST complete
- HLS playlist generation (VOD, fMP4, EXT-X-VERSION:7)
- Vidstack playback page at /v/:slug
- Seeking works in playback

### Key learnings

1. **NSMenu kills SwiftUI interactivity**: SwiftUI controls embedded in NSMenuItem via NSHostingView don't receive mouse events — the menu intercepts them. Solution: use NSPopover instead.

2. **AVAssetWriter.flushSegment() is only for manual segmentation**: Calling flushSegment() when preferredOutputSegmentInterval is set to a non-indefinite value crashes. With automatic segmentation, finishWriting() flushes remaining data automatically.

3. **finishWriting() emits empty trailing segments**: After the final real segment, AVAssetWriter emits several 0-duration metadata segments. These break HLS playback if included in the playlist. Filter them out (skip segments with duration < 0.01s).

4. **Mode switching requires unified timestamps**: Screen and camera capture sessions have independent timestamp origins. When switching from screen-driven to camera-driven mode, using each source's native PTS causes timestamp discontinuities that crash AVAssetWriter (error -12785). Solution: use a single host clock source (`CMClockGetHostTimeClock()` - recordingStartTime) for all video PTS.

5. **Audio timestamps must match video normalization**: After switching video to relative timestamps, audio was still using absolute mic PTS (~123456s vs ~0s for video). This puts audio at the wrong point in the timeline — sounds like no audio but it's actually there, just at a massive offset. Both video and audio must be normalized to recording-relative time.

6. **macOS window levels matter for fullscreen/spaces**: Standard `.floating` level (3) won't appear above fullscreen apps (level 25+). Need `.statusBar` level or NSPanel with high window level, plus `canJoinAllSpaces` and `fullScreenAuxiliary` collection behaviors.

7. **Swift 6 strict concurrency is aggressive with framework types**: CVPixelBuffer, CMSampleBuffer, SCDisplay, AVCaptureDevice are all non-Sendable in Swift 6. Region-based isolation catches passing them across actor boundaries even with @unchecked Sendable extensions. Using Swift 5 language mode with targeted concurrency checking is pragmatic for a prototype.

8. **ScreenCaptureKit TCC handling**: SCShareableContent fails with error -3801 when screen recording permission is denied. Need to detect this, show a clear UI prompt, and provide a deep link to System Settings (`x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture`).

---

## What We're Building

**A macOS menu bar app** that records screen, camera, and microphone, composites them in real-time, produces HLS segments, and uploads them to a local server.

**A local dev server** (Hono + Bun, runs on the Mac) that receives those segments, assembles an HLS playlist, and serves a test page where you can play the result back.

No deployment, no R2, no Cloudflare Workers, no admin UI. Just the pipeline.

---

## Desktop App

### App Shell

- Menu bar app using NSStatusItem + NSPopover (not NSMenu — SwiftUI controls need proper event handling)
- SwiftUI views inside the popover for recording controls
- Floating NSPanel (non-activating, always-on-top) for controls during recording
- No Dock icon (LSUIElement = true)

### Capture Pipeline

All three capture sources run independently on their own dispatch queues:

1. **Screen**: ScreenCaptureKit `SCStream`. Configure with `SCContentFilter` for a selected display. NV12 pixel format. Let the user pick which display if multiple are connected.

2. **Camera**: AVCaptureSession with `AVCaptureVideoDataOutput`. Let the user pick which camera device. Camera frames arrive as CMSampleBuffers.

3. **Microphone**: AVCaptureSession with `AVCaptureAudioDataOutput`. Let the user pick which mic device. Audio samples arrive as CMSampleBuffers.

### Composition Engine

A `CompositionActor` (Swift actor) that receives frames from screen and camera, reads the current recording mode, and produces a composited output frame:

| Mode | Composition |
|------|-------------|
| Camera + Mic | Camera frame scaled to 1920x1080 output |
| Screen + Mic | Screen frame (scaled to 1080p if needed) |
| Screen + Camera + Mic | Screen frame with camera overlay composited via Core Image (`CIFilter.sourceOverCompositing`) |

Key implementation details from the research:
- Create one `CIContext` with Metal command queue — reuse across frames
- Use `CVPixelBufferPool` for output buffers (avoid per-frame allocation)
- Camera overlay: crop to circle or rounded rect via `CIBlendWithMask`, position in a corner
- Use the most recent camera frame for each screen frame (they may arrive at different rates)
- Moving/resizing the overlay is just changing parameters — the compositor reads them each frame

### Recording Mode State

A simple enum managed by the `RecordingActor`:

```
enum RecordingMode {
    case cameraOnly
    case screenOnly
    case screenAndCamera
}
```

Switching modes changes what the composition engine renders. No capture pipeline teardown or restart. The screen and camera sources keep running regardless of mode — their output is just ignored when not needed.

### Encoding + Segmentation

`AVAssetWriter` configured for fragmented MP4 HLS output:

```
outputFileTypeProfile: .mpeg4AppleHLS
preferredOutputSegmentInterval: CMTime(seconds: 4, preferredTimescale: 1)
```

Video input settings:
- H.264 via VideoToolbox (hardware encoder)
- High Profile, 6 Mbps average bitrate
- 2-second max keyframe interval
- 1920x1080 output resolution
- `expectsMediaDataInRealTime: true`

Audio input settings:
- AAC-LC, 128 kbps, 48kHz, stereo

The `AVAssetWriterDelegate` receives:
- `.initialization` segment (once, at start) — the fMP4 init segment
- `.separable` segments (every 4 seconds) — media segments

Each segment's data is passed to the upload pipeline.

**Use `.mpeg4AppleHLS` profile** (not `.mpeg4CMAFCompliant`) to avoid a known crash on Intel Macs.

**Audio priming**: AAC introduces ~44ms of priming samples. Set `initialSegmentStartTime` with a small offset (2-10 seconds) and shift all appended CMSampleBuffer timestamps by the same amount. See WWDC 2020 session 10011.

**Timestamp normalization**: All video and audio timestamps must be normalized relative to recording start time using the host clock. This prevents discontinuities when switching between screen-driven and camera-driven modes.

**Empty segment filtering**: finishWriting() emits trailing 0-duration segments. Skip any media segment with duration < 0.01s.

### Pause / Resume

- Set a flag that stops appending frames to AVAssetWriter
- Record the timestamp of the last appended frame
- On resume, calculate the pause duration, apply as offset to all subsequent CMSampleBuffers via `CMSampleBuffer(copying:withNewTiming:)`
- Audio and video must use the same offset
- Do NOT call flushSegment() when using automatic segment intervals — it crashes

### Segment Upload

An `UploadActor` that:

1. Receives segment data from the AVAssetWriter delegate
2. Numbers segments sequentially: `init.mp4`, `seg_000.m4s`, `seg_001.m4s`, ...
3. Uploads each via `PUT http://localhost:3000/api/videos/{id}/segments/{name}`
4. Uploads one at a time, in order
5. If an upload fails, retries with backoff (but for a local server this shouldn't happen)

On recording stop:
1. finishWriting() automatically flushes remaining data
2. Upload the final segment(s)
3. Call `POST http://localhost:3000/api/videos/{id}/complete`

### Local Safety Net

Write all segments to a local directory alongside uploading them. Keep the local HLS playlist + segments as a backup. The local copy is a complete playable recording.

### Recording UI

- **Before recording**: Popover shows input selection (display, camera, mic) and a Record button
- **During recording**: Floating panel with Stop, Pause/Resume, mode switch buttons, and a timer
- **After recording stops**: Show the local playback URL (e.g. `http://localhost:3000/v/{id}`)

### Keyboard Shortcuts

At minimum, global shortcuts for:
- Start/stop recording
- Pause/resume
- Switch mode (cycle through the three modes)

Use `NSEvent.addGlobalMonitorForEvents` or Carbon `RegisterEventHotKey`.

---

## Local Server

Hono + Bun. Runs on the Mac during development. No authentication needed.

### Endpoints

```
POST   /api/videos                         Create video record, return { id, slug }
PUT    /api/videos/:id/segments/:filename  Receive a segment, write to disk
POST   /api/videos/:id/complete            Finalise HLS playlist
GET    /v/:slug                            Video page with Vidstack player
```

### Segment Storage

Store segments on local disk at a predictable path:

```
data/{videoId}/
  init.mp4
  seg_000.m4s
  seg_001.m4s
  ...
  stream.m3u8
```

### Playlist Management

Build the `.m3u8` playlist as segments arrive:

```
#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:4
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-MAP:URI="init.mp4"

#EXTINF:4.000,
seg_000.m4s
#EXTINF:4.000,
seg_001.m4s
```

On the `complete` call, append `#EXT-X-ENDLIST`. Use `VOD` playlist type (not `EVENT`) since we don't serve the video publicly during recording.

The segment duration in `#EXTINF` should come from the `AVAssetSegmentReport` provided by the writer delegate — it has the actual segment duration.

### Video Page

A minimal HTML page served at `/v/:slug` that loads Vidstack with the HLS playlist:

```html
<media-player src="/data/{videoId}/stream.m3u8" playsinline>
  <media-provider></media-provider>
  <media-video-layout></media-video-layout>
</media-player>
```

Serve the `data/` directory as static files so Vidstack can load the segments directly.

This page exists purely to verify playback works. No OG tags, no styling, no metadata display.

---

## Exit Criteria

The prototype is successful when all of the following work:

- [x] Record screen at 1080p30 and play back the result in a browser
- [x] Record camera at native resolution and play back
- [x] Record screen + camera with PiP overlay and play back
- [x] Switch between all three modes mid-recording — the resulting video plays continuously with no gaps or glitches
- [x] Pause and resume mid-recording — the resulting video has no gap where the pause was
- [x] Segments upload to the local server during recording and the playlist is correct
- [ ] Audio is synced with video throughout, including across mode switches and pauses
- [x] The HLS segments are independently decodable (can seek to any segment)
- [ ] Recording for 5+ minutes produces a stable, correct result (no memory leaks, no drift)

---

## Remaining Prototype Work

Things to build and test before moving to Phase 1. Roughly prioritized.

### Camera overlay and preview

- **Live camera preview** in the popover before recording — show the camera feed so the user can check framing. Use AVCaptureVideoPreviewLayer or render camera frames into a SwiftUI view.
- **On-screen camera overlay during recording** — a separate transparent NSPanel showing the live camera feed as a circle. This is the visual feedback for the user, separate from the composited video. Should be draggable/resizable.
- **Exclude our windows from screen capture** — pass the recording panel and camera overlay windows to SCContentFilter's `excludingWindows:` parameter so they don't appear in the captured video.

### Recording overlay on all Spaces and fullscreen

- The recording control panel must appear above fullscreen apps and follow Space switches. Standard `.floating` level (3) is below fullscreen apps (level 25+). Need NSPanel with `.statusBar` level or higher, plus `canJoinAllSpaces` and `fullScreenAuxiliary` collection behaviors. See [Handy PR #361](https://github.com/cjpais/Handy/pull/361) for reference.
- The camera overlay window needs the same treatment.

### Audio verification

- Audio fix is implemented (timestamp normalization) but needs testing: record yourself counting while tapping the screen, verify lip sync in playback.
- Test audio across mode switches and pause/resume cycles.

### Resolution and quality

- Currently hardcoded to 1920x1080. Test with high-res monitors (Retina, external 4K) and high-quality camera inputs (DSLR via USB/capture card).
- Capture at native display resolution instead of forcing 1080p. Scale down only for the composited HLS output if needed.
- Bitrate should scale with resolution — 6 Mbps is fine for 1080p but needs ~15-20 Mbps for 4K.
- Camera capture should use the camera's native resolution, not be constrained by output resolution.

### Local full-quality stream recordings

- Save individual capture streams as standalone files alongside the composited HLS segments:
  - Screen → `screen.mp4` at native monitor resolution
  - Camera → `camera.mp4` at native camera resolution
  - Audio is embedded in both, or saved separately
- This enables re-compositing later (change camera position/size, effects, etc.) and provides a high-quality master.
- Requires running multiple AVAssetWriters simultaneously. Apple Silicon's dedicated media engine supports concurrent H.264 encode sessions.

### Server-side MP4 compositing

- After recording completes, stitch HLS segments into a single MP4 using FFmpeg (`ffmpeg -i stream.m3u8 -c copy output.mp4` — no re-encoding).
- Serve the MP4 as a download option alongside HLS playback.
- Future: re-composite from individual streams at full quality with FFmpeg.

### Stability testing

- 5+ minute recording: check for memory growth (segment data held in upload queue), frame drops, audio drift.
- Test recording while in a video call (concurrent H.264 encode sessions).
- Test rapid mode switching (5+ switches in a few seconds).
- Verify second and third recordings in the same app session work cleanly.

### Recording indicator

- Change the menu bar icon during recording (red dot or pulsing indicator) so the user knows at a glance.

---

## Key References

- `docs/research/01-macos-recording-apis.md` — ScreenCaptureKit, AVCaptureSession, AVAssetWriter, compositing, mode switching, pause/resume. The primary technical reference for the desktop app.
- `docs/research/02-streaming-upload-architecture.md` — Segment format, upload protocol, playlist management, network resilience.
- `docs/research/03-cap-codebase-analysis.md` — Cap's recording pipeline as a reference implementation. Actor-based state management, audio gap detection, frame drop monitoring.
- `docs/research/06-video-processing-encoding.md` — Encoding settings (H.264 profile, bitrate, keyframe interval).

### Open-Source References

| Project | What to study |
|---------|---------------|
| [ScreenCaptureKit-Recording-example](https://github.com/nonstrict-hq/ScreenCaptureKit-Recording-example) (Nonstrict) | ScreenCaptureKit + AVAssetWriter edge cases, timing, retina handling |
| [EasyDemo](https://github.com/danieloquelis/EasyDemo) | Core Image compositing of webcam over screen in Swift |
| [QuickRecorder](https://github.com/lihaoyun6/QuickRecorder) | Menu bar app architecture, recording modes, ScreenCaptureKit usage |
| [Azayaka](https://github.com/Mnpn/Azayaka) | Minimal menu bar recorder |
