# Cap Codebase Analysis

*Research date: 2026-03-30*

---

## 1. Architecture Overview

Cap is a Tauri-based desktop app (Rust backend + web frontend) with a Next.js web app for hosting, viewing, and managing recordings. The codebase is a monorepo using pnpm workspaces and a Cargo workspace.

### Top-Level Structure

- **`apps/desktop/`** — Tauri desktop app (Rust in `src-tauri/`, web UI alongside)
- **`apps/web/`** — Next.js web app (viewer pages, API routes, admin dashboard)
- **`apps/cli/`** — CLI tool
- **`crates/`** — ~30 Rust crates comprising the core recording, rendering, encoding, and media logic
- **`packages/`** — Shared TypeScript packages (database schema via Drizzle, web backend logic using Effect-TS, UI components, utilities)
- **`infra/`** — Infrastructure/deployment configuration

### Key Technology Choices

| Component | Technology |
|---|---|
| Desktop app shell | Tauri 2.5 (Rust + web view) |
| Recording pipeline | Rust, using `cidre` (Rust bindings to Apple frameworks: ScreenCaptureKit, AVFoundation, CoreMedia, VideoToolbox) |
| Camera capture | `nokhwa` (Rust webcam library, forked by Cap) |
| Audio capture | `cpal` (Rust audio library, forked by Cap) |
| Encoding | AVFoundation (macOS native), FFmpeg (via `ffmpeg-next` Rust bindings), MediaFoundation (Windows) |
| GPU rendering | `wgpu` for compositing and rendering |
| Web server | Next.js 15 on Vercel |
| Database | MySQL via Drizzle ORM |
| Object storage | S3-compatible (AWS S3 or custom buckets like R2) |
| CDN | CloudFront (signed URLs) |
| Backend logic | Effect-TS (functional effect system) |
| Analytics | Tinybird |
| Auth | NextAuth + WorkOS |

---

## 2. Desktop App — Recording Pipeline

### Two Distinct Recording Modes

Cap has two fundamentally different recording modes with completely separate codebases:

**Studio Mode** (`crates/recording/src/studio_recording.rs`) — Records screen, camera, microphone, system audio, and cursor data as *separate* streams into individual files within a project directory. This is designed for post-recording editing: the raw feeds are composited later in Cap's built-in editor (camera overlay position, zoom effects, cursor highlighting, background styling). Studio mode does NOT upload during recording.

**Instant Mode** (`crates/recording/src/instant_recording.rs`) — Records screen + optional microphone + optional system audio into a single combined MP4 file (`output.mp4`). The camera feed is baked into the video at recording time (no post-editing). This mode is designed for quick share workflows and supports progressive upload during recording.

### macOS Screen Capture

The macOS capture pipeline is in `crates/recording/src/sources/screen_capture/macos.rs` and uses Apple's ScreenCaptureKit via the `cidre` crate — Rust bindings to Apple's Objective-C/Swift frameworks. This is NOT the older `screencapturekit-rs` crate (that's commented out in the Cargo.toml); they migrated to `cidre` which provides deeper access to Apple frameworks including CoreMedia, CoreVideo, and VideoToolbox.

Key details:

- **Screen capture** uses `SCStreamConfiguration` and `SCContentFilter` from ScreenCaptureKit to capture display or window content
- **Pixel format** is NV12 (YUV 4:2:0), which is hardware-native for macOS
- **Frame scaling** uses VideoToolbox's `VTPixelTransferSession` for GPU-accelerated scaling when the output resolution differs from the capture resolution
- **Pixel buffer pools** (`CVPixelBufferPool`) are pre-allocated for efficiency, with configurable pool sizes (default 20 buffers)
- **Frame buffering** uses a configurable buffer depth (default 15 frames, max queue depth 8) to handle capture-to-encode timing differences
- Capture targets: full display, specific window, area selection, or camera-only

### Camera Capture

Camera is handled by `nokhwa` (forked by Cap) via `crates/camera/`. The camera feed is managed as a shared resource (`CameraFeed` / `CameraFeedLock`) that can be locked by the recording pipeline. For studio mode, camera is recorded to a separate file. For instant mode on macOS, camera frames are baked into the output using `AVFoundationCameraMuxer`.

### Microphone & Audio

Audio capture uses `cpal` (also forked by Cap for a macOS fix ensuring streams actually stop on drop). The microphone feed is similarly a shared lockable resource. System audio capture is handled through ScreenCaptureKit's audio capture capability.

Audio handling is detailed with gap detection and silence insertion:
- Separate gap thresholds for wired (70ms) and wireless (160ms) audio sources
- Automatic silence frame insertion when gaps are detected (up to 1 second max)
- Sample-based timestamp generation for drift-free audio timing

### Encoding (macOS)

Two main encoding paths on macOS:

1. **AVFoundation MP4 Muxer** (`output_pipeline/macos.rs`) — Uses `cap-enc-avfoundation` for hardware-accelerated H.264 encoding via VideoToolbox, writing to a single MP4 file. Used for both studio mode (individual stream files) and instant mode (combined output). Has configurable buffer sizes (60 frames for studio, 240 for instant mode).

2. **Fragmented M4S Muxer** (`output_pipeline/macos_fragmented_m4s.rs`) — Uses FFmpeg's H264 encoder to produce fragmented MP4 segments (3-second default segment duration, H264 ultrafast preset). Used for studio mode's "crash recovery" option, where segments are written individually so recording can be recovered if the app crashes. This is NOT used for HLS streaming upload.

### Pause/Resume

**Studio mode** implements pause by *stopping the current segment pipeline entirely* and creating a *new segment pipeline* on resume. Each pause/resume creates a new numbered segment with its own files for screen, camera, audio, and cursor data. The metadata tracks segment start/end times. This means pausing is reliable but heavyweight — it's a full pipeline teardown and rebuild.

**Instant mode** has simpler pause: it sets a pause flag on the output pipeline, which causes the muxer to stop accepting frames. Resume clears the flag. The single output file continues growing.

### Camera Overlay / Picture-in-Picture

Camera compositing in Cap is done differently depending on the mode:

- **Studio mode**: Camera is recorded as a separate stream. Compositing happens in the editor/renderer (`crates/rendering/`) using wgpu GPU shaders. The overlay position, shape, and size are configurable in the editor after recording.
- **Instant mode on macOS**: Uses `AVFoundationCameraMuxer` to compose the camera directly into the output during recording. This bakes the camera position in — it cannot be changed after recording.

### Mode Switching Mid-Recording

**Cap cannot switch recording modes mid-recording.** The choice between Studio and Instant is made before recording starts and cannot be changed. Within studio mode, you can change camera and microphone inputs, but only while *paused* — the code explicitly returns an error if you try to change inputs while recording is active:

```
"Pause the recording before changing microphone input"
"Pause the recording before changing camera input"
```

This is a significant limitation relative to our requirements for seamless mode switching (camera-only to screen+camera to screen-only) during a single recording.

### Quality Assessment: Recording Pipeline — Solid

The recording pipeline is the most sophisticated part of Cap's codebase. The use of native Apple APIs via `cidre` for screen capture and encoding is a good architectural choice. The actor-based concurrency model (using `kameo`) for managing recording state is clean. The pipeline builder pattern for constructing recording configurations is well-designed.

Concerns:
- The split between Studio and Instant modes creates significant code duplication
- The fragmented M4S muxer uses FFmpeg's software encoder (ultrafast preset) rather than hardware encoding, which is wasteful on macOS
- There are many forked dependencies (`cpal`, `nokhwa`, `cidre`, `reqwest`, `posthog-rs`, `wgpu-hal`, `tao`) which creates maintenance burden

---

## 3. Upload & Streaming Mechanism

### Instant Mode: Progressive MP4 Upload (NOT HLS)

This is a critical finding: **Cap does NOT use HLS streaming upload.** Unlike Loom, which converts to HLS segments during recording and uploads them progressively, Cap uploads the raw MP4 file progressively using S3 multipart upload.

The mechanism (in `apps/desktop/src-tauri/src/upload.rs`):

1. **Before recording starts**: The desktop app calls `/api/desktop/video/create` to pre-create a video record on the server and get a shareable URL. The URL is generated before any recording happens.

2. **During recording**: `InstantMultipartUpload::spawn()` starts a background task that watches the growing MP4 file on disk. It uses `from_pending_file_to_chunks()` which:
   - Polls the filesystem every 100ms for new data
   - Reads chunks of 5-15 MB from the file as it grows
   - Uploads each chunk as an S3 multipart upload part (up to 5 concurrent uploads)
   - **Crucially: skips uploading the first chunk initially**, because MP4 headers at the start of the file are rewritten when recording stops (moov atom relocation)

3. **After recording stops**:
   - A completion signal is sent via a `flume` channel
   - The uploader reads the remaining data
   - It re-reads and re-uploads the first chunk of the file (now with correct headers)
   - Calls `upload_multipart_complete` to finalize the S3 multipart upload

4. **Fallback**: If the progressive upload fails, the entire file is uploaded as a standard multipart upload after recording completes.

### Why This Is Not "Instant"

Cap's approach has a fundamental problem: the video is NOT immediately playable at the URL when recording stops. The server receives an MP4 file via S3 multipart upload, but:
- The MP4 must be fully uploaded before it's playable (S3 multipart upload is not streamable)
- There's no HLS conversion, no segment-by-segment playback
- The viewer page must wait for the upload to complete
- For a 5-minute recording, there's a noticeable delay after stopping before the video is watchable

This contrasts sharply with Loom's approach where HLS segments are individually playable as they arrive, making the video watchable almost immediately after recording stops.

### Studio Mode: Post-Recording Upload

Studio recordings go through a completely different flow:
1. Recording produces separate files (screen video, camera video, microphone audio, system audio, cursor data) in a project directory
2. User opens the built-in editor to adjust camera position, apply zoom effects, etc.
3. User explicitly exports/uploads the video
4. The export process renders the final composited video using wgpu + FFmpeg
5. The rendered MP4 is then uploaded via standard multipart upload

### Network Interruption Handling

The upload code has several resilience mechanisms:
- Failed chunks are tracked and retried after the main upload pass
- 5-minute timeout for network recovery (`NETWORK_RECOVERY_TIMEOUT`)
- Exponential backoff for connectivity probing (2s initial, 30s max)
- MD5 hash verification for custom S3 endpoints
- Corrupt MP4 repair via FFmpeg remux if the output file is damaged

### Quality Assessment: Upload — Adequate but Fundamentally Limited

The multipart upload implementation is reasonably well-engineered with retry logic and error handling. However, the fundamental approach of uploading a growing MP4 file is inferior to Loom's HLS segment approach for achieving instant playback. The MP4 header rewrite dance (upload everything except the first chunk, then re-upload it at the end) is clever but fragile — it depends on the MP4 muxer placing the moov atom at the start of the file and on the rewrite happening correctly.

---

## 4. Server — Video Receiving & Processing

### Server Stack

- **Framework**: Next.js 15 (App Router) deployed on Vercel
- **Database**: MySQL via Drizzle ORM
- **Backend logic**: Effect-TS — a functional effect system (the server code heavily uses `Effect.gen`, `Effect.flatMap`, `Effect.catchTags` patterns)
- **Storage**: S3-compatible object storage (AWS S3, or custom buckets like Cloudflare R2 for self-hosting)
- **CDN**: CloudFront with signed URLs

### Video Creation & Upload Flow

1. Desktop app calls `GET /api/desktop/video/create?recordingMode=desktopMP4` — creates a database record for the video and returns the video ID
2. Desktop app calls `POST /api/upload/multipart/initiate` with the video ID — initiates an S3 multipart upload and returns an upload ID
3. For each chunk, desktop calls `POST /api/upload/multipart/presign-part` to get a pre-signed S3 URL, then uploads directly to S3
4. Desktop calls `POST /api/upload/multipart/complete` with all part ETags to finalize the upload
5. A thumbnail (screenshot) is uploaded separately via a single PUT to S3

### Video Processing — Minimal

A significant finding: **Cap does very little server-side video processing.** There's no:
- Server-side transcoding or multi-bitrate encoding
- HLS rendition generation on the server
- FFmpeg processing pipeline on the server
- Adaptive bitrate streaming generation

The `source` field on the video record indicates the type:
- `desktopMP4` — direct MP4 from desktop app, served as-is
- `webMP4` — MP4 uploaded from web
- `MediaConvert` — legacy: previously used AWS MediaConvert for processing (still referenced in playlist generation code)
- `local` — has an HLS manifest (`.m3u8`) in S3, likely from an older recording pipeline that did produce segments

For `desktopMP4` sources (which is what the current desktop app produces), the video is served as a direct MP4 redirect from S3 via CloudFront signed URL. No adaptive streaming, no multi-quality renditions.

### Transcription

Cap uses Deepgram (`@deepgram/sdk`) for transcription. The transcription result is stored as a VTT file in S3 alongside the video. Transcription status is tracked per-video (`PROCESSING`, `COMPLETE`, `ERROR`, `SKIPPED`, `NO_AUDIO`).

### Quality Assessment: Server Processing — Problematic

The server does almost nothing with the video. This means:
- No adaptive bitrate streaming — viewers get the full-resolution MP4 regardless of their connection speed
- No video optimization or re-encoding for web delivery
- The legacy MediaConvert code path is still in the codebase but appears largely unused for new recordings
- No HLS master playlist with multiple quality levels for modern recordings

The server is essentially a thin layer over S3 — it creates database records, generates pre-signed URLs, and serves redirect responses. This keeps infrastructure costs low but significantly limits the viewing experience.

---

## 5. Storage & Delivery

### Storage Layout

Videos are stored in S3 at the path `{ownerId}/{videoId}/`:
- `result.mp4` — the uploaded video file (for `desktopMP4` source type)
- `screenshot/screen-capture.jpg` — thumbnail
- `transcription.vtt` — subtitles (if transcribed)
- `enhanced-audio.mp3` — enhanced audio (if processed)
- `combined-source/stream.m3u8` + `.ts` segments — HLS (for `local` source type, legacy)
- `output/video_recording_000.m3u8` — MediaConvert output (legacy)

### CDN & Delivery

- CloudFront with signed URLs for the default bucket
- Custom S3 buckets supported for self-hosted/enterprise users (each with their own credentials stored encrypted in the database)
- Signed URLs provide time-limited access
- The playlist API (`/api/playlist`) acts as a proxy, resolving the video source type and redirecting to the appropriate signed S3 URL

### Video Page (Viewer)

The viewer is at `/s/[videoId]` (`apps/web/app/s/[videoId]/page.tsx`). It's a Next.js server-rendered page that:

1. Fetches the video record from the database
2. Checks access policy (public/private/password-protected/organization-restricted)
3. Renders metadata for SEO and social unfurling:
   - Open Graph tags (`og:image`, `og:video`, `og:title`)
   - Twitter Card tags (player card with streaming URL)
   - Thumbnail via `/api/video/og?videoId=...`
   - Video source via `/api/playlist?videoId=...`
4. Renders the Share component with:
   - Video player (using `hls.js` for HLS sources, direct MP4 for others)
   - Sidebar with comments, transcript, summary/chapters
   - Toolbar with sharing and management controls

### Video Player

The client-side player (`Share.tsx`) uses `media-chrome` for the player UI and `hls.js` for HLS playback. For MP4 sources, it uses a direct `<video>` element with the MP4 URL. Analytics tracking sends view events to Tinybird.

### Link Previews

Metadata generation is solid — both Open Graph and Twitter Card tags are generated server-side in `generateMetadata()`. The OG image is generated dynamically via `/api/video/og`. The Twitter player card includes a streaming URL pointing to the playlist API.

### Quality Assessment: Delivery — Adequate

The delivery layer is functional but basic:
- CloudFront + signed URLs is a good pattern for CDN delivery
- Custom bucket support is useful for self-hosting
- The viewer page is well-structured with proper SEO tags
- But the lack of adaptive bitrate streaming means viewers may struggle on slow connections
- The dependency on the Next.js server for playlist URL resolution means video delivery is NOT independent of the backend — if Vercel is down, videos are inaccessible (the signed URLs are short-lived and generated server-side)

---

## 6. Architecture & Code Quality

### What's Solid

1. **Recording crate architecture**: The separation of concerns between capture sources, output pipelines, and muxers is well-designed. The trait-based abstraction (`MakeCapturePipeline`, `Muxer`, `VideoMuxer`, `AudioMuxer`) allows different platform implementations to share core pipeline logic.

2. **Actor model for recording state**: Using `kameo` actors to manage recording state (Recording/Paused/Stopped transitions) provides clean concurrency semantics and prevents state corruption.

3. **Pipeline builder pattern**: The `OutputPipeline::builder()` pattern for constructing recording configurations is ergonomic and type-safe.

4. **Audio gap handling**: The gap detection and silence insertion logic is well thought out, with different thresholds for wired vs wireless audio sources.

5. **Frame drop tracking**: Detailed monitoring of frame drops with windowed rate calculation and threshold warnings.

6. **Recovery mechanisms**: Both corrupt MP4 repair (via FFmpeg remux) and crash recovery (via fragmented M4S segments) show attention to reliability.

### What's Hacky or Problematic

1. **Forked dependency sprawl**: Cap maintains forks of `cpal`, `nokhwa`, `cidre`, `reqwest`, `posthog-rs`, `wgpu-hal`, and `tao`. Each fork is pinned to a specific commit. This creates enormous maintenance burden and makes upgrading dependencies difficult.

2. **Effect-TS overuse on the server**: The web backend uses Effect-TS pervasively. While Effect is a powerful abstraction, it makes the server code significantly harder to read and debug. Simple operations like "get video by ID" involve multiple layers of Effect combinators, services, and policies. For a personal tool, this is unnecessary complexity.

3. **Dual recording mode complexity**: Having Studio and Instant as completely separate code paths with different file formats, upload mechanisms, and viewer handling creates significant surface area for bugs and maintenance burden.

4. **Legacy code paths**: The server still has code for MediaConvert processing, `local` source type HLS, `xStreamInfo` fields, and various deprecated database columns. These aren't cleaned up.

5. **Database schema complexity**: The schema has grown organically with team features (organizations, members, invites, spaces, shared videos), comments, notifications, analytics — far more than a personal tool needs.

6. **Tauri overhead**: While Tauri is better than Electron, the Rust-to-JavaScript bridge still adds overhead and complexity. The web view frontend communicates with the Rust backend via Tauri commands, which requires careful serialization/deserialization at the boundary.

### Technical Debt

- The `videos` table has many deprecated columns (`awsRegion`, `awsBucket`, `videoStartTime`, `audioStartTime`, `jobId`, `jobStatus`)
- Multiple source types (`MediaConvert`, `local`, `desktopMP4`, `webMP4`) with different playback paths
- The rendering crate (`cap-rendering`) uses wgpu for GPU compositing, which is powerful but adds significant binary size and complexity
- ~30 Rust crates in the workspace, many of which are thin wrappers or platform-specific implementations that could be consolidated

---

## 7. Features & Gaps

### What Cap Has That We Want

| Feature | Cap's Implementation | Quality |
|---|---|---|
| Screen capture (display, window, area) | ScreenCaptureKit via cidre | Solid |
| Camera capture | nokhwa | Adequate |
| Microphone capture | cpal | Adequate |
| System audio capture | ScreenCaptureKit | Solid |
| Camera overlay (PiP) | wgpu compositing (studio), AVFoundation (instant) | Solid |
| Pause/resume | Segment-based (studio), flag-based (instant) | Adequate |
| Progressive upload | S3 multipart of growing MP4 | Adequate |
| Pre-created shareable URL | Created before recording starts | Good |
| S3 + CloudFront storage/CDN | With signed URLs | Good |
| Viewer page with OG tags | Next.js SSR | Good |
| Transcription | Deepgram | Good |
| Built-in video editor | wgpu rendering + export | Solid (but not needed) |
| Custom cursor capture | Separate cursor event stream | Clever |
| Recovery from crashes | Fragmented M4S segments | Good |

### What Cap Has That We Don't Want

- Team/organization features, spaces, shared videos, invites
- Comments and reactions on videos
- Complex editor with zoom effects, cursor highlighting, background styling
- Screenshot capture mode
- Password-protected videos
- Analytics dashboards (Tinybird)
- The full multi-tenant SaaS infrastructure

### What Cap Lacks That We Need

1. **Mode switching mid-recording**: Cap cannot switch between camera-only, screen+camera, and screen-only during a single recording. This is our key differentiator.

2. **True instant playback**: Cap's progressive MP4 upload does not achieve Loom-level instant playback. The video is not watchable until the full MP4 is uploaded and the S3 multipart upload is completed.

3. **HLS streaming upload**: Cap does not convert to HLS segments during recording. This is the approach Loom uses and what we need for true instant playback.

4. **Adaptive bitrate streaming**: No multi-quality renditions. Viewers get the source resolution MP4 or nothing.

5. **Backend-independent delivery**: Cap's video delivery depends on the Next.js server being up to generate signed URLs and resolve playlists. Videos are not accessible when the server is down.

6. **Slug-based URLs**: Cap uses opaque video IDs (`/s/{nanoid}`), not user-friendly slugs like `v.danny.is/welcome-to-the-team`.

7. **301 redirects on slug change**: No concept of slug management or redirects.

8. **MP4 download of any video**: Not straightforward in Cap's architecture since studio recordings require export/render first.

---

## 8. Lessons Learned

### Things to Adopt

1. **Native Apple API usage for capture**: Using ScreenCaptureKit directly (rather than through wrapper crates) is the right approach. Cap's use of `cidre` to access `SCStream`, `VTPixelTransferSession`, and `CVPixelBufferPool` demonstrates the level of API access needed. We'll do the same in Swift, which will be even more natural.

2. **Pre-created video IDs and URLs**: Allocating the video ID and URL before recording starts is a good pattern. We should do this too, so the URL can be on the clipboard before recording even begins.

3. **Actor-based recording state management**: The state machine approach (Recording → Paused → Stopped) with message-passing is clean and prevents race conditions. We can use Swift actors for the same purpose.

4. **Audio gap detection and silence insertion**: Cap's approach to detecting and filling audio gaps (especially with different thresholds for wired vs wireless) is well-designed and worth adopting.

5. **Frame drop monitoring**: The windowed frame drop rate tracking is useful for diagnosing performance issues during recording.

6. **Corrupt file recovery**: The FFmpeg remux repair approach for corrupted MP4 files is a practical safety net.

7. **Disk space monitoring**: Checking available disk space before and during recording to prevent silent failures.

### Things to Avoid

1. **Progressive MP4 upload instead of HLS**: This is Cap's biggest architectural mistake for the "instant URL" use case. The MP4 header rewrite dance and S3 multipart upload path cannot achieve true instant playback. We must use HLS segment upload like Loom does.

2. **Two separate recording modes with different codebases**: Having Studio and Instant as completely different pipelines creates maintenance burden and limits functionality. We should have a single recording pipeline that always captures all available inputs, with the compositing decisions made at playback/export time.

3. **Forking upstream dependencies**: Cap's approach of maintaining forks of 7+ dependencies is unsustainable. We should use upstream crates where possible and contribute fixes upstream rather than maintaining forks.

4. **Effect-TS on the server**: The functional effect system adds complexity without proportionate benefit for a personal tool. We should use straightforward server code.

5. **Tauri for a media-heavy app**: The web view bridge adds latency and complexity for something that fundamentally needs deep OS integration. Our choice of native Swift is correct.

6. **No server-side video processing**: Serving source-resolution MP4 files directly is fine for low traffic, but we should at least generate HLS renditions for adaptive streaming.

### Things to Do Differently

1. **HLS from the start**: Our recording pipeline should output HLS segments (`.ts` files + `.m3u8` playlist) that are uploaded individually as they're produced. Each segment is independently playable. When recording stops, we finalize the playlist and the video is immediately watchable from the first segment.

2. **Single unified pipeline**: Instead of separate Studio/Instant modes, record all inputs simultaneously to separate tracks, then compose at delivery time. The raw inputs (screen, camera, mic) are always captured; the viewing experience (camera overlay position, screen-only vs camera-only) is determined by metadata, not by the capture pipeline.

3. **Server-side HLS generation**: After the streaming upload completes, the server should generate multi-bitrate HLS renditions in the background. The initial playback uses the uploaded segments; the optimized renditions replace them once processing completes.

4. **CDN-first architecture**: Videos should be playable directly from CDN without hitting our server. The HLS manifests and segments should be served from S3/R2 via CloudFront, with the manifest being a static file that doesn't require server-side URL signing.

5. **Native Swift from the ground up**: Rather than bridging through Tauri, use AVFoundation, ScreenCaptureKit, and VideoToolbox directly in Swift for maximum performance and minimal overhead.

---

## 9. Summary

Cap is an ambitious open-source project that has built a functional screen recording and sharing tool. Its recording pipeline — particularly the macOS screen capture using native Apple APIs and the actor-based state management — is well-engineered and provides useful reference for our implementation. The two-mode architecture (Studio with built-in editor, Instant with progressive upload) serves Cap's product goals but doesn't align with ours.

The most critical takeaway is that Cap's upload approach (progressive MP4 via S3 multipart) is fundamentally inferior to Loom's HLS segment approach for achieving instant playback. This validates our plan to implement HLS streaming upload as described in our requirements.

Cap's server-side story is thin — it's essentially a Next.js app proxying S3 access with a MySQL database for metadata. There's no meaningful video processing pipeline. For our purposes, we need server-side HLS rendition generation and a CDN architecture that doesn't depend on the server being up.

The codebase quality varies: the Rust recording pipeline is solid engineering, the upload mechanism is adequate but architecturally limited, and the server/web layer suffers from over-engineering (Effect-TS) and accumulated technical debt. For a personal tool, we can be dramatically simpler on the server while being more capable on the recording and delivery sides.
