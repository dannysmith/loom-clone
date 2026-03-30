# Phase 0: Prototype

Validate the recording pipeline and explore the desktop app UI. Build a Swift app and a local server that together prove the core capture → composite → segment → upload → playback flow works.

This prototype may become the real app, or it may be thrown away. Either outcome is fine — the goal is to retire technical risk and nail down the interaction design before committing to full implementation.

Read `requirements.md` for product context and `docs/plan.md` for the full architecture and technology choices.

---

## What We're Building

**A macOS menu bar app** that records screen, camera, and microphone, composites them in real-time, produces HLS segments, and uploads them to a local server.

**A local dev server** (Hono + Bun, runs on the Mac) that receives those segments, assembles an HLS playlist, and serves a test page where you can play the result back.

No deployment, no R2, no Cloudflare Workers, no admin UI. Just the pipeline.

---

## Desktop App

### App Shell

- Menu bar app using NSStatusItem + NSMenu
- SwiftUI views inside the menu for recording controls
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

### Pause / Resume

- Set a flag that stops appending frames to AVAssetWriter
- Record the timestamp of the last appended frame
- On resume, calculate the pause duration, apply as offset to all subsequent CMSampleBuffers via `CMSampleBuffer(copying:withNewTiming:)`
- Audio and video must use the same offset
- Optionally flush the current HLS segment on pause (keeps segment durations predictable)

### Segment Upload

An `UploadActor` that:

1. Receives segment data from the AVAssetWriter delegate
2. Numbers segments sequentially: `init.mp4`, `seg_000.m4s`, `seg_001.m4s`, ...
3. Uploads each via `PUT http://localhost:3000/api/videos/{id}/segments/{name}`
4. Uploads one at a time, in order
5. If an upload fails, retries with backoff (but for a local server this shouldn't happen)

On recording stop:
1. Call `flushSegment()` on AVAssetWriter to push the final partial segment
2. Call `finishWriting(completionHandler:)`
3. Upload the final segment
4. Call `POST http://localhost:3000/api/videos/{id}/complete`

### Local Safety Net

Write all segments to a local directory alongside uploading them. Keep the local HLS playlist + segments as a backup. The local copy is a complete playable recording.

### Recording UI

- **Before recording**: Menu shows input selection (display, camera, mic) and a Record button
- **During recording**: Floating panel with Stop, Pause/Resume, mode switch buttons, and a timer. Keep it minimal — this is a prototype, not the final design, but it should be functional enough to explore UX patterns
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

- [ ] Record screen at 1080p30 and play back the result in a browser
- [ ] Record camera at native resolution and play back
- [ ] Record screen + camera with PiP overlay and play back
- [ ] Switch between all three modes mid-recording — the resulting video plays continuously with no gaps or glitches
- [ ] Pause and resume mid-recording — the resulting video has no gap where the pause was
- [ ] Segments upload to the local server during recording and the playlist is correct
- [ ] Audio is synced with video throughout, including across mode switches and pauses
- [ ] The HLS segments are independently decodable (can seek to any segment)
- [ ] Recording for 5+ minutes produces a stable, correct result (no memory leaks, no drift)

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
