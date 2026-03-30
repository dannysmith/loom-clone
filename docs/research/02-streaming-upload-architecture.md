# Streaming Upload Architecture

*Research date: 2026-03-30*

---

## Summary

This document describes the architecture for streaming video from the macOS desktop app to the server during recording, so that when the user hits "stop," a playable URL is available within seconds. The recommended approach is: the desktop app generates fragmented MP4 (fMP4) segments using Apple's AVAssetWriter during recording, uploads each segment via HTTPS as it completes, and the server assembles an HLS EVENT playlist that grows as segments arrive. When recording stops, the final segment is flushed and uploaded, the playlist is finalised with `#EXT-X-ENDLIST`, and the video is immediately playable.

---

## 1. Recommended Architecture: End-to-End Flow

Here is the full sequence from the moment the user hits "Record" to a working, shareable URL.

### Phase 1: Pre-Recording Setup

1. **Desktop app calls the server**: `POST /api/videos` to create a video record. The server returns a `videoId`, a `slug` (random hash for unlisted), and the shareable URL (`v.danny.is/{slug}`). The URL is copied to the clipboard immediately --- it exists before any recording happens. It will return a "recording in progress" state if accessed before segments arrive.

2. **Desktop app receives upload credentials**: The server returns either pre-signed S3 URLs or a session token authorising direct segment uploads. This avoids per-segment authentication overhead during recording.

3. **Desktop app configures AVAssetWriter**: Set up for fragmented MP4 output with the HLS profile. Configure video and audio inputs from the capture pipeline (ScreenCaptureKit for screen, AVCaptureDevice for camera, audio from selected mic).

### Phase 2: Recording & Streaming Upload

4. **AVAssetWriter produces fMP4 segments**: As the capture pipeline feeds CMSampleBuffers into the writer, AVAssetWriter calls its delegate method with completed segment data every N seconds (configured via `preferredOutputSegmentInterval`). The first callback delivers the **initialisation segment** (file type box + movie box metadata), then subsequent callbacks deliver **media segments** (movie fragment box + media data).

5. **Each segment is uploaded immediately**: As each segment callback fires, the segment data is placed in an upload queue. An upload worker sends it to the server (or directly to S3) via HTTPS PUT. Segments are numbered sequentially (`init.mp4`, `seg_000.m4s`, `seg_001.m4s`, ...).

6. **Server updates the HLS playlist**: As each segment arrives and is stored, the server appends a new `#EXTINF` entry to the `.m3u8` playlist file. The playlist uses the `EVENT` type so all segments remain listed (no sliding window removal). The playlist is served from CDN-backed storage.

7. **Video is progressively playable**: Any viewer who loads the URL after the first media segment arrives gets a working HLS stream. The player (hls.js / Vidstack) loads the playlist, sees the segments available so far, and begins playback from the beginning. Because the playlist lacks `#EXT-X-ENDLIST`, the player knows this is a live/event stream and periodically re-fetches the playlist to discover new segments.

### Phase 3: Recording Stops

8. **Final segment flush**: When the user hits "stop," the desktop app calls `flushSegment()` on AVAssetWriter to push the last partial segment, then calls `finishWriting()`. The final segment is uploaded.

9. **Playlist finalisation**: The desktop app notifies the server that recording is complete. The server appends the final segment entry and adds `#EXT-X-ENDLIST` to the playlist. This tells the player the stream is complete --- no more reloading needed.

10. **URL is fully functional**: The shareable URL now points to a complete, seekable video. No further processing is needed for basic playback.

### Phase 4: Post-Recording Processing (Background)

11. **Full-quality upload** (if dual-quality): If the streaming segments were encoded at reduced quality, the desktop app uploads the full-resolution local recording. The server processes it into multi-bitrate HLS renditions.

12. **Multi-bitrate encoding**: The server runs FFmpeg to generate adaptive bitrate renditions (e.g., 1080p, 720p, 480p) from either the uploaded segments or the full-quality file. These replace or supplement the initial single-quality stream.

13. **Thumbnail and metadata generation**: The server extracts a thumbnail frame, generates preview sprites for seek scrubbing, and runs any transcription.

---

## 2. Segment Format: fMP4 vs MPEG-TS

HLS supports two segment container formats: MPEG-2 Transport Stream (.ts) and fragmented MP4 (.m4s / fMP4). The choice matters for our architecture.

### MPEG-TS (.ts)

- The traditional HLS segment format, universally supported by all HLS players.
- Each .ts segment is fully self-contained: it includes PAT/PMT tables and can be decoded independently.
- Slightly larger than fMP4 due to container overhead (~188-byte packet structure).
- Loom uses .ts segments for their desktop app recordings.
- Generating .ts segments on macOS requires FFmpeg or a custom muxer --- AVAssetWriter does not natively produce .ts output.

### Fragmented MP4 (.m4s / fMP4)

- The modern format, specified in CMAF (Common Media Application Format). Supported by HLS version 7+ and all modern players including hls.js.
- Requires a separate initialisation segment (`init.mp4`) containing codec configuration, then media segments containing movie fragments.
- Slightly smaller and more efficient than .ts.
- **Natively supported by AVAssetWriter** on macOS 11+. Setting `outputFileTypeProfile` to `.mpeg4AppleHLS` produces compliant fMP4 segments directly from the hardware encoder, with no FFmpeg dependency.
- Compatible with both HLS and MPEG-DASH, should we ever want to support DASH.

### Recommendation: fMP4

Use fMP4 segments. The decisive factor is that **AVAssetWriter produces fMP4 natively** through its delegate pattern, which means we can generate HLS-compliant segments directly from the hardware H.264 encoder during recording with no intermediate file and no FFmpeg dependency on the client. This is simpler, more efficient, and lower-latency than piping through FFmpeg.

The tradeoff is that fMP4 HLS requires `#EXT-X-MAP` tags in the playlist (pointing to the init segment) and version 7+ compliance. This is fine --- all modern browsers via hls.js support this, and Safari has native fMP4 HLS support.

---

## 3. Client-Side Segmentation with AVAssetWriter

### Configuration

AVAssetWriter on macOS 11+ supports a delegate-based fragmented output mode designed specifically for HLS streaming. Here is the conceptual setup:

```
AVAssetWriter configuration:
  contentType: .mpeg4Movie
  outputFileTypeProfile: .mpeg4AppleHLS
  preferredOutputSegmentInterval: CMTime(seconds: 4, preferredTimescale: 1)
  initialSegmentStartTime: <recording start time with audio priming offset>
  delegate: <our segment handler>

Video input (AVAssetWriterInput):
  mediaType: .video
  outputSettings: H.264 compression via VideoToolbox
  expectsMediaDataInRealTime: true

Audio input (AVAssetWriterInput):
  mediaType: .audio
  outputSettings: AAC encoding
  expectsMediaDataInRealTime: true
```

### How Segments Are Delivered

When recording, AVAssetWriter calls the delegate method:

```
assetWriter(_:didOutputSegmentData:segmentType:segmentReport:)
```

The `segmentType` is either `.initialization` (sent once at the start, containing the `ftyp` and `moov` boxes) or `.separable` (sent every segment interval, containing `moof` + `mdat` boxes). The `segmentReport` provides timing metadata needed to construct the playlist --- specifically the segment duration and track information.

### Segment Duration

The `preferredOutputSegmentInterval` controls segment length. When encoding (not passthrough), AVAssetWriter forces a sync sample (keyframe / IDR frame) at or near each segment boundary, ensuring every segment starts with a keyframe and is independently decodable.

**Recommended: 4-second segments.** This balances:
- **Latency**: Shorter segments mean lower latency-to-playability. With 4-second segments, the first playable content is available ~4-5 seconds after recording starts.
- **Overhead**: Very short segments (1-2s) increase per-segment upload overhead and playlist size. Very long segments (10s+) delay initial playability.
- **Encoding efficiency**: Forcing keyframes every 4 seconds has minimal quality impact at typical recording bitrates.
- **Alignment with HLS conventions**: 4-6 seconds is standard for low-latency HLS. Apple's documentation suggests integer-second intervals.

### Known Issues

Two important bugs documented by Nonstrict (makers of Bezel):

1. **Memory leak in Swift delegate** (macOS 11 through 13.2): The `Data` object delivered to the delegate leaks when bridged from Objective-C to Swift. Workaround: implement the delegate in Objective-C, or call `segmentData.withUnsafeBytes { $0.baseAddress?.deallocate() }`. Fixed in macOS 13.3+. Since we target modern macOS, this should not be an issue, but worth testing.

2. **CMAF crash on Intel Macs** (macOS 12-13): When using `.mpeg4CMAFCompliant` profile with `expectsMediaDataInRealTime = true` and variable frame rate input (as ScreenCaptureKit produces), AVAssetWriter crashes on Intel Macs. Workaround: **use `.mpeg4AppleHLS` instead of `.mpeg4CMAFCompliant`**. The Apple HLS profile avoids this bug and is equally suitable for our purposes. We should use the Apple HLS profile.

### Audio Priming Offset

AAC encoding introduces audio priming samples (~2,112 samples at 48kHz, roughly 44ms). For the Apple HLS profile (which omits edit lists for backward compatibility), all sample timestamps need to be offset by a small amount (Apple suggests 2-10 seconds) to accommodate priming. Both `initialSegmentStartTime` and all appended CMSampleBuffer timestamps must be shifted by the same offset. This is a bookkeeping detail but important to get right for correct A/V sync.

### The Final Segment Problem

When recording stops, there is a partially filled segment that has not yet reached the `preferredOutputSegmentInterval` boundary. The solution:

1. Call `flushSegment()` on AVAssetWriter. This closes the current segment early and delivers it via the delegate, even if it is shorter than the target duration.
2. Call `finishWriting(completionHandler:)` to close the writer.
3. Upload the final (short) segment.
4. Notify the server that recording is complete.

The final segment may be anywhere from a fraction of a second to nearly 4 seconds long. The playlist's `#EXTINF` tag for this segment reflects its actual duration. This is normal and handled correctly by all HLS players.

---

## 4. Upload Protocol

### Per-Segment HTTPS Upload (Recommended)

Each segment is uploaded as an individual HTTPS request. This is the simplest approach and works well for our use case.

**Option A: Direct-to-S3 with pre-signed URLs**

1. During pre-recording setup, the server generates a batch of pre-signed S3 PUT URLs (e.g., 500 URLs, enough for ~33 minutes at 4-second segments).
2. The desktop app uploads each segment directly to S3 using the pre-signed URL.
3. The server is notified of each uploaded segment (via a lightweight API call or S3 event notification) and updates the playlist.

Advantages: The server does not handle segment data at all; segments go straight to S3/R2 storage. Minimal server load during recording.

Disadvantage: Requires pre-generating URLs (but we can generate more mid-recording if needed). S3 event notifications add slight complexity.

**Option B: Upload through the server**

1. The desktop app sends each segment to the server: `PUT /api/videos/{id}/segments/{number}`.
2. The server writes the segment to S3 and updates the playlist.

Advantages: Simpler flow, server has direct control over segment ordering and playlist updates.

Disadvantage: Server must handle all segment data throughput during recording. For a single-user tool, this is fine.

**Recommendation: Start with Option B for simplicity.** A single user recording at 2-4 Mbps generates ~1-2 MB per 4-second segment. Uploading 1-2 MB every 4 seconds via the server is trivial load. If performance becomes an issue, move to direct-to-S3 uploads later.

### Why Not tus?

The tus resumable upload protocol is designed for uploading a single large file with resume support. It is well-suited for uploading a complete MP4 after recording (e.g., the full-quality replacement, or imported videos). However, for our primary streaming-during-recording path, we are uploading many small independent files (segments), not resuming a single large file. tus adds unnecessary protocol overhead per segment.

**Use tus for**: Uploading the full-quality replacement file after recording. Uploading imported MP4 files via the admin interface.

**Use simple HTTPS PUT for**: Streaming segment uploads during recording.

### Segment Ordering

Segments are numbered sequentially (0, 1, 2, ...). The server only appends a segment to the playlist when all preceding segments have been received. If segment 5 arrives before segment 4, segment 5 is stored but not added to the playlist until segment 4 arrives. This guarantees the playlist always represents a contiguous, playable sequence.

In practice, segments are produced and uploaded sequentially by the desktop app, so out-of-order arrival is unlikely unless the network causes retransmission delays. But the server should handle it correctly regardless.

### Upload Concurrency

The desktop app should upload one segment at a time in order. There is no benefit to uploading multiple segments concurrently because they are produced sequentially and the playlist must reference them in order. A single-threaded upload worker with a queue is the right model.

If a segment upload takes longer than the segment interval (e.g., slow network), segments queue up on the client. This is handled by the network resilience design (Section 6).

---

## 5. Server-Side Handling

### Segment Storage

Segments are stored in S3-compatible object storage at a predictable path:

```
{videoId}/
  init.mp4           # Initialisation segment (ftyp + moov)
  seg_000.m4s        # Media segment 0
  seg_001.m4s        # Media segment 1
  ...
  stream.m3u8        # HLS playlist (updated as segments arrive)
```

### Playlist Management

The server maintains and serves the `.m3u8` playlist. The playlist evolves through three states:

**State 1: Recording in progress (EVENT playlist, no ENDLIST)**

```
#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:4
#EXT-X-PLAYLIST-TYPE:EVENT
#EXT-X-MAP:URI="init.mp4"

#EXTINF:4.000,
seg_000.m4s
#EXTINF:4.000,
seg_001.m4s
#EXTINF:4.000,
seg_002.m4s
```

Key properties:
- `EXT-X-PLAYLIST-TYPE:EVENT` means segments are only ever appended, never removed. This allows the player to seek back to the beginning at any time.
- No `EXT-X-ENDLIST` tag means the player treats this as a live/event stream and periodically re-fetches the playlist to discover new segments.
- `EXT-X-MAP` points to the initialisation segment, required for fMP4.
- `EXT-X-TARGETDURATION:4` declares the maximum segment duration (rounded up to the nearest integer).

**State 2: Recording complete (EVENT playlist with ENDLIST)**

```
#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:4
#EXT-X-PLAYLIST-TYPE:EVENT
#EXT-X-MAP:URI="init.mp4"

#EXTINF:4.000,
seg_000.m4s
#EXTINF:4.000,
seg_001.m4s
...
#EXTINF:2.340,
seg_047.m4s
#EXT-X-ENDLIST
```

Adding `#EXT-X-ENDLIST` tells the player the stream is complete. The player stops re-fetching the playlist and enables full seeking across the entire video.

**State 3: Fully processed (VOD with multi-bitrate master playlist)**

After background processing generates multiple renditions, the server creates a master playlist:

```
#EXTM3U
#EXT-X-VERSION:7

#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080
1080p/stream.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720
720p/stream.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=854x480
480p/stream.m3u8
```

Each rendition has its own media playlist and segments. The player automatically selects the best quality for the viewer's connection.

### Playlist Update Mechanics

When a segment upload completes:

1. Server confirms the segment is stored in S3.
2. Server reads the current playlist string, appends the new `#EXTINF` + segment URI line, and writes the updated playlist to S3 (overwriting the previous version).
3. CDN cache for the playlist should have a short TTL (1-2 seconds) during recording, or use cache invalidation on update.

When recording completes:

1. Server receives the "complete" signal from the desktop app.
2. Server appends the final segment entry and `#EXT-X-ENDLIST`.
3. Server sets a longer CDN cache TTL on the playlist (hours/days) since it will no longer change.
4. Server updates the video record in the database: status = `complete`.

### CDN Caching Strategy

During recording, the playlist changes every ~4 seconds. The segments themselves never change once written. This suggests:

- **Segments**: Long cache TTL (24 hours+). Once uploaded, a segment is immutable.
- **Init segment**: Long cache TTL. Never changes for a given recording.
- **Playlist (during recording)**: Short cache TTL (1-2 seconds) or `Cache-Control: no-cache` with `ETag` validation. The player re-fetches frequently during live playback.
- **Playlist (after completion)**: Long cache TTL. The finalised playlist is immutable.

The video page itself can check the video's status (recording / complete / processed) and serve appropriate player configuration. During recording, the player should be configured for live/event playback. After completion, standard VOD playback.

---

## 6. Network Resilience

### Core Principle: Never Lose Footage

The desktop app always maintains a complete local recording. The streaming upload is an optimistic optimisation --- if it fails, nothing is lost. The local recording can be uploaded in full after the fact.

### Scenario: Network Drops Mid-Recording

1. Recording continues locally without interruption. CMSampleBuffers keep flowing to AVAssetWriter.
2. The upload worker detects the failed upload (HTTP timeout / connection error).
3. Completed segments are queued in memory or on disk, waiting for connectivity to return.
4. The worker periodically probes connectivity (e.g., HEAD request to the server every 5-10 seconds with exponential backoff).
5. When connectivity returns, queued segments are uploaded in order. The server resumes appending them to the playlist.
6. From the viewer's perspective, the video may "stall" during the outage (no new segments in the playlist) and then catch up as the queued segments arrive.

### Scenario: Slow / Degraded Network

If upload speed drops below the segment production rate, segments accumulate in the queue:

1. **Queue depth monitoring**: The desktop app tracks how many segments are pending upload. If the queue grows beyond a threshold (e.g., 10 segments = 40 seconds of backlog), alert the user with a subtle indicator.
2. **No quality reduction during recording**: The streaming quality is already determined at recording start. We do not dynamically reduce quality mid-recording because that would complicate the segment stream with discontinuities.
3. **Graceful degradation**: The viewer sees the video lag behind the recording in real-time, but it remains playable. The gap catches up after recording stops or when bandwidth improves.
4. **Upload continues after recording stops**: If segments are still queued when the user stops recording, the upload worker continues draining the queue. The URL is technically "playable" once the first segments are up, but may not show the full recording until the queue is empty.

### Scenario: Complete Network Failure During Entire Recording

1. Recording completes locally with full quality.
2. No segments were uploaded (or only a partial set).
3. When the user is back online, the desktop app detects the incomplete upload and offers to upload the full recording.
4. This falls back to the single-file upload path: the complete local MP4 is uploaded (using tus for resumability), the server processes it into HLS, and the URL becomes functional.

### Upload State Machine

The desktop app tracks upload state per video:

```
IDLE
  -> STREAMING         (recording started, segments uploading)
  -> STREAMING_OFFLINE  (recording started, uploads failing)
  -> COMPLETING        (recording stopped, draining segment queue)
  -> COMPLETE          (all segments uploaded, server confirmed)
  -> FALLBACK_UPLOAD   (streaming failed, uploading full local file)
  -> DONE              (everything confirmed)
```

---

## 7. The Dual-Quality Approach

The requirements explicitly permit streaming at reduced quality during recording and replacing with the full-quality version afterward. This is worth evaluating.

### How It Works

1. **During recording**: The desktop app runs two AVAssetWriters concurrently:
   - **Streaming writer**: Configured for lower resolution/bitrate (e.g., 720p, 2 Mbps). Produces fMP4 segments uploaded in real-time.
   - **Local writer**: Configured for full quality (e.g., 1080p or source resolution, 8-10 Mbps). Writes to a local MP4 file.

2. **After recording stops**: The full-quality local file is uploaded (using tus). The server processes it into multi-bitrate HLS renditions.

3. **Quality upgrade**: The server replaces the streaming-quality playlist with the processed full-quality master playlist. The next viewer load gets the higher quality. Viewers who were watching the streaming version during or immediately after recording see the lower quality but still have a functional experience.

### Tradeoffs

**Advantages of dual-quality:**
- Reduced upload bandwidth during recording: 720p at 2 Mbps vs 1080p at 6+ Mbps. Roughly 3x less bandwidth.
- More headroom on slow connections, less likely to build a segment queue.
- Better battery usage from lower encoding overhead on the streaming writer (though two encoders run simultaneously, the lower-quality one is cheaper).

**Disadvantages of dual-quality:**
- Two concurrent AVAssetWriter instances increases complexity and CPU load (two hardware encoding sessions).
- The quality transition is visible to early viewers. The URL changes from 720p-only to multi-bitrate (with 1080p) after processing. This may cause a brief interruption or quality jump if the player is mid-stream.
- More code paths to maintain and test.
- The full-quality upload after recording negates some of the "instant" benefit --- the initial version is lower quality, and the high-quality version is not available until processing completes.

### Recommendation: Start Without Dual-Quality

For the initial implementation, **stream at full recording quality** (1080p, ~4-6 Mbps). Reasons:

1. **Simplicity**: One writer, one encoding pipeline, one upload path.
2. **Good enough for most scenarios**: At 4-6 Mbps, a 4-second segment is 2-3 MB. Most internet connections can upload 2-3 MB in well under 4 seconds.
3. **Acceptable degradation**: If the network is slow, segments queue and the viewer sees a delay, not lower quality. This is fine for the "paste URL in Slack" use case.
4. **Background processing still runs**: After recording, the server still generates multi-bitrate renditions. The initial stream is single-quality, but within minutes viewers get adaptive bitrate streaming.

Add dual-quality later if testing reveals that upload bandwidth is a frequent bottleneck. The architecture supports it --- it is an additive change (add a second writer) not a rearchitecture.

---

## 8. Alternative Approaches Evaluated

### Progressive MP4 Upload (Cap's Approach)

Cap uploads a growing MP4 file via S3 multipart upload during recording. The MP4 is not playable until the upload completes and the header is rewritten.

**Why this is worse**: The MP4 container puts the `moov` atom (required for playback) at the start or end of the file. During recording, the moov is incomplete. Cap skips uploading the first chunk, then re-uploads it after recording stops once the header is rewritten. This means the video is never playable until the full upload completes --- it fundamentally cannot achieve instant playback. This is the anti-pattern our architecture avoids.

### WebRTC (WHIP) Ingest

Use WebRTC's WHIP protocol to stream video to a media server, which then repackages it as HLS.

**Why this is worse for our use case**:
- WebRTC is designed for real-time bidirectional communication with sub-500ms latency. We do not need sub-500ms latency; 4-5 seconds is fine.
- WebRTC quality fluctuates based on network conditions --- the protocol is designed to degrade gracefully for real-time communication, which means the recorded quality is unpredictable. We want full-quality capture regardless of network conditions.
- Requires running a media server (MediaMTX, SRS, or similar) to receive the WebRTC stream and repackage it. This adds infrastructure complexity and a single point of failure.
- The media server becomes a stateful component that must be running during recording. If it goes down, the stream dies. With our segment-based approach, each segment is an independent upload --- the server just needs to accept HTTP requests.
- WebRTC (via browser APIs) cannot access native screen capture at full resolution on macOS. A native app would need to bridge to WebRTC, adding complexity without clear benefit.

WebRTC/WHIP could make sense if we were building a browser-based recorder, but we are building a native macOS app with direct access to better alternatives.

### Progressive MP4 with Byte-Range Serving

Record a standard MP4 with the moov atom at the front (using `shouldOptimizeForNetworkUse`), upload progressively, and use HTTP byte-range requests for playback.

**Why this is worse**: The moov atom size is not known until recording completes, because it contains the sample table for the entire video. With `shouldOptimizeForNetworkUse`, AVAssetWriter attempts to place the moov first, but it cannot finalise it until all samples are written. This means the file header is incomplete during recording, making byte-range playback impossible until the file is complete. This has the same fundamental problem as Cap's approach.

### Media Server as Intermediary (MediaMTX / SRS)

Run a media server that accepts RTMP/SRT ingest from the desktop app and produces HLS output.

**Why this is worse**:
- Adds a stateful server component that must be running and reachable during recording.
- Introduces an unnecessary protocol translation step (native capture -> RTMP encode -> RTMP transmit -> server decode/repackage -> HLS).
- MediaMTX/SRS are designed for multi-viewer, multi-stream live streaming at scale. We have one recorder and one stream. The complexity is not justified.
- Our approach is simpler: the desktop app produces HLS segments directly (via AVAssetWriter) and uploads them over HTTP. No intermediate protocol, no stateful server.

### Server-Side Transcoding of Raw Frames (WebSocket / SSE)

Stream raw or lightly compressed video frames to the server over WebSocket and transcode server-side.

**Why this is worse**: Raw or lightly compressed video at 1080p30 is 100+ Mbps. No residential upload connection can handle this. Even with heavy compression, the latency and bandwidth requirements make this impractical. Client-side encoding is the only viable approach for our use case.

### Summary: Why HLS Segment Upload Wins

The HLS segment approach is the right choice because:

1. **Each segment is independently playable**: The viewer can start watching after the first segment arrives, regardless of how long the recording continues.
2. **Standard format**: fMP4 HLS is supported by every modern browser via hls.js, and natively by Safari. No custom player logic needed.
3. **Native macOS support**: AVAssetWriter produces compliant fMP4 segments directly from the hardware encoder. No FFmpeg dependency on the client.
4. **Simple transport**: Each segment is an independent HTTPS upload. No persistent connections, no stateful servers, no custom protocols.
5. **Fault tolerance**: If a segment upload fails, only that segment is lost. The rest of the video is safe. (And the local recording has everything.)
6. **CDN-friendly**: Segments are static files served from CDN. The playlist is a small text file updated every few seconds.

This is exactly how Loom does it (with the difference that Loom uses FFmpeg to produce .ts segments, while we use AVAssetWriter to produce fMP4 segments natively).

---

## 9. Playlist Management Details

### HLS Playlist Types for Our Use Case

The HLS spec defines three playlist mutability levels:

| Type | Tag | Behavior | Our use |
|---|---|---|---|
| Live | (no type tag) | Segments can be appended and removed (sliding window) | Not used |
| Event | `#EXT-X-PLAYLIST-TYPE:EVENT` | Segments can only be appended, never removed. `#EXT-X-ENDLIST` added when complete. | **During recording** |
| VOD | `#EXT-X-PLAYLIST-TYPE:VOD` | Playlist is immutable. Must have `#EXT-X-ENDLIST`. | **After processing** |

We use **EVENT** during recording because:
- It allows appending new segments as they arrive.
- It preserves all segments from the beginning, so viewers can seek back.
- The player knows the stream is ongoing and re-fetches the playlist to discover new segments.
- When we add `#EXT-X-ENDLIST`, the player treats it as complete.

After background processing generates multi-bitrate renditions, the final playlist set is effectively VOD (immutable, all segments present, `#EXT-X-ENDLIST` included).

### Player Behavior with EVENT Playlists

When hls.js loads a playlist without `#EXT-X-ENDLIST`:
- It treats the stream as live/event.
- It starts playback from the beginning (not the live edge, since this is EVENT type, not a sliding-window live stream).
- It periodically re-fetches the playlist (interval = target duration or half target duration) to discover new segments.
- When `#EXT-X-ENDLIST` appears, it switches to VOD behavior: full seek bar, no more re-fetching.

This is exactly the behavior we want. A viewer who opens the URL during recording sees the video from the beginning and can watch it grow. A viewer who opens it after recording is complete sees a normal VOD video.

### Transition from Streaming to Processed

When background processing completes, the server has two versions of the video:
1. The original streaming segments (single quality, from the recording).
2. The processed multi-bitrate renditions (multiple qualities, from FFmpeg).

The URL should transparently serve whichever is available:
- Before processing: serve the streaming playlist directly.
- After processing: serve the master playlist (which points to the multi-bitrate renditions).

The switch is atomic from the viewer's perspective --- the playlist URL stays the same, but its content changes from a single media playlist to a master playlist. Any viewer who refreshes or starts a new playback session gets the processed version. A viewer mid-playback on the streaming version will not be interrupted; they continue playing the single-quality stream until they reload.

---

## 10. Achievable Latency

"Latency" here means: how many seconds between the user hitting "stop" and the URL being fully playable?

### Best Case (Good Network)

| Step | Time |
|---|---|
| Final segment flush + encode | ~200ms |
| Final segment upload (2-3 MB on good connection) | ~500ms-1s |
| Server playlist finalisation | ~100ms |
| CDN propagation | ~200-500ms |
| **Total** | **~1-2 seconds** |

The URL was already allocated before recording started. The first N-1 segments were already uploaded during recording. Only the final segment and playlist finalisation add latency after stopping.

### Typical Case (Average Network)

| Step | Time |
|---|---|
| Final segment flush + encode | ~200ms |
| Final segment upload (2-3 MB) | ~1-2s |
| Any queued segments still uploading | 0-10s |
| Server playlist finalisation | ~100ms |
| CDN propagation | ~500ms |
| **Total** | **~2-4 seconds** (if no queue backlog) |

### Worst Case (Slow Network / Backlog)

If segments queued during recording, the total wait is the time to drain the queue plus the final segment. With a 10-segment backlog at 4 seconds each (40 seconds of video), and upload speed of 2 MB/s, draining takes ~15-20 seconds. The URL is "playable" immediately (from the segments already uploaded), but the full recording is not available until the queue drains.

### Comparison with Loom

Loom achieves link shareability within 1-3 seconds of stopping. Our architecture should match this on a good network. Loom's advantage is years of optimisation on their pipeline; our advantage is a simpler architecture (single user, no scale concerns).

---

## 11. Technical Risks and Unknowns

### Risk 1: AVAssetWriter Segment Reliability Under Load

AVAssetWriter's fragmented output mode is designed for this use case, but it has had bugs (the CMAF crash, the Swift memory leak). We are relying on it as the only segmentation path. Mitigation: use the `.mpeg4AppleHLS` profile (not CMAF) to avoid the known crash; target macOS 13.3+ to avoid the memory leak; keep the local recording as a complete backup.

### Risk 2: Mode Switching Mid-Recording

Our requirements call for switching between camera-only, screen+camera, and screen-only modes during a single recording. This may require stopping and restarting AVAssetWriter (or its inputs), which could create discontinuities in the segment stream. The HLS spec handles this via `#EXT-X-DISCONTINUITY` tags, but the interaction with AVAssetWriter's delegate-based segmentation needs testing. If mode switching causes AVAssetWriter issues, we may need to maintain one writer per mode and stitch the resulting segments together with discontinuity markers.

### Risk 3: Audio-Video Sync with Segment Boundaries

AAC audio priming and the segment boundary alignment between video and audio tracks need careful handling. If the audio and video in a segment are not properly aligned, players may exhibit A/V sync drift. The `AVAssetSegmentReport` provides timing metadata to help construct correct playlist entries, but this needs thorough testing across different recording durations and modes.

### Risk 4: CDN Cache Invalidation During Recording

The playlist file changes every 4 seconds during recording. If the CDN caches a stale version, viewers may not see new segments. Options:
- Use a very short TTL (1-2 seconds) for the playlist during recording.
- Use query-string cache busting (e.g., `stream.m3u8?v={timestamp}`).
- Serve the playlist through the server (not CDN) during recording, and only CDN-serve it after completion.

The best approach depends on the CDN provider. With Cloudflare R2 or S3 + CloudFront, we can use short TTLs or custom cache policies per path.

### Risk 5: Upload Credentials Expiry

Pre-signed S3 URLs have expiry times. For long recordings (30+ minutes), URLs generated at recording start may expire before all segments are uploaded. Mitigation: generate URLs with generous expiry (2+ hours), or have the desktop app request fresh URLs mid-recording when the current batch is running low.

### Unknown 1: Hardware Encoder Capacity

Running AVAssetWriter with hardware H.264 encoding during screen capture may compete for VideoToolbox encoder sessions with other applications. On Apple Silicon Macs, the media engine has dedicated capacity, so this is likely fine. Needs testing under realistic conditions (recording while other apps use video, e.g., a Zoom call).

### Unknown 2: Optimal Bitrate for Streaming Segments

The right bitrate balances upload speed vs quality. For 1080p screen content (sharp text, gradients), 4-6 Mbps is typical. For camera-only (talking head), 2-3 Mbps is sufficient. Since we support mode switching, we may want to adjust the encoding bitrate per mode, or use a single bitrate that works for both. Testing with real content will inform the right defaults.

---

## 12. Relevant Tools and Libraries

### Client-Side (macOS Desktop App)

| Tool | Purpose |
|---|---|
| AVAssetWriter | Fragmented fMP4 segment generation with `.mpeg4AppleHLS` profile |
| ScreenCaptureKit | macOS screen capture (display, window, system audio) |
| AVCaptureDevice / AVCaptureSession | Camera and microphone capture |
| VideoToolbox | Hardware H.264 encoding (used implicitly by AVAssetWriter) |
| URLSession | HTTPS segment upload |

### Server-Side

| Tool | Purpose |
|---|---|
| FFmpeg | Multi-bitrate HLS rendition generation, thumbnail extraction, format conversion |
| tus-node-server | Resumable upload for full-quality files and MP4 imports |
| hls.js (client-side) | HLS playback in non-Safari browsers |
| Vidstack | Video player UI component (wraps hls.js) |
| S3-compatible storage (R2, S3) | Segment and playlist storage |
| CDN (CloudFront, Cloudflare) | Segment and playlist delivery |

### Protocols

| Protocol | Use |
|---|---|
| HLS (RFC 8216) | Video delivery format (fMP4 segments + m3u8 playlists) |
| HTTPS PUT/POST | Segment upload during recording |
| tus 1.0 | Resumable upload for full-quality file and imports |

---

## 13. Relationship to Other Tasks

- **macOS Recording APIs (Task 01)**: The capture pipeline produces CMSampleBuffers that feed into AVAssetWriter. The segment output from AVAssetWriter is what this upload pipeline consumes. The two must be designed together.
- **Cap Codebase Analysis (Task 03)**: Cap's progressive MP4 approach is the anti-pattern we avoid. Their recording pipeline (ScreenCaptureKit, audio handling, frame management) is still a useful reference for capture, but not for upload.
- **Video Hosting (Task 04)**: If we use a managed service like Mux, the server-side handling changes significantly --- Mux can accept HLS segments directly and handle all delivery. If self-hosted, we handle playlist management and CDN delivery ourselves. The client-side segmentation and upload approach remains the same either way.

---

## Sources

- RFC 8216: HTTP Live Streaming (Apple/IETF, 2017)
- WWDC 2020 Session 10011: Author fragmented MPEG-4 content with AVAssetWriter
- Apple Developer Documentation: AVAssetWriter, outputFileTypeProfile, preferredOutputSegmentInterval, flushSegment()
- Nonstrict: "AVAssetWriter leaking memory when segment data is used in Swift" (2023)
- Nonstrict: "AVAssetWriter crash creating CMAF compliant segments" (2023)
- tus.io: Resumable Upload Protocol 1.0
- Loom Engineering Blog: "Behind the Scenes: Building Loom for Desktop"
- Cap codebase analysis: docs/research/03-cap-codebase-analysis.md
- Loom research: docs/research/loom-research.md
