# Video Processing & Encoding

*Research date: 2026-03-30*

---

## Context and Scope

The Build vs Buy decision (Task 04) recommends Mux with RTMP live ingest as the primary architecture. Mux handles transcoding, rendition generation, CDN delivery, and adaptive bitrate streaming. This means server-side encoding is not our primary concern for the initial build.

However, we still need to understand encoding deeply for three reasons:

1. **Client-side output**: The desktop app must produce video in a format suitable for RTMP push to Mux (and as a local archive). The codec, profile, bitrate, and keyframe settings we choose in AVAssetWriter directly affect stream quality, upload bandwidth, and Mux's processing speed.
2. **Screen recording specifics**: Screen content (text, UI, sharp edges) has fundamentally different encoding characteristics than camera content (faces, natural motion). We need settings that handle both well, particularly given mid-recording mode switching.
3. **Self-hosted fallback**: If we migrate from Mux later, we need to run our own FFmpeg pipeline. Understanding the rendition ladder, encoding commands, and pipeline architecture now means the migration path is well-defined.

This document covers client-side encoding configuration for the desktop app, the codec landscape, screen recording considerations, the self-hosted FFmpeg fallback pipeline, and recommended quality settings.

---

## 1. Codec Landscape

### H.264 (AVC)

**Status**: The universal baseline. Supported by every browser, every device, every player, every service. Hardware encoding and decoding are ubiquitous across all Apple Silicon, Intel, AMD, and NVIDIA hardware.

**Compression**: Roughly 5-8 Mbps for good 1080p30 quality. Not the most efficient codec, but the most compatible.

**Licensing**: Licensed through MPEG LA patent pool. Free for internet video that is free to the end user (which covers our use case).

**Our use**: Primary codec for recording, RTMP ingest, and playback. No reason to use anything else for the initial build.

### H.265 (HEVC)

**Status**: Mature successor to H.264. Delivers 25-40% better compression at equivalent quality.

**Browser support**: Partial and inconsistent. Safari has full support (13+). Chrome 107+ and Firefox 137+ support it, but only with hardware decoder availability. This means it works on most modern machines but cannot be assumed universal.

**Licensing**: Complex patent licensing through multiple pools (MPEG LA, Access Advance, individual patent holders). This has been the primary barrier to adoption. The licensing situation makes many open-source projects avoid it.

**Encoding speed**: Comparable to H.264 on Apple Silicon hardware encoders (VideoToolbox handles both natively with dedicated media engine silicon). Software encoding (x265) is 2-5x slower than x264.

**Our use**: Not recommended as the primary codec. The browser support gaps make it unsuitable as the only delivery format. Apple Silicon's VideoToolbox can encode HEVC as efficiently as H.264 (both use the dedicated media engine), so there is a future opportunity to offer HEVC as a secondary rendition for Safari/Apple device viewers once Mux or a self-hosted pipeline can serve multiple codec variants. But this is an optimisation, not a launch requirement.

### AV1

**Status**: The most efficient codec available. Royalty-free (no licensing fees). Delivers ~50% better compression than H.264 and ~30% better than H.265.

**Browser support**: Strong and growing. Chrome 70+, Firefox 67+, Edge 121+, Opera 57+. Safari 17+ supports it, but only on devices with hardware decoders (M3+ Macs, iPhone 15 Pro+, A17+ iPads). Global browser support is approximately 95%.

**Encoding speed**: The critical problem. Software encoding (libaom, SVT-AV1) is 5-10x slower than H.264 or H.265. Hardware encoding is emerging (Intel Arc, NVIDIA Ada Lovelace, AMD RDNA 3) but Apple Silicon does not have a hardware AV1 encoder -- only a decoder on M3+. This means we cannot encode AV1 in real-time on the desktop, and server-side AV1 encoding is expensive.

**Our use**: Not practical for recording or real-time ingest. Interesting as a future delivery codec for bandwidth savings once hardware encoding becomes more available. If we self-host later, we could generate AV1 renditions as a background processing step for on-demand viewing, but the encoding cost is significant.

### VP9

**Status**: Google's codec, primarily used by YouTube and WebRTC. Royalty-free. Delivers compression between H.264 and AV1 (roughly comparable to H.265).

**Browser support**: Good in Chrome, Firefox, Edge, Opera. No Safari support (Apple skipped VP9 entirely, going from H.264 to HEVC to AV1).

**Our use**: No role in our architecture. The Safari gap is a problem, and AV1 is the better royalty-free option for the future. VP9's main relevance is WebRTC, which we are not using.

### Recommendation

**Use H.264 (AVC) as the sole codec.** It is universally supported, fast to encode on Apple Silicon hardware, compatible with RTMP ingest to Mux, and well understood. Mux's transcoding pipeline may generate HEVC or AV1 renditions on its end for viewers whose devices support them -- we do not need to worry about this.

If we self-host later, add HEVC renditions as a secondary option for modern devices. AV1 renditions are worth considering once Apple Silicon includes hardware AV1 encoding.

---

## 2. Client-Side Encoding: AVAssetWriter Configuration

The desktop app uses AVAssetWriter in fragmented MP4 (fMP4) mode to produce HLS segments during recording. These segments serve two purposes:

1. **RTMP path (primary)**: The desktop app pushes an RTMP stream to Mux using HaishinKit or a similar Swift RTMP library. AVAssetWriter feeds encoded frames to the RTMP encoder. The encoding settings must match Mux's ingest requirements.
2. **Direct HLS path (fallback/self-hosted)**: If we ever use the direct segment upload architecture (see Task 02), AVAssetWriter produces fMP4 segments uploaded via HTTPS. The segments must be independently decodable and HLS-compliant.
3. **Local archive**: The same encoded output is saved locally as a backup. Quality should be good enough that this local copy can be used as the source for later processing if needed.

### Recommended Video Settings

```
Codec: H.264 (kCMVideoCodecType_H264)
Profile: High Profile, Auto Level
  (kVTProfileLevel_H264_High_AutoLevel)
Bitrate: 6 Mbps average (screen+camera modes)
  (kVTCompressionPropertyKey_AverageBitRate: 6_000_000)
Peak bitrate: 12 Mbps (200% of average, per Apple HLS spec)
  (kVTCompressionPropertyKey_DataRateLimits)
Keyframe interval: 2 seconds
  (kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration: 2.0)
  (kVTCompressionPropertyKey_MaxKeyFrameInterval: 60 for 30fps)
Entropy coding: CABAC
  (kVTH264EntropyMode_CABAC)
B-frames: Allowed (encoder default)
Frame rate: 30 fps for camera, 30 fps for screen
  (can capture at variable rate from ScreenCaptureKit, but encode at fixed 30fps)
Resolution: 1920x1080 (see resolution section below)
Pixel format: NV12 (kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange)
Color space: BT.709
Real-time encoding: Yes
  (kVTCompressionPropertyKey_RealTime: true)
Hardware acceleration: Yes (implicit with VideoToolbox on Apple Silicon)
```

### Recommended Audio Settings

```
Codec: AAC-LC
Sample rate: 48,000 Hz
Channels: Stereo (2)
Bitrate: 128 kbps
  (For talking-head content, 128 kbps AAC-LC is transparent quality.
   Higher bitrates waste bandwidth with no perceptible benefit for speech.)
```

### Why These Settings

**High Profile**: Apple's HLS authoring specification recommends High Profile in preference to Main or Baseline. High Profile enables 8x8 integer transforms and CABAC entropy coding, yielding 15-25% bitrate savings over Main Profile at equivalent quality. All modern Apple devices (2013+) support High Profile. Mux's documentation recommends Main Profile for RTMP ingest, but High Profile is also accepted and produces better quality per bit. We use High Profile.

**6 Mbps average bitrate**: This is a balance between quality and upload bandwidth.

- For 1080p30 screen content with text and UI, 4-5 Mbps produces good quality (large flat areas compress very efficiently).
- For 1080p30 camera content with face/motion, 5-6 Mbps is the sweet spot for high-quality talking-head video.
- 6 Mbps handles both modes well. At 4-second segments, each segment is approximately 3 MB, which is uploadable in well under 4 seconds on most connections.
- Mux recommends up to 5 Mbps for 1080p30 RTMP, but accepts higher bitrates. We use 6 Mbps to ensure screen recording quality (where text sharpness matters) is excellent.
- At our recording volumes (~75 videos/month, ~3 min average), the storage impact is roughly 135 MB per 3-min video, or ~10 GB/month. This is fine.

**2-second keyframe interval**: Both Mux and Apple's HLS spec recommend 2-second keyframe intervals. This enables:

- Fine-grained seeking in the resulting video (seek granularity = keyframe interval).
- Compatibility with Mux's ingest pipeline, which expects keyframes at regular, short intervals.
- Efficient adaptive bitrate switching (the player can switch quality at any keyframe boundary).
- For the direct HLS segment path, the segment interval (4 seconds) is an even multiple of the keyframe interval (2 seconds), ensuring every segment starts with a keyframe.

**200% peak bitrate**: Apple's HLS authoring spec states that for VOD content, peak bitrate should be no more than 200% of average bitrate. This allows the encoder headroom for complex scenes (sudden screen content changes, fast camera movement) while keeping overall file sizes predictable.

**30 fps**: For screen recording, 30 fps is standard and sufficient. Screen content often changes at lower rates (ScreenCaptureKit delivers frames only when the screen changes), but encoding at a fixed 30 fps ensures consistent playback timing and avoids variable frame rate complications with AVAssetWriter's HLS segment mode. For camera content, 30 fps is the standard for talking-head video and is what viewers expect.

### Resolution Strategy

The desktop app should record at 1920x1080 regardless of source resolution. Reasons:

- **Retina displays**: A 2560x1440 logical display is 5120x2880 physical pixels. Recording at native Retina resolution produces enormous files and is unnecessary for viewing on typical displays. 1080p is the right delivery resolution.
- **H.264 limits**: VideoToolbox H.264 encoding has a maximum resolution of 4096x2304. Retina resolutions can exceed this.
- **Mux compatibility**: Mux's standard tier supports up to 1080p (2048x2048 pixels). Recording at higher resolutions forces Mux to downscale anyway.
- **Scaling**: ScreenCaptureKit's `SCStreamConfiguration` supports configuring the output resolution directly, and VideoToolbox's `VTPixelTransferSession` provides GPU-accelerated scaling when needed.

For camera-only mode, record at the camera's native resolution up to 1080p. Most webcams are 1080p or 720p. If the camera is 720p, record at 720p -- do not upscale.

For screen+camera composite mode, the output is 1080p (the screen capture is the base layer, the camera overlay is composited on top).

### Mode-Specific Bitrate Considerations

The desktop app supports three recording modes with different encoding characteristics:

| Mode | Content Type | Ideal Bitrate | Notes |
|---|---|---|---|
| Camera + Mic | Talking head, natural motion | 3-4 Mbps | Faces compress well. Could use lower bitrate, but 6 Mbps keeps things simple. |
| Screen + Mic | UI, text, code, occasional motion | 4-6 Mbps | Sharp text needs quality. Flat areas compress efficiently, but screen transitions can spike bitrate. |
| Screen + Camera + Mic | Composite: screen base + camera overlay | 5-6 Mbps | Mixed content. The camera overlay adds complexity to the screen encoding. |

**Recommendation: Use a single bitrate (6 Mbps) for all modes.** Reasons:

1. **Simplicity**: One encoding configuration across all modes avoids needing to change AVAssetWriter settings during mode switches (which may require restarting the writer).
2. **Mode switching**: If we adjust bitrate per mode, switching mid-recording introduces discontinuities. A consistent bitrate produces a more predictable stream.
3. **Quality headroom**: 6 Mbps is slightly more than camera-only needs, but the overhead is small (a few hundred KB per segment) and ensures that screen content with dense text always looks sharp.
4. **Bandwidth**: At 6 Mbps, a 4-second segment is ~3 MB. This is well within the upload capacity of most broadband connections.

If testing reveals that 6 Mbps is too aggressive for slower networks, we can add a quality preset system (High: 6 Mbps, Medium: 4 Mbps, Low: 2 Mbps at 720p) in the desktop app settings. But start with one setting.

---

## 3. RTMP Ingest to Mux

The primary path for the Mux architecture is RTMP push from the desktop app. Here are the specifics.

### Mux RTMP Endpoints

- **Standard**: `rtmp://global-live.mux.com:5222/app` (note: port 5222, not the standard RTMP port 1935)
- **Secure**: `rtmps://global-live.mux.com:443/app`

Use RTMPS (TLS-encrypted) for security. The stream key is appended to the URL or passed as a separate parameter depending on the RTMP library.

### Mux Encoding Requirements

Mux accepts a wide range of input settings but recommends the following for optimal processing:

| Parameter | Recommendation |
|---|---|
| Video codec | H.264 or HEVC |
| Audio codec | AAC |
| Video profile | Main or High Profile |
| Max average bitrate | 8 Mbps for 1080p (our 6 Mbps is well within this) |
| Max peak bitrate | 16 Mbps per GOP |
| Max keyframe interval | 20 seconds (we use 2 seconds, which is ideal) |
| Frame rate | 5-120 fps (we use 30 fps) |
| Color | 8-bit 4:2:0 (our NV12 output matches this) |
| Max resolution | 1080p / 2048x2048 for standard tier |

Our recommended settings (H.264 High Profile, 6 Mbps average, 2-second keyframes, 30 fps, 1080p, AAC 128 kbps) are well within Mux's accepted range and align with their recommendations for fast processing.

### Mux Processing Behavior

When receiving an RTMP live stream:

1. Mux transcodes the incoming stream to HLS in real-time.
2. The stream is watchable within seconds of the first frames arriving.
3. Standard latency is approximately 30 seconds glass-to-glass (the delay between the moment something is recorded and when a viewer sees it). This is fine for our use case.
4. When the stream ends, Mux automatically converts it to a VOD asset with no re-encoding delay.
5. The VOD asset includes adaptive bitrate renditions generated by Mux.

### Desktop App RTMP Implementation

The desktop app needs an RTMP library to push the encoded stream. Options:

- **HaishinKit** (Swift, MIT license): The most popular Swift RTMP library. Supports RTMPS, H.264+AAC encoding via VideoToolbox, and has been used in production apps. This is the recommended choice.
- **Custom implementation**: RTMP is a well-documented protocol, but implementing it from scratch is unnecessary given HaishinKit's maturity.

The flow is:

1. AVCaptureSession / ScreenCaptureKit produce raw frames (CMSampleBuffers).
2. The compositing pipeline (Core Image + Metal) produces the final frame.
3. HaishinKit (or the RTMP library) encodes the frame via VideoToolbox and pushes it over RTMP.
4. Simultaneously, AVAssetWriter saves the same frames to a local fMP4 file as the backup.

Note: This means we run two encoding sessions simultaneously -- one for RTMP (via the RTMP library's built-in encoder) and one for local recording (via AVAssetWriter). On Apple Silicon, the media engine supports multiple concurrent hardware encoding sessions, so this should not be a performance issue. However, if it proves too resource-intensive, we could use a single encoder feeding both outputs, or encode once and tee the output. This is an implementation detail to test during development.

---

## 4. HLS Segment Format

This section covers the segment format for both the direct HLS upload architecture (fallback/self-hosted path) and the post-processing pipeline.

### fMP4 vs MPEG-TS

As established in Task 02, we use **fragmented MP4 (fMP4)** segments, not MPEG-TS (.ts).

| Property | fMP4 (.m4s) | MPEG-TS (.ts) |
|---|---|---|
| Native AVAssetWriter support | Yes (.mpeg4AppleHLS profile) | No (requires FFmpeg) |
| Container overhead | Lower | Higher (~5-15% larger) |
| Modern HLS support | HLS version 7+ (all modern players) | HLS version 1+ (universal) |
| CMAF compatibility | Yes | No |
| Dual HLS/DASH support | Yes (CMAF enables both) | No |
| Initialization segment | Required (separate init.mp4) | Not needed (self-contained) |

fMP4 is the right choice because AVAssetWriter produces it natively. For the self-hosted fallback pipeline (FFmpeg), fMP4 is also preferred -- modern FFmpeg fully supports fMP4 HLS output via the `-hls_segment_type fmp4` flag.

### Segment Duration

**4 seconds**, matching the `preferredOutputSegmentInterval` configured in AVAssetWriter.

This balances:

- **Latency**: First playable content appears ~4-5 seconds after recording starts.
- **Upload efficiency**: Each segment is ~3 MB at 6 Mbps, manageable on most connections.
- **Seeking granularity**: Combined with 2-second keyframes, seeking is precise to within 2 seconds.
- **Playlist size**: A 3-minute video has ~45 segments. A 30-minute video has ~450. Both are manageable playlist sizes.

For the self-hosted FFmpeg pipeline, segment duration should also be 4 seconds for consistency.

---

## 5. Screen Recording Encoding Specifics

Screen recordings have fundamentally different visual characteristics than camera footage, and understanding these differences informs encoding decisions.

### How Screen Content Differs from Camera Content

| Characteristic | Screen Recording | Camera (Talking Head) |
|---|---|---|
| Motion level | Low (mostly static, bursts during scrolling/transitions) | Moderate (head movement, gestures, subtle motion) |
| Spatial complexity | High (sharp text, thin lines, precise pixel patterns) | Medium (soft focus, smooth gradients on skin/backgrounds) |
| Color palette | Often limited (UI colors, code syntax highlighting) | Natural, broad range (skin tones, lighting) |
| Temporal redundancy | Very high (most frames are identical or nearly so) | Moderate (constant subtle changes in face/body) |
| Sensitivity to compression | Text and UI elements show artifacts at low bitrates (ringing around sharp edges, color bleeding on thin lines) | Faces are forgiving; slight softness is less noticeable |

### Encoding Implications

**H.264 handles screen content well at moderate bitrates.** The high temporal redundancy in screen recordings means inter-frame compression is very effective. Most of the bitrate budget goes to keyframes and scene changes (scrolling, window switches), while static frames compress to almost nothing.

**Where screen content struggles**: Sharp text rendered at 1080p with anti-aliasing can show compression artifacts at low bitrates. The edges between text and background are high-frequency detail that the DCT-based compression in H.264 can blur. This is why we use 6 Mbps rather than the 3-4 Mbps that would suffice for camera-only content.

**Variable frame rate consideration**: ScreenCaptureKit delivers frames only when the screen content changes. If nothing changes for 2 seconds, no new frames are delivered. This is efficient for capture but creates variable frame rate (VFR) output. VFR can cause issues with:

- AVAssetWriter's segment timing (segments may have inconsistent frame counts).
- RTMP streams (RTMP expects relatively consistent frame delivery).
- Some players and editors that assume constant frame rate.

**Recommendation**: Encode at a constant 30 fps regardless of screen activity. When ScreenCaptureKit does not deliver a new frame, repeat the previous frame (or let AVAssetWriter/VideoToolbox handle this automatically via its real-time encoding mode). This ensures consistent segment sizes and timing. The Nonstrict blog documents this pattern: when no new frame arrives within the frame interval, the previous frame's display time is extended, and VideoToolbox handles the repeat efficiently (essentially zero bits for identical frames in inter-frame coding).

### x264 `-tune` Flag (FFmpeg, for self-hosted pipeline)

When transcoding screen recordings with FFmpeg, the `x264` encoder has a `-tune` parameter that optimizes for specific content types. The most relevant options:

- **`-tune animation`**: Useful for content with large flat areas and sharp edges (UI, slides, simple graphics). Increases `deblocking` strength and adjusts reference frame handling.
- **`-tune stillimage`**: For mostly static content. Extremely high compression on still frames.
- **No specific "screen" tune in x264**: Unlike x265 (which has `--tune screen`), x264 does not have a dedicated screen content mode. Use `-tune animation` or no tune for screen recordings.

For our self-hosted fallback pipeline, we can detect the recording mode (screen vs camera) from metadata and apply different FFmpeg presets.

---

## 6. Self-Hosted Fallback: FFmpeg Pipeline

If we migrate from Mux to self-hosted, we need to build an FFmpeg transcoding pipeline. This section describes the architecture, rendition ladder, commands, and operational considerations.

### Architecture

```
Recording completes
    |
    v
Server receives notification
    |
    v
Job enqueued (database-backed job queue)
    |
    v
Worker picks up job
    |
    v
FFmpeg transcoding (multiple renditions)
    |
    v
Thumbnail generation
    |
    v
Master playlist creation
    |
    v
Upload to R2 / CDN storage
    |
    v
Video status: "processed"
```

The pipeline should use a simple database-backed job queue (not a heavyweight message broker). For our single-user tool, a PostgreSQL-backed queue with row-level locking is sufficient. Jobs have states: `pending`, `processing`, `complete`, `failed`. Failed jobs include the error message and can be retried manually.

### Rendition Ladder

For a personal video tool with mostly 1080p screen recordings and talking-head content, three renditions are sufficient. Adding more has diminishing returns and increases storage costs.

| Rendition | Resolution | Bitrate (avg) | Bitrate (max) | Audio | Use Case |
|---|---|---|---|---|---|
| 1080p | 1920x1080 | 5,000 kbps | 10,000 kbps | 128 kbps AAC | Desktop/tablet, good connection |
| 720p | 1280x720 | 2,800 kbps | 5,600 kbps | 128 kbps AAC | Mobile, moderate connection |
| 480p | 854x480 | 1,400 kbps | 2,800 kbps | 96 kbps AAC | Slow connection, low bandwidth |

These bitrates are derived from Apple's HLS authoring specification and widely-used production ladders, adjusted for our content type (screen recordings and talking heads are less demanding than cinematic content).

For camera-only recordings at 720p source resolution (common webcam resolution), skip the 1080p rendition -- do not upscale. Generate only 720p and 480p.

### FFmpeg Commands

**Single command generating all renditions** (recommended for efficiency -- one decode pass, multiple encode outputs):

```bash
ffmpeg -i input.mp4 \
  -filter_complex \
    "[0:v]split=3[v1080][v720][v480]; \
     [v1080]scale=1920:1080:flags=lanczos[v1080out]; \
     [v720]scale=1280:720:flags=lanczos[v720out]; \
     [v480]scale=854:480:flags=lanczos[v480out]" \
  -map "[v1080out]" -map 0:a -c:v libx264 -preset fast -crf 23 \
    -profile:v high -level 4.2 -g 48 -keyint_min 48 -sc_threshold 0 \
    -b:v 5000k -maxrate 10000k -bufsize 7500k \
    -c:a aac -b:a 128k -ar 48000 -ac 2 \
    -f hls -hls_time 4 -hls_playlist_type vod -hls_segment_type fmp4 \
    -hls_fmp4_init_filename "1080p_init.mp4" \
    -hls_segment_filename "1080p/seg_%03d.m4s" "1080p/stream.m3u8" \
  -map "[v720out]" -map 0:a -c:v libx264 -preset fast -crf 23 \
    -profile:v high -level 4.1 -g 48 -keyint_min 48 -sc_threshold 0 \
    -b:v 2800k -maxrate 5600k -bufsize 4200k \
    -c:a aac -b:a 128k -ar 48000 -ac 2 \
    -f hls -hls_time 4 -hls_playlist_type vod -hls_segment_type fmp4 \
    -hls_fmp4_init_filename "720p_init.mp4" \
    -hls_segment_filename "720p/seg_%03d.m4s" "720p/stream.m3u8" \
  -map "[v480out]" -map 0:a -c:v libx264 -preset fast -crf 23 \
    -profile:v high -level 3.1 -g 48 -keyint_min 48 -sc_threshold 0 \
    -b:v 1400k -maxrate 2800k -bufsize 2100k \
    -c:a aac -b:a 96k -ar 48000 -ac 2 \
    -f hls -hls_time 4 -hls_playlist_type vod -hls_segment_type fmp4 \
    -hls_fmp4_init_filename "480p_init.mp4" \
    -hls_segment_filename "480p/seg_%03d.m4s" "480p/stream.m3u8"
```

**Key flags explained**:

| Flag | Purpose |
|---|---|
| `-preset fast` | Balances encoding speed and compression efficiency. `fast` is roughly 2x faster than `medium` with ~5% larger files. For a personal tool, this is the right tradeoff. |
| `-crf 23` | Constant Rate Factor for quality targeting. 23 is the x264 default and produces good quality. Combined with `-maxrate` and `-bufsize`, this becomes "capped CRF" -- CRF determines quality but bitrate never exceeds the cap. |
| `-profile:v high` | H.264 High Profile for best compression per bit. |
| `-g 48 -keyint_min 48` | Keyframe every 48 frames (= 1.6 seconds at 30fps). Combined with `-sc_threshold 0` (disable scene change detection for keyframes), this ensures consistent keyframe placement aligned with segment boundaries. |
| `-sc_threshold 0` | Prevents the encoder from inserting extra keyframes on scene changes. This keeps keyframe intervals predictable, which is important for consistent segment sizes and smooth ABR switching. |
| `-bufsize` | VBV buffer size, set to 1.5x the target bitrate. Controls how quickly the encoder can react to bitrate constraints. |
| `-hls_segment_type fmp4` | Use fMP4 segments instead of MPEG-TS. |
| `-hls_time 4` | Target segment duration of 4 seconds. |
| `-hls_playlist_type vod` | Generate a complete VOD playlist with `#EXT-X-ENDLIST`. |

### Master Playlist

After generating all renditions, create a master playlist:

```m3u8
#EXTM3U
#EXT-X-VERSION:7

#EXT-X-STREAM-INF:BANDWIDTH=5128000,AVERAGE-BANDWIDTH=5128000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"
1080p/stream.m3u8

#EXT-X-STREAM-INF:BANDWIDTH=2928000,AVERAGE-BANDWIDTH=2928000,RESOLUTION=1280x720,CODECS="avc1.640029,mp4a.40.2"
720p/stream.m3u8

#EXT-X-STREAM-INF:BANDWIDTH=1496000,AVERAGE-BANDWIDTH=1496000,RESOLUTION=854x480,CODECS="avc1.64001f,mp4a.40.2"
480p/stream.m3u8
```

The `BANDWIDTH` values include both video and audio bitrates. The `CODECS` strings identify the specific H.264 profile/level and AAC codec for each rendition, enabling the player to select appropriately.

### Thumbnail Generation

**Single poster thumbnail** (extracted from approximately 2 seconds into the video, avoiding black/empty first frames):

```bash
ffmpeg -ss 2 -i input.mp4 -frames:v 1 -q:v 2 thumbnail.jpg
```

The `-ss` flag before `-i` enables fast seeking by keyframe. `-q:v 2` produces high-quality JPEG output.

**Sprite sheet for seek preview** (one thumbnail every 5 seconds, arranged in a grid):

```bash
# Extract thumbnails at 160x90 every 5 seconds
ffmpeg -i input.mp4 -vf "fps=1/5,scale=160:90" -q:v 5 thumb_%04d.jpg

# Combine into a sprite sheet (10 columns)
# Use ImageMagick or a script to tile the images:
montage thumb_*.jpg -tile 10x -geometry 160x90+0+0 sprite.jpg
```

The sprite sheet approach is more efficient than individual thumbnail files: a single HTTP request loads the entire preview sprite. A companion WebVTT file maps time ranges to sprite coordinates, enabling the seek preview feature in Vidstack.

**WebVTT file format** for sprite thumbnails:

```vtt
WEBVTT

00:00:00.000 --> 00:00:05.000
sprite.jpg#xywh=0,0,160,90

00:00:05.000 --> 00:00:10.000
sprite.jpg#xywh=160,0,160,90

00:00:10.000 --> 00:00:15.000
sprite.jpg#xywh=320,0,160,90
```

This is generated programmatically based on the video duration and the number of thumbnails extracted.

### Hardware Acceleration (Server-Side)

If the processing server has hardware encoding capabilities:

- **NVIDIA GPU (NVENC)**: Use `-c:v h264_nvenc` instead of `libx264`. NVENC is 5-10x faster than software encoding with slightly lower compression efficiency (~10-15% larger files at equivalent quality). For a personal tool processing ~75 videos/month, the speed gain is not critical. Software encoding on a modern VPS is fast enough.
- **VideoToolbox (macOS)**: If processing on a Mac, use `-c:v h264_videotoolbox`. This uses the dedicated media engine and is very fast. If we process on the same Mac that records, this is free (no VPS needed).
- **VAAPI (Intel/AMD on Linux)**: Use `-c:v h264_vaapi`. Similar tradeoffs to NVENC.

**Recommendation**: Start with software encoding (`libx264 -preset fast`) on the server. It produces the best quality per bit and is sufficient for our volumes. A 3-minute 1080p video encodes in roughly 30-60 seconds with `-preset fast` on a modern 4-core VPS. If we want to process on the Mac itself (saving the VPS cost), VideoToolbox hardware encoding is extremely fast.

### Processing Time Estimates

For a typical 3-minute 1080p30 source video, generating three renditions:

| Encoding Method | Estimated Time | Hardware |
|---|---|---|
| libx264 `-preset fast` (software) | 60-90 seconds | 4-core VPS (Hetzner CX22) |
| libx264 `-preset medium` (software) | 120-180 seconds | 4-core VPS |
| h264_videotoolbox (Mac hardware) | 15-25 seconds | Apple Silicon Mac |
| h264_nvenc (NVIDIA hardware) | 10-20 seconds | NVIDIA GPU server |

These are rough estimates for generating all three renditions from a single decode pass. Actual times depend on content complexity, server load, and specific hardware.

### Error Handling

The processing pipeline must handle:

- **Corrupt input**: If the source file is truncated or corrupt (e.g., network interrupted the upload), FFmpeg will error. The job should be marked as `failed` with the error message. The desktop app retains the local copy, so a re-upload can be attempted.
- **Disk space**: Check available disk space before starting a job. A 3-minute video at three renditions produces approximately 200-300 MB of output. The server should have comfortable headroom.
- **Encoding crash**: If FFmpeg segfaults (rare but possible with unusual input), the job should be retried once, then marked as `failed`.
- **Partial output**: If the job fails partway through, clean up any partial output files before retrying.

### Making Video Playable Before Processing Completes

In the self-hosted path, the initial recording (uploaded as fMP4 segments during recording, or as a complete file afterward) should be playable immediately at single-quality. The multi-bitrate renditions are generated as a background processing step. The transition from single-quality to multi-bitrate is handled by swapping the playlist (see Task 02, Section 5, "Transition from Streaming to Processed").

---

## 7. Desktop App Quality Presets

For the initial build, use a single encoding configuration (the 6 Mbps settings described in Section 2). If testing reveals that network conditions vary significantly, add user-selectable quality presets:

| Preset | Resolution | Video Bitrate | Upload per 4s Segment | Use Case |
|---|---|---|---|---|
| **High** (default) | 1920x1080 | 6 Mbps | ~3 MB | Good connection (10+ Mbps upload) |
| **Medium** | 1280x720 | 3 Mbps | ~1.5 MB | Moderate connection (5+ Mbps upload) |
| **Low** | 854x480 | 1.5 Mbps | ~0.75 MB | Slow connection (2+ Mbps upload) |

Audio settings remain constant across presets (AAC 128 kbps). The quality difference between presets is primarily in resolution and video bitrate.

The preset affects only the streaming/RTMP output. The local recording should always be at the highest quality the hardware supports, so the full-quality file is available for later processing regardless of the streaming preset.

---

## 8. Codec and Format Choices: Summary Table

| Decision | Choice | Rationale |
|---|---|---|
| Primary codec | H.264 (AVC) | Universal support, fast hardware encoding on Apple Silicon, Mux/RTMP compatible |
| Future secondary codec | H.265 (HEVC) | 25-40% better compression; add when self-hosting for modern device renditions |
| Container (recording) | Fragmented MP4 (fMP4) | Native AVAssetWriter support, HLS-compliant, more efficient than .ts |
| Container (delivery) | fMP4 HLS | Modern standard, compatible with hls.js and all browsers |
| H.264 profile | High Profile, Auto Level | Best compression per bit, supported by all devices since 2013 |
| Keyframe interval | 2 seconds | Mux recommendation, enables fine seeking, aligned with HLS spec |
| Segment duration | 4 seconds | Low latency, manageable upload size, standard for low-latency HLS |
| Video bitrate (recording) | 6 Mbps average, 12 Mbps peak | Good quality for screen text and camera content |
| Audio codec | AAC-LC, 128 kbps, 48 kHz stereo | Universal support, transparent quality for speech |
| Frame rate | 30 fps constant | Standard for screen recording and webcam content |
| Resolution | 1920x1080 (or source resolution if lower) | Standard delivery resolution, within Mux limits |

---

## 9. Open Questions

### Dual Encoding Sessions on Apple Silicon

The RTMP path requires encoding for the RTMP stream (via HaishinKit/VideoToolbox) while simultaneously encoding for local file backup (via AVAssetWriter/VideoToolbox). Apple Silicon's media engine supports multiple concurrent encoding sessions, but we need to verify:

- How many concurrent H.264 encoding sessions does the M-series media engine support?
- Is there measurable quality degradation when running two sessions?
- If there is a limit, can we use a single encode session and tee the output to both RTMP and local file?

This should be tested early in desktop app development.

### Mode Switching and Encoding Continuity

Switching between camera-only, screen+camera, and screen-only modes mid-recording changes the video input characteristics (resolution, content type, motion level). Questions:

- Does the VideoToolbox encoder handle resolution changes within a single session? (Likely not -- may need to insert `#EXT-X-DISCONTINUITY` in the HLS stream.)
- Does the RTMP stream tolerate mid-stream resolution or aspect ratio changes? (RTMP does not natively support this; may need to maintain a consistent output resolution and composite/scale inputs to fit.)
- If we maintain 1920x1080 output regardless of mode (scaling camera-only to fill the frame), this problem goes away. The encoding session stays consistent and only the visual content changes.

**Likely solution**: Always output at 1920x1080 regardless of mode. Camera-only mode shows the camera full-frame at 1080p (or centered/scaled from webcam resolution). Screen-only shows the screen at 1080p. Screen+camera shows the composite at 1080p. The encoder never sees a resolution change.

### Bitrate Tuning

The 6 Mbps recommendation is based on research and industry standards, but should be validated with real recordings. Create sample recordings of each mode (screen with dense code/text, screen with video playback, talking head in good lighting, talking head in poor lighting) and evaluate quality at 4, 5, 6, and 8 Mbps. The goal is to find the lowest bitrate where text is sharp and faces look natural.

---

## Sources

- Apple HLS Authoring Specification for Apple Devices (developer.apple.com/documentation/http-live-streaming/hls-authoring-specification-for-apple-devices)
- Apple WWDC 2020 Session 10011: Author fragmented MPEG-4 content with AVAssetWriter
- Apple WWDC 2021: Explore low-latency video encoding with VideoToolbox
- Mux Documentation: Configure broadcast software (mux.com/docs/guides/configure-broadcast-software)
- Mux Documentation: Minimize processing time (mux.com/docs/guides/minimize-processing-time)
- Streaming Learning Center: Apple Makes Sweeping Changes to HLS Encoding Recommendations
- Streaming Learning Center: CRF Guide (slhck.info/video/2017/02/24/crf-guide.html)
- Can I Use: HEVC, AV1, VP9 browser compatibility tables
- FFmpeg HLS muxer documentation (ffmpeg.org/ffmpeg-formats.html#hls-2)
- MediaCMS transcoding pipeline (github.com/mediacms-io/mediacms)
- Task 01: macOS Recording APIs (docs/research/01-macos-recording-apis.md)
- Task 02: Streaming Upload Architecture (docs/research/02-streaming-upload-architecture.md)
- Task 03: Cap Codebase Analysis (docs/research/03-cap-codebase-analysis.md)
- Task 04: Video Hosting Build vs Buy (docs/research/04-video-hosting-build-vs-buy.md)
- Task 10: Open Source Video Platforms (docs/research/10-open-source-video-platforms.md)
