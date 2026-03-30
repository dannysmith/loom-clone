# Architecture Synthesis

*Synthesised from 10 research tasks. 2026-03-30.*

This document consolidates all research findings into a unified architecture, confirms key decisions, identifies risks, and proposes a build sequence.

---

## The System at a Glance

Three layers, one user, permanent URLs on `v.danny.is`.

```
Desktop App (Swift, macOS 14+)
    |
    |-- fMP4 HLS segments during recording --> Server --> R2
    |-- Full local copy retained until confirmed
    |-- Source file uploaded to R2 after recording (backup/archive)
    |
Server (Hono + Bun + SQLite, Hetzner VPS)
    |
    |-- Receives segments during recording, stores to R2
    |-- Manages HLS playlists
    |-- Runs FFmpeg for multi-bitrate renditions after recording
    |-- Manages metadata (title, slug, tags, visibility)
    |-- Pushes video metadata to Cloudflare KV
    |-- Serves admin UI (React SPA)
    |
Viewer Layer (Cloudflare Workers + KV, independent of server)
    |
    |-- Renders video pages at v.danny.is/{slug}
    |-- Serves embed player at v.danny.is/embed/{slug}
    |-- oEmbed endpoint at v.danny.is/oembed
    |-- Handles slug redirects
    |-- Reads from KV, serves from edge, works when server is down
    |
Video Delivery
    |
    |-- Initial: single-quality HLS from R2 via Cloudflare CDN (instant on stop)
    |-- After processing: multi-bitrate HLS from R2 via Cloudflare CDN (adaptive)
    |-- Player: Vidstack (works with any HLS source)
```

### Self-Hosted Throughout

No managed video services. FFmpeg for transcoding, R2 for storage, Cloudflare CDN for delivery. Estimated ~$6-8/mo. If we later want a managed service (Mux, Bunny Stream), the architecture makes that easy — the server already produces standard HLS that any service could replace.

---

## Confirmed Decisions

### Desktop App

| Decision | Detail | Source |
|----------|--------|--------|
| **Native Swift** | Not Electron, not Tauri. Direct access to macOS capture APIs. Menu bar app. | Tasks 01, 03, 05 |
| **ScreenCaptureKit** for screen capture | macOS 12.3+. Dynamic mid-stream reconfiguration for mode switching. | Task 01 |
| **AVCaptureSession** for camera + mic | Independent pipeline from screen capture. Runs simultaneously. | Task 01 |
| **Core Image + Metal** for PiP compositing | Sub-5ms per frame on Apple Silicon. Per-frame render = trivial to move/resize overlay. | Task 01 |
| **AVAssetWriter** for encoding + segmentation | Produces fMP4 HLS segments natively via `.mpeg4AppleHLS` delegate. No FFmpeg client-side. | Tasks 01, 02 |
| **H.264 High Profile** | 6 Mbps avg, 2-second keyframes, 30fps, 1080p, AAC-LC 128kbps. | Task 06 |
| **4-second segments** | ~3 MB per segment at 1080p. | Task 02 |
| **Always-on capture, selective composition** | All sources run continuously. Mode switching changes composition logic, not capture pipeline. | Task 01 |
| **Pause via timestamp manipulation** | Offset CMSampleBuffer timestamps. AVAssetWriter doesn't support multiple sessions. | Task 01 |
| **macOS 14+ target** | SCContentSharingPicker (bypasses Screen Recording permission). Runtime checks for macOS 15 features. | Task 01 |
| **Developer ID + notarisation + DMG** | No sandbox. Sparkle for auto-updates. | Task 01 |

### Ingest: Direct HLS Segment Upload

The desktop app uses AVAssetWriter's delegate to produce fMP4 segments during recording, uploads each via HTTPS PUT to the server, and the server stores them in R2. The video URL is allocated at recording start (so the server knows where segments go) but only shown/copied to the user when recording stops. No RTMP, no managed ingest service, no video availability during recording.

```
Recording:  AVAssetWriter --> fMP4 segments --> HTTPS PUT --> Server --> R2
On stop:    Final segment flushed + uploaded, playlist finalised, URL ready
Background: Server uploads source to FFmpeg queue for ABR renditions
```

The HLS playlist is assembled server-side as segments arrive. During recording, the playlist is an internal artifact (not publicly served). On stop, the playlist is finalised with `#EXT-X-ENDLIST` and the video becomes publicly playable.

### Server

| Decision | Detail | Source |
|----------|--------|--------|
| **Hono + Bun + Drizzle ORM** | TypeScript end-to-end. Type sharing with admin UI and Vidstack. | Task 08 |
| **SQLite** | Single-user, ~5 tables. FTS5 for search. Litestream backup to R2. | Task 08 |
| **React admin SPA** | Video list, metadata editing, URL copy, delete, upload. Shadcn/Radix. | Task 08 |
| **Hetzner CX22** | ~$4.50/mo. 2 vCPU, 4 GB RAM. Caddy for HTTPS. systemd. | Tasks 07, 08 |
| **FFmpeg for transcoding** | 3-rendition ladder (1080p/720p/480p). Thumbnail + sprite sheet generation. Background job queue via goroutine-style async processing. | Task 06 |
| **~15 API endpoints** | Desktop app: create video, upload segments, complete recording, update metadata. Admin: CRUD, search, import. | Task 08 |
| **API key auth** for desktop, **session auth** for admin | Single user. Simple. | Task 08 |

### Viewer Layer

| Decision | Detail | Source |
|----------|--------|--------|
| **Cloudflare Workers + KV** | Edge-rendered video pages. Backend-independent. Sub-50ms TTFB globally. | Task 09 |
| **Vidstack player** | Works with any HLS source. ~54kB gzipped. MIT. No vendor lock-in. | Tasks 09, 10 |
| **Full OG + Twitter Card meta tags** | 1200x630 thumbnails. oEmbed discovery tag. | Task 09 |
| **oEmbed endpoint** in Worker | Standard JSON response. | Task 09 |
| **Slug redirects via KV** | Old slug maps to new slug. Worker handles 301s. | Task 09 |

### Storage & Delivery

| Decision | Detail | Source |
|----------|--------|--------|
| **Cloudflare R2** | Zero egress. Segments, source files, renditions, thumbnails. | Tasks 04, 07 |
| **Cloudflare CDN** (via R2) | HLS segments served from edge. Zero bandwidth cost. | Task 07 |
| **Litestream** | Continuous SQLite backup to R2. | Task 08 |

### Encoding

| Decision | Detail | Source |
|----------|--------|--------|
| **H.264 only** (for now) | Universal compatibility. HEVC as future secondary. AV1 not practical yet. | Task 06 |
| **fMP4 segments** (not .ts) | Native AVAssetWriter support. Modern HLS (version 7+). | Tasks 02, 06 |
| **3-rendition ladder** | 1080p/5Mbps, 720p/2.8Mbps, 480p/1.4Mbps. Single-pass FFmpeg. | Task 06 |
| **Vidstack + hls.js** for playback | Adaptive bitrate, quality selector, speed controls, keyboard shortcuts. | Tasks 09, 10 |

---

## Cost Estimate

Self-hosted, steady state at ~12 months:

| Component | Provider | Monthly |
|-----------|----------|---------|
| Server (web + FFmpeg processing) | Hetzner CX22 | $4.50 |
| Storage (~240 GB source + renditions + import) | Cloudflare R2 | ~$3.50 |
| CDN delivery (~85 GB/mo) | Cloudflare (via R2) | $0.00 |
| Video pages | Cloudflare Workers (free tier) | $0.00 |
| Domain/SSL/DNS | Cloudflare | $0.00 |
| **Total** | | **~$8/mo** |

Growth: R2 storage is the main driver. ~$9.50/mo at 36 months. Hetzner is fixed.

---

## Risks & Unknowns

### Must Prototype Before Full Build

**Combined pipeline under load.** Running ScreenCaptureKit + AVCaptureSession + Core Image compositing + AVAssetWriter HLS segmentation + HTTPS segment upload simultaneously. Each works individually. The combination at 30fps with mode switching has not been validated in any open-source project.

**Recommended prototype scope:**
1. Capture screen via ScreenCaptureKit
2. Capture camera via AVCaptureSession
3. Composite camera overlay onto screen via Core Image
4. Write fMP4 HLS segments via AVAssetWriter delegate
5. Upload segments via URLSession to a local test server
6. Switch between camera-only and screen+camera mid-recording
7. Verify: no dropped frames, correct timestamps, audio continuity, segments independently playable

### Known Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| **Mode switching + HLS segments** | Medium-High | May need `#EXT-X-DISCONTINUITY` tags at switch points. Resolution changes may require fixed output resolution (recommended). |
| **CDN cache during recording** | Medium | Playlist is internal during recording, only published on stop. Segments are immutable once uploaded. |
| **FFmpeg processing time** | Low | 3-min video → ~30-60s per rendition on 2-vCPU. 75 videos/month is light. |
| **Apple Silicon encoder capacity** | Low | Dedicated media engine. Needs testing during Zoom call etc. |

### Open Questions (Resolved by Prototyping)

1. Can AVAssetWriter's HLS delegate handle a composition pipeline that changes what it renders mid-stream (mode switching)?
2. Does fixed 1920x1080 output for camera-only mode look acceptable?
3. What's the actual CPU/memory/battery impact of the full pipeline on a MacBook Air vs MacBook Pro?
4. Do `#EXT-X-DISCONTINUITY` tags at mode-switch points cause player glitches in Vidstack/hls.js?

---

## Phased Build Plan

### Phase 0: Prototype

Minimal Swift app + local server. Prove the capture → composite → segment → upload pipeline works. Nail down the desktop app UI and interaction design. This may become the real app, or we may start fresh.

**Desktop app (Swift):**
- Menu bar presence with basic recording controls
- Screen + camera + mic capture
- Core Image compositing for PiP
- AVAssetWriter producing fMP4 HLS segments
- Segment upload to local server via URLSession
- Mode switching mid-recording
- Pause/resume

**Local server (Hono + Bun, runs on the Mac):**
- Receive segments, write to local disk
- Manage HLS playlist
- Serve video page with Vidstack player for testing playback
- No R2, no Workers, no deployment — just local

**Exit criteria:** Can record screen + camera, switch modes, pause/resume, stop, and immediately play back the result in a browser via hls.js. Segments are correct, timestamps are continuous, audio is synced.

### Phase 1: MVP

Take the prototype (or rebuild from it) and add the full server, storage, viewer layer, and admin.

**Desktop app additions:**
- Polish recording UI
- Source file upload to R2 after recording
- Local safety net (don't delete local files until server confirms)

**Server (deploy to Hetzner):**
- Full Hono API with auth
- SQLite + Drizzle + Litestream
- R2 integration for segment and source file storage
- FFmpeg background processing (3-rendition HLS + thumbnails)
- Admin UI: video list, metadata editing, URL management, delete, MP4 import

**Viewer layer (Cloudflare Workers + KV):**
- Video pages with Vidstack, OG tags, oEmbed
- Embed endpoint
- Slug redirects

**Outcome:** Working end-to-end system. Record → stop → URL works at `v.danny.is/{slug}` with adaptive streaming.

### Phase 2: Polish

- On-device transcription (WhisperKit) with transcript on video page
- AI-generated titles and summaries from transcript
- Camera overlay shape options (circle, rounded rect) and corner placement
- Upload imported MP4s via admin UI (tus for resumable upload)
- Keyboard shortcut configuration
- Basic metadata editing in desktop app (title, slug) without opening browser

### Phase 3: Platform Integration & Long Tail

- Iframely listing for Notion auto-embed
- Thumbnail selection/editing
- Video page transcript with clickable timestamps
- Sitemap for public videos
- Basic view count (optional, stored in KV)
- Storage tiering for old videos (delete renditions, keep source)

---

## Data Flow

### Recording

1. User clicks record in menu bar app
2. App calls `POST /api/videos` → server creates record, allocates slug, returns video ID and upload credentials
3. AVAssetWriter starts producing fMP4 segments via delegate
4. Each segment → `PUT /api/videos/:id/segments/:n` → server stores in R2
5. User hits stop → app calls `flushSegment()`, uploads final segment
6. App calls `POST /api/videos/:id/complete` → server finalises playlist, pushes metadata to KV
7. URL (`v.danny.is/{slug}`) shown to user, copied to clipboard
8. Server queues FFmpeg job for ABR renditions (background)
9. App uploads source file to R2 as backup

### Viewing

1. Viewer clicks `v.danny.is/{slug}`
2. Cloudflare Worker looks up slug in KV → gets video metadata
3. Worker renders HTML with OG tags, oEmbed discovery, Vidstack player
4. Player loads HLS from R2 via Cloudflare CDN
5. If server is down: Worker + KV + R2 all function independently. Video plays.

### Management

1. Admin opens admin UI
2. React SPA loads, authenticates via session
3. Admin edits title, slug, description, tags, visibility
4. Server updates SQLite + pushes updated metadata to KV
5. If slug changed: old slug stored as redirect in KV

---

## Key Dependencies

| Dependency | Role | Lock-in Risk | Alternative |
|------------|------|-------------|-------------|
| **Cloudflare R2** | Storage | Low | Any S3-compatible provider |
| **Cloudflare Workers + KV** | Video page rendering | Medium | Server-rendered pages with CDN caching |
| **Hetzner** | VPS | Low | Any Linux server |
| **Vidstack** | Video player | Low | Any HLS player (MIT licensed) |
| **FFmpeg** | Transcoding | None | Industry standard |
