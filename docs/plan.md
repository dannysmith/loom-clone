# Build Plan

The implementation plan for the personal video tool described in `requirements.md`. Architecture decisions are based on the research phase (10 documents in `docs/research/`, synthesised in `docs/research/architecture-synthesis.md`).

---

## Architecture

Three layers: a native macOS desktop app for recording, a server for processing and management, and a viewer layer that operates independently of the server.

```
Desktop App (Swift, macOS 14+)
    |
    |-- fMP4 HLS segments ---- HTTPS PUT ----> Server ----> R2
    |-- Local copy retained until server confirms            |
    |-- Source file uploaded to R2 after recording            |
    |                                                        v
    |                                              FFmpeg (background)
    |                                              3-rendition HLS + thumbnails
    |                                                        |
    |                                                        v
    |                                              Renditions stored in R2
    |
Server (Hono + Bun + SQLite, Hetzner)
    |
    |-- Metadata to Cloudflare KV on create/update
    |
Viewer Layer (Cloudflare Workers + KV)
    |
    |-- v.danny.is/{slug}        Video page (Vidstack + HLS from R2)
    |-- v.danny.is/embed/{slug}  Player only (for iframes)
    |-- v.danny.is/oembed        oEmbed JSON endpoint
```

### Recording Flow

1. User hits record. App calls `POST /api/videos` — server creates record, allocates slug, returns video ID and upload credentials.
2. AVAssetWriter produces fMP4 HLS segments via its `.mpeg4AppleHLS` delegate during recording.
3. Each segment is uploaded via `PUT /api/videos/:id/segments/:n` — server stores in R2.
4. User hits stop. App flushes the final segment, uploads it, calls `POST /api/videos/:id/complete`.
5. Server finalises the HLS playlist (`#EXT-X-ENDLIST`), pushes metadata to KV. URL is ready.
6. URL shown to user and copied to clipboard.
7. Server queues FFmpeg job to produce multi-bitrate renditions in the background.
8. App uploads the source file to R2 as a backup (in the background).

### Viewing Flow

1. Viewer opens `v.danny.is/{slug}`.
2. Cloudflare Worker reads metadata from KV, renders HTML at the edge.
3. Vidstack player loads HLS from R2 via Cloudflare CDN.
4. Initially single-quality (the recording segments). Once FFmpeg processing completes, adaptive multi-bitrate.
5. Server being down does not affect viewing — Worker, KV, and R2 are independent.

---

## Technology Choices

### Desktop App

| Component | Choice | Why |
|-----------|--------|-----|
| Language | Swift | Native macOS APIs. No bridge overhead (vs Tauri/Rust). Natural fit for AVFoundation, ScreenCaptureKit. |
| Screen capture | ScreenCaptureKit | macOS 12.3+. Supports dynamic reconfiguration mid-stream — the enabler for mode switching. |
| Camera + mic | AVCaptureSession | Independent of screen capture. Runs simultaneously on separate dispatch queues. |
| PiP compositing | Core Image + Metal | Sub-5ms per frame on Apple Silicon. Per-frame render makes move/resize trivial. |
| Encoding + segmentation | AVAssetWriter (`.mpeg4AppleHLS`) | Produces fMP4 HLS segments natively from the hardware H.264 encoder. No FFmpeg client-side. |
| Segment upload | URLSession | Simple HTTPS PUT per segment. One at a time, in order. |
| Mode switching | Selective composition | All capture sources run continuously. Mode switch changes what the composition engine feeds to the encoder. No pipeline teardown. |
| Pause/resume | Timestamp manipulation | Offset CMSampleBuffer timestamps. AVAssetWriter doesn't support multiple sessions. |
| macOS target | 14+ (Sonoma) | SCContentSharingPicker bypasses Screen Recording permission. Runtime checks for 15+ features. |
| Distribution | Developer ID + notarisation + DMG | No sandbox required. Sparkle for auto-updates. |
| UI architecture | AppKit (NSStatusItem, NSMenu) + SwiftUI (views) | Menu bar app. Floating NSPanel for recording controls. |
| Concurrency | Swift actors | RecordingActor, CompositionActor, WriterActor, UploadActor. Prevents data races. |

**Encoding settings**: H.264 High Profile, 6 Mbps average, 2-second keyframes, 30fps, 1920x1080, NV12, AAC-LC 128kbps stereo 48kHz. 4-second segment interval.

See `docs/research/01-macos-recording-apis.md` for API details and `docs/research/06-video-processing-encoding.md` for encoding rationale.

### Server

| Component | Choice | Why |
|-----------|--------|-----|
| Runtime | Bun | Fast, built-in SQLite, low overhead. |
| Framework | Hono | Lightweight TypeScript routing (~14kB). Not a full framework — fits a ~15-endpoint API. |
| ORM | Drizzle | Type-safe SQL for TypeScript. Mature SQLite support. |
| Database | SQLite + FTS5 | Single-user, ~5 tables. Full-text search over titles/descriptions/transcripts. Zero ops overhead vs Postgres. |
| DB backup | Litestream | Continuous replication to R2. Point-in-time recovery. |
| Admin UI | React SPA (Vite + Shadcn) | Type sharing with the Hono API. Simple CRUD: video list, edit, delete, upload. |
| Transcoding | FFmpeg | 3-rendition HLS (1080p/5Mbps, 720p/2.8Mbps, 480p/1.4Mbps). Single decode pass, multiple outputs. Thumbnails + sprite sheets. |
| Job queue | In-process async | Bun's async capabilities. At 75 videos/month (~2.5/day), a dedicated queue system is unnecessary. |
| Auth | API key (desktop app), session cookie (admin) | Single user. |
| Hosting | Hetzner CX22 | ~$4.50/mo. 2 vCPU, 4 GB RAM, 40 GB disk. |
| Reverse proxy + TLS | Caddy | Automatic HTTPS. Simple config. |
| Process management | systemd | Standard Linux. |

See `docs/research/08-server-admin-stack.md` for the full evaluation.

### Viewer Layer

| Component | Choice | Why |
|-----------|--------|-----|
| Page rendering | Cloudflare Workers | Edge-rendered. Sub-50ms TTFB globally. Backend-independent. |
| Data store | Cloudflare KV | Global key-value. Populated by server on video create/update. ~60s propagation. |
| Video player | Vidstack | ~54kB gzipped. Works with any HLS source (no vendor lock-in). Built-in hls.js, quality selector, speed controls. MIT licensed. |
| Meta tags | OG + Twitter Card + oEmbed discovery | 1200x630 thumbnails. `og:video` for iMessage. oEmbed JSON endpoint in the Worker. |
| Embed | `/embed/{slug}` | Player only, no page chrome. Responsive iframe. |
| Slug redirects | KV lookup | Old slug → `{"redirect": "new-slug"}` → Worker returns 301. |

See `docs/research/09-viewer-experience-embedding.md` for meta tag spec and platform-by-platform behavior.

### Storage & Delivery

| Component | Choice | Why |
|-----------|--------|-----|
| Object storage | Cloudflare R2 | $0.015/GB, zero egress. HLS segments, source files, renditions, thumbnails. |
| CDN | Cloudflare (via R2) | Zero bandwidth cost. R2 content served through Cloudflare's CDN automatically. |

See `docs/research/07-storage-cdn-cost-modelling.md` for detailed cost projections.

### Database Schema (Sketch)

```sql
CREATE TABLE videos (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  title TEXT,
  description TEXT,
  visibility TEXT NOT NULL DEFAULT 'unlisted',  -- public, unlisted, private
  status TEXT NOT NULL DEFAULT 'recording',      -- recording, processing, ready, error
  duration_seconds REAL,
  resolution_width INTEGER,
  resolution_height INTEGER,
  source_file_key TEXT,       -- R2 key for source backup
  hls_playlist_key TEXT,      -- R2 key for HLS master playlist
  thumbnail_key TEXT,         -- R2 key for thumbnail
  transcript_key TEXT,        -- R2 key for transcript (future)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE slug_redirects (
  old_slug TEXT PRIMARY KEY,
  new_slug TEXT NOT NULL
);

CREATE TABLE tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL
);

CREATE TABLE video_tags (
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (video_id, tag_id)
);

-- Full-text search
CREATE VIRTUAL TABLE videos_fts USING fts5(
  title, description, content='videos', content_rowid='rowid'
);
```

---

## Infrastructure

| Service | Purpose | Cost |
|---------|---------|------|
| Hetzner CX22 | Server (API, admin, FFmpeg) | ~$4.50/mo |
| Cloudflare R2 | Storage (segments, source, renditions, thumbnails, DB backup) | ~$1.50-3.50/mo (grows with library) |
| Cloudflare Workers (free) | Video pages, oEmbed, embed endpoint | $0 |
| Cloudflare KV (free tier) | Video metadata for Workers | $0 |
| Cloudflare DNS (free) | DNS for v.danny.is | $0 |
| **Total** | | **~$6-8/mo** |

---

## Phases

### Phase 0: Prototype

**Goal**: Validate the capture + composite + segment + upload pipeline. Explore the desktop app UI. This may become the real app or may be thrown away.

**Desktop app (Swift):**
- Menu bar app with basic recording controls (start, stop, pause, resume, mode switch)
- Floating control panel during recording
- ScreenCaptureKit screen capture with display selection
- AVCaptureSession camera and microphone capture with device selection
- Core Image compositing for camera overlay (PiP) on screen recording
- AVAssetWriter producing fMP4 HLS segments via delegate
- Mode switching mid-recording (camera-only, screen-only, screen+camera)
- Pause/resume via timestamp manipulation
- Segment upload to local server via URLSession

**Local server (Hono + Bun, runs on the developer's Mac):**
- `POST /api/videos` — create video record, return ID
- `PUT /api/videos/:id/segments/:n` — receive and store segment to local disk
- `POST /api/videos/:id/complete` — finalise HLS playlist
- Serve a basic page with Vidstack player for playback testing
- No R2, no Workers, no deployment — local only

**Exit criteria**: Can record screen + camera, switch modes mid-recording, pause/resume, stop, and immediately play back the result in a browser. Segments are correct, timestamps are continuous, audio is synced across mode switches.

### Phase 1: MVP

**Goal**: Full working system. Record on the Mac, get a URL at `v.danny.is/{slug}`, someone else watches it with adaptive streaming.

**Desktop app (additions to prototype):**
- Source file upload to R2 after recording (background)
- Local safety net: retain files until server confirms processing complete
- URL display + clipboard copy on recording stop

**Server (deploy to Hetzner):**
- Full Hono API with API key auth (desktop) and session auth (admin)
- SQLite + Drizzle ORM schema (videos, slug_redirects, tags, video_tags, FTS)
- Litestream continuous backup to R2
- R2 integration: store segments during recording, source files after
- FFmpeg background processing: 3-rendition HLS + thumbnails from source file
- Playlist management: assemble during recording, finalise on stop, replace with multi-bitrate master after processing
- Push video metadata to Cloudflare KV on create/update/delete
- Admin UI: video list with search/filter, video detail + metadata editing (title, slug, description, tags, visibility), copy URL, delete video, MP4 import upload
- Caddy reverse proxy with automatic HTTPS

**Viewer layer (Cloudflare Workers + KV):**
- Worker: render video page HTML from KV metadata
- Vidstack player loading HLS from R2
- OG + Twitter Card meta tags (per spec in `docs/research/09-viewer-experience-embedding.md`)
- oEmbed endpoint
- `/embed/{slug}` — player only
- Slug redirect handling (301 from old to current)
- Visibility enforcement: public = served with `index, follow`; unlisted = served with `noindex`; private = 404

**Infrastructure setup:**
- Hetzner CX22 provisioning, Caddy, systemd
- R2 bucket, public access configuration
- Cloudflare Workers deployment
- DNS for `v.danny.is`

### Phase 2: Polish

- On-device transcription via WhisperKit, transcript uploaded alongside video metadata
- AI-generated titles and summaries from transcript
- Transcript display on video page
- Camera overlay shape options (circle, rounded rectangle) and corner placement
- MP4 import via admin UI with tus resumable upload
- Keyboard shortcut configuration for recording controls
- Basic metadata editing in the desktop app (title, slug) without opening a browser
- Post-stop UI in desktop app (copy link, edit title, open video page, trash)

### Phase 3: Long Tail

- Iframely listing for Notion auto-embed
- Thumbnail selection and editing
- Transcript with clickable timestamps synced to video playback
- Sitemap generation for public videos
- Basic view count (stored in KV, incremented by Worker)
- Storage tiering: delete renditions for old unwatched videos, keep source, re-transcode on demand
- Trim start/end of recordings (desktop app or web)
- Audio enhancement (noise reduction, gating — desktop or server-side)

---

## Risks

The research identified one area of genuine technical risk: running the full desktop pipeline simultaneously (screen capture + camera capture + Core Image compositing + AVAssetWriter HLS segmentation + HTTP segment upload + mode switching). Each component works individually and is well-documented. The combination has not been validated in any open-source project. This is what Phase 0 exists to prove.

Everything else — the server, FFmpeg transcoding, R2, Workers, Vidstack — uses established tools in well-understood patterns. The novelty and risk are concentrated in the desktop app's recording pipeline.

See `docs/research/architecture-synthesis.md` for the full risk assessment.
