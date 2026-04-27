# Features

> Note: This is a working doc on the features of this project, which will probs eventually be used as the basis of a blog article and/or a project website (and/or a decent README.md etc)

> **Outline conventions:** bullets are the raw material to write from. `> Note:` blocks are reminders/suggestions to me about what to flesh out, what's missing, or where to be careful. Headings prefixed `🆕` are ones the AI added that weren't in my original outline — keep, drop, or move as needed.

## Why I built this

- Loom works but: I don't own my URLs, can't switch camera/screen mid-recording, UI is bloated with stuff I never use, Atlassian keeps adding AI features I don't want, costs more than it should
- Cap is open-source and lets me use my own domain, but feels half-baked — random breakage, codebase feels uncared-for, not something I'd bet a permanent video library on
- I wanted a tool I control completely, on a domain I own, that does exactly what I need — nothing more, nothing less
- AI-assisted coding made it feasible to build a "lake-boiled" personal version of a thing that would normally be a multi-engineer product
- Use cases this is shaped around: quick Slack replacements, async announcements, document intros, evergreen learning content embedded in Notion/Docs/GitHub, longer assembled tutorials/demos

> Note: Probably worth a paragraph here on the "personal tool, not a product" framing — single user, no team features, no viewer accounts, no social. Just URLs that play videos.

## Overview: The fundamental Requirements

1. **macOS menubar app** — the recorder. Native Swift/SwiftUI. ScreenCaptureKit + AVFoundation + Metal/CoreImage + AVAssetWriter
2. **Backend API** — Hono + Bun. Receives HLS segments live, runs post-processing, exposes JSON for the macOS app
3. **Admin Web App (and its API)** — Hono + JSX + HTMX + vanilla CSS. Same Hono server, separate auth & route module
4. **Viewer-facing surface** — public `/:slug` pages, embed, oEmbed, JSON/MD endpoints, RSS/JSON feeds, llms.txt. Lives on the same Hono server today; designed to migrate to Cloudflare Workers + KV later

> Note: Worth one line per component on the "why these four" — separation matches three different audiences (me recording, me managing, them watching) plus the API that glues them.

### Visibility/Permissions

Three states, as a property of the video:

- **Unlisted** (default) — accessible by URL; `noindex` meta + `X-Robots-Tag` header so search engines stay out; not in sitemap; not in RSS / JSON feed / llms.txt; oEmbed still works (so Notion/Slack previews work)
- **Public** — same as unlisted plus: appears in `/sitemap.xml`, `/feed.xml`, `/feed.json`, `/llms.txt`. Indexable
- **Private** — viewer routes return 404 to the public; only viewable inside the admin panel via session-gated media routes

> Note: Worth mentioning that visibility is mutable from the admin without changing the URL — the same slug can flip between states.

## The Menubar App UI

> Note: Lead with the "menubar + popover, no Dock icon" framing. Then walk through what's in the popover top-to-bottom.

### Source Selection

- Three pickers — Display, Camera, Microphone — each with a "None" option at the top
- Selection IS intent: available recording modes are derived from what's plugged in (screen-only, camera-only, screen+camera). No mode picker shown when only one mode is possible
- Mic = None records video with no audio; doesn't gate mode availability
- Defaults: first available display & camera; mic defaults to the system default input
- Quality presets (1080p, 1440p) are gated on whether the selected display OR camera can natively feed them
- Hot-plug: device list re-polls every 2s

### Previews (Video/Audio etc)

- Live preview area in the popover that handles every combination: empty placeholder, single-source full-frame, screen+camera with PiP overlay matching the recording layout
- Camera preview uses a separate lightweight `AVCaptureSession` (stops during recording to avoid CMIO conflict with the recording session)
- Live microphone input-level meter
- Visual indicator of where the PiP circle will sit on-screen

### Camera Adjustments

- White Balance (temperature, Kelvin) and Brightness (EV stops) sliders
- Reset button restores defaults
- Adjustments apply to: popover preview, on-screen PiP overlay, composited HLS stream
- Adjustments do NOT apply to the raw `camera.mp4` master file (sensor-original is preserved for re-processing)
- Reset on app relaunch — no persistence

### Starting Mode & Stream Quality

- Mode picker (when more than one mode is available) — start in screen-only, camera-only, or screen+camera
- Quality picker — 1080p or 1440p (4K was attempted and removed; see "Performant Capture" for the war story)
- Both lock at recording start

### 🆕 Settings (Cmd+,)

> Note: Worth flagging this as a section — the popover is for recording, the Settings window is for configuration. Belongs here in the menubar app section.

- Server URL (so you can point it at localhost, staging, or production)
- API Key (stored in macOS Keychain, never UserDefaults)
- Transcription model — download / delete the WhisperKit model (~626 MB, explicit user action — too big to download silently)
- Debug builds and Release builds use entirely separate Keychain entries, UserDefaults, and local recordings dirs (so dev work never pollutes production state)

### 🆕 Permissions, Shortcuts, Floating Surfaces

- Screen Recording permission detection with deep link to System Settings + retry flow (no relaunch required)
- Global keyboard shortcuts — Cmd+Shift+R / P / M for record / pause / mode-switch
- Recording panel and PiP overlay use `.statusBar` window level + `canJoinAllSpaces` + `fullScreenAuxiliary` so they appear above fullscreen apps and across all Spaces
- Own app windows are excluded from screen capture (you don't see the recording panel in your own video)

## The Recording UI

> Note: Floating panel that appears on Record. Lives above everything. Keep this section about the in-recording controls, not the menubar.

### Mode Switching

- Switch screen ↔ camera ↔ screen+camera mid-recording, instantly (~33ms — next metronome tick)
- Hard cut in the output; no transition effect; same continuous HLS stream; no segment boundary forced
- Mode strip in the panel only shows modes valid for the locked-in source selection

### The Preview Overlay

- Draggable circular PiP camera overlay (240px @ 1080p, scales with preset)
- Frame-based rendering (CIContext → CGImage → CALayer) — bypasses the dual-`AVCaptureSession` conflict that breaks AVCaptureVideoPreviewLayer in this scenario
- Fixed PiP positions selectable mid-recording (corners) via overlay UI
- Camera adjustments (WB / brightness) reflected live in the overlay

### Pausing & Cancelling

- Pause is first-class — output stream has no gap at the pause point, just continuous segments
- Audio AND video are retimed by the same accumulated pause duration on resume
- Cancel deletes the in-progress recording entirely (server record + local files)
- Stop produces a shareable URL; cancel discards

> Note: Worth being explicit that "Stop" never blocks on uploads — see the resilience section for the 10s grace window and heal handoff.

## The Backend API

- Hono + Bun, running in Docker on the Hetzner VPS at `v.danny.is`
- Four route modules with distinct auth profiles — `api` (bearer), `admin` (session/bearer), `site` (open), `videos` (open)
- `/api/videos/*` is the macOS app's contract: bearer token (`lck_` prefix, SHA-256 hashed in DB)
- `/api/health` is open — used by the macOS app to gate the Record button before it has a token
- JSON envelope: success returns the resource (or `{ ok: true }`); errors return `{ error, code }` with stable `MACHINE_CODE` strings
- All segment uploads and `/complete` are idempotent (rebuild from disk, not from request order)
- `recording.json` round-trips: client sends timeline on `/complete`, server uses it for missing-segment diff and stores it
- SQLite (via Drizzle) — single-file DB co-located with video data
- See `docs/developer/server-routes-and-api.md` for the full reference

> Note: Don't reproduce the route reference here — link to the dev doc. Just the principles.

## The Basic Recording Lifecycle

[Mainly from the macOS app's POV...]

### Sources & Previews & Warming Up

- Preview sessions run in the popover before record (camera, mic, screen-snapshot). Torn down when not visible to save resources
- Two-phase start so the UI can show a countdown in parallel with hardware bring-up:
  - **prepare** (slow, ~1–2s): create server video record, start capture sessions, wait for first audio sample to arrive (proves the mic is delivering and prevents a known AVAssetWriter race that silently drops the audio track)
  - **commit** (fast, <1 frame): anchor `recordingStartTime` to a real captured frame's PTS, start the writer session, kick the metronome
- Countdown overlap means the perceived start latency is just the countdown — hardware is already warm by the time it ends

### Hitting Record

- Countdown plays in the floating panel
- Recording starts at T=0, anchored to the most recent cached source frame's hardware capture PTS (not wall clock — see "Performant Capture & Audio Sync")
- Metronome ticks at 30fps and emits composited frames into the HLS writer
- Raw safety-net writers (`screen.mov`, `camera.mp4`, `audio.m4a`) start in parallel at native resolution

### What get's streamed up and why

- Only the composited HLS output (`init.mp4` + `seg_NNN.m4s`, ~4s each) is streamed to the server during recording
- That stream is what viewers actually watch — H.264 High @ 6 Mbps for 1080p, AAC-LC 128 kbps stereo
- Raw masters stay local-only — they're a safety net for re-composition or manual recovery, far too big to upload by default
- Each segment is written to local disk FIRST, then uploaded — disk is the audit trail, server converges towards it

### Hitting Stop

- Writer finishes; stop flow waits up to 10s for the upload queue to drain
- `recording.json` (the timeline) is snapshotted to local disk
- `POST /:id/complete` with the timeline; server diffs expected vs on-disk, returns `{ url, missing }`
- URL hits the clipboard within ~1s of pressing Stop — never blocked on uploads completing
- If `missing` is non-empty, hand off to `HealAgent` (background, fire-and-forget)
- Background: `TranscribeAgent` kicks off transcription against the local `audio.m4a`

### Editing the last video's details in the mac app

- Inline display/edit view appears in the popover after Stop
- Edit title, slug, visibility right there — no need to open the admin panel
- Display mode shows the metadata as read-only with an Edit button; edit mode swaps to fields with Save/Cancel
- Slug edits validate and create redirects via the same `PATCH /api/videos/:id` path the admin uses
- `/complete` response now carries title and visibility so the editor can pre-populate

## The Basic Viewer-Facing Players

### `/:slug`

- Vidstack player. MP4 derivative when present, falls back to HLS playlist while derivatives are still being generated (or while a recording is healing)
- Decision is per-request, no client-side state — a fresh recording serves HLS for ~1s, then upgrades to MP4 on the next page load
- Poster image (auto-selected thumbnail) when available
- `<track>` element for captions when transcript exists (Vidstack parses SRT natively)
- Storyboard scrubber-hover thumbnails when present
- Below the player: title (if set), formatted duration + date, description, attribution
- "Open in Admin" button visible to admin sessions only

### `/:slug/embed`

- Chromeless player for iframe embedding
- Same MP4-vs-HLS preference logic as the main page
- Custom pre-play overlay with title, duration (clock icon), centered play button over a dark scrim — fades out when Vidstack starts the player
- Border-radius forced to 0 on all Vidstack internals so it sits flush in any iframe
- Used by oEmbed `html`, OG/Twitter `player` tags, and direct iframe embeds

## What get's stored locally

> Note: Local = `~/Library/Application Support/LoomClone/recordings/<video-id>/` (or `LoomClone-Debug/...` for dev builds — see Build Configurations).

| File | Purpose |
| --- | --- |
| `init.mp4` + `seg_NNN.m4s` | Composited HLS — what gets uploaded; also the local audit trail |
| `stream.m3u8` | Local-side playlist (less important — server rebuilds its own) |
| `recording.json` | The timeline: events, per-segment upload flags, hardware info, composition stats |
| `screen.mov` | Raw screen master — ProRes 422 Proxy at native display resolution |
| `camera.mp4` | Raw camera master — H.264 native resolution (+ AAC audio when camera & mic share a session) |
| `audio.m4a` | Raw mic master — AAC 192 kbps from the standalone mic session (always written when mic selected) |
| `captions.srt` | Local backup of generated transcript |
| `.transcribed` | Sentinel — TranscribeAgent has uploaded the transcript, won't retry |
| `.orphaned` | Sentinel — server returned 404 (record was deleted upstream); HealAgent and TranscribeAgent both skip forever |

- Raw masters exist as a "never lose footage" safety net. They're not uploaded today; manual re-composition is the recovery path
- Build-config isolation: Debug runs (Xcode) and Release installs use entirely separate dirs, Keychain entries, and UserDefaults — they never see each other's recordings or settings

## Server-Side Post-Processing

> Note: All of this runs in the background after `/complete` lands `status: complete` (or after a heal completes). Fire-and-forget — never blocks the response. Per-video promise cache collapses concurrent triggers. All writes are atomic (`.tmp` → rename).

### Audio Processing

- Three-stage chain: `highpass=80 → arnndn (cb.rnnn model) → loudnorm` (two-pass, -14 LUFS / -1.5 dBTP / LRA 11)
- Highpass kills sub-speech rumble (HVAC, fans, traffic) so the denoiser doesn't waste cycles
- arnndn is RNN-based denoiser — model file bundled (~293 KB), trained for close-mic speech with general background noise
- Two-pass loudnorm because single-pass is meaningfully less accurate for speech; pass 1 measures, pass 2 applies measured values with `linear=true` to preserve dynamics
- Video track copied untouched (`-c copy`); only audio is re-encoded (AAC 160 kbps)
- Skipped silently if no audio track (video-only uploads)
- ~88x realtime on M2-class hardware

### Basic Derivitives

- `source.mp4` — HLS segments stitched via `ffmpeg -c copy` with `+faststart`. Audio re-encoded as part of the audio chain above. The "download me" canonical file
- `720p.mp4` — generated when source > 720p. libx264 CRF 23
- `1080p.mp4` — generated when source > 1080p. libx264 CRF 20
- Both variants `-c copy` audio from the already-loudnormed source

> Note: The variants are generated and stored but the player doesn't currently switch between them — that's the future "view layer" work. Worth being honest about that.

### Thumbnaiils

- Multiple candidate frames extracted at front-loaded timestamps (fixed anchors at 2s/5s/15s + percentage anchors at 10/20/40/60%)
- Pruned (drop near-end and near-start frames, dedupe by 2s gap)
- Each candidate scored by luminance variance
- Best non-blank candidate auto-promoted to `thumbnail.jpg`
- Admin can override: pick a different candidate from the grid, or upload a custom JPEG (resized to 1280px)
- Promotion is atomic file copy; admin override survives re-runs of the pipeline

### Storyboard & Scrubber Generation

- Sprite sheet (`storyboard.jpg`) — frames sampled at dynamic intervals (every 5–36s depending on duration), tiled up to 10×10
- WebVTT (`storyboard.vtt`) — one cue per tile using the `image.jpg#xywh=...` spatial-fragment form
- Vidstack consumes the VTT for hover-scrub previews
- Skipped entirely for videos < 60s (not useful)

### 🆕 Metadata Extraction

> Note: Probably worth its own bullet rather than burying it. After all derivatives, ffprobe + recording.json populate the video row.

- `width`, `height`, `aspect_ratio`, `file_bytes` from ffprobe on `source.mp4`
- `camera_name`, `microphone_name` from `recording.json` inputs block
- `recording_health` — `null` (clean) | `gpu_wobble` | `terminal_failure` — derived from `compositionStats` in the timeline
- One-shot CLI to backfill rows that pre-date this column

## Mid-Recording Resilliance & Recovery

> Note: This section is THE big distinguishing feature. The two principles to lead with: **never lose footage** and **instant shareability**. Below is everything that contributes to those two principles. They were added incrementally over many tasks — list them declaratively, not in build order.

### Two principles

- **Never lose footage** — every segment hits local disk before the upload is attempted; raw masters provide a parallel safety net at native resolution
- **Instant shareability** — the URL is on the clipboard within ~1s of pressing Stop, regardless of upload state. Healing happens silently in the background

### Capture-side robustness

- **Two-phase start with first-audio-sample wait** — guards against a known AVAssetWriter race where a too-early `startWriting()` produces an init segment with no audio track, silently dropping audio for the entire recording
- **Hardware capture PTS anchoring** — clock is anchored to a real captured frame's PTS, never to wall-clock-now. Eliminates ~50ms of asymmetric capture latency
- **Bounded camera frame queue (FIFO, capacity 4)** — replaces the old single-slot cache that was silently dropping ~25% of frames in cameraOnly mode whenever the metronome fell behind by even one frame
- **Drift-corrected metronome** — emits at 30fps even when sources stall briefly
- **NTSC-tolerant camera format selection** — handles UVC cameras that report 29.97 vs strict 30fps, and the locked-format edge cases that throw uncatchable Objective-C exceptions
- **Pause is first-class** — `pauseAccumulator` retimes both audio and video so the output stream has no gap at the pause point

### Multi-encoder failure isolation (the M2 Pro war story)

> Note: Worth a paragraph here on the M2 Pro hard-reboot incident — running three concurrent H.264 encoders on a chip with one media engine wedged the kernel hard enough to require a power-button reboot. Reference `docs/archive/m2-pro-video-pipeline-failures.md`. The fixes below are the resilience layer that came out of that.

- **ProRes 422 Proxy for the raw screen master** — moves the heaviest stream off the H.264 engine onto the dedicated ProRes silicon block, eliminating encoder contention
- **VideoToolbox tunings** — `RealTime=false`, `AllowFrameReordering=false`, hardware encoder enforced, writer warm-up *before* SCStream opens. These collectively turned a reproducible kernel deadlock into a clean recording
- **GPU failure handling in the compositor** — every `CIRenderTask` has a 2s timeout; render errors or stalls trigger a `CIContext` + `MTLCommandQueue` rebuild, recording continues on the fresh context
- **Terminal-failure escalation** — if the rebuild itself fails, recording stops cleanly with a user-visible alert, local files preserved
- **Independent raw writers** — if `camera.mp4` fails mid-recording (rare, under heavy load), `screen.mov` + `audio.m4a` + the composited HLS all still survive
- **Raw writer failure flagging** — `rawStreams.<file>.failed` in `recording.json` so consumers know a file is truncated rather than just inferring from size
- **Stop-time composition stall avoidance** — the metronome doesn't submit render tasks it knows will be discarded once Stop is pressed (eliminates spurious `gpu_wobble` flags)

### Upload-side robustness

- **Reachability gating via `NWPathMonitor`** — uploads pause entirely when the network path is `.unsatisfied` rather than burning retry budget on attempts that can't succeed
- **Exponential backoff with no hard cap** — 1s → 2s → 4s → 8s → 16s → 30s, then 30s indefinitely while recording is active
- **Lazy segment loading** — queued segments reference local files, bytes loaded on each attempt. Memory stays flat during long outages
- **Idempotent server PUTs** — same filename twice produces the same final state. Re-uploads, out-of-order arrivals, late heal uploads all converge correctly
- **Filesystem-driven playlist** — server rebuilds `stream.m3u8` from sorted directory listing, not from request arrival order
- **Server-side persistence (SQLite)** — video records survive server restarts, so a mid-recording deploy doesn't 404 subsequent PUTs
- **10-second stop-flow grace window** — Stop never hangs. If the network is bad, drain what we can in 10s, hand the rest to the heal path, return the URL anyway

> Note: Maybe a short subsection here on the "live offline indicator" if I add one — UI hint that uploads are paused. Currently informational only.

## Healing

> Note: Healing is the recovery mechanism for HLS segments that didn't make it during the live recording. Two entry points, one core flow. Cross-link to streaming-and-healing.md.

### Two entry points

- **Post-stop handoff** — if `/complete` returns a non-empty `missing`, `HealAgent` picks it up immediately
- **Startup scan at app launch** — walks `~/Library/Application Support/LoomClone/recordings/` for any session within the last 3 days where `recording.json` shows segments with `uploaded: false`. Catches recordings where the app quit before healing finished, or where the network never came back

### The heal loop

- Preflight `/complete` with the timeline to get the authoritative missing list (handles partial prior heals)
- For each missing filename: read from local disk, PUT to server, patch `recording.json` to flag uploaded
- Final `/complete` triggers playlist rebuild and `healing → complete` status transition (which in turn re-runs the derivative pipeline)
- 404 from the server → write `.orphaned` sentinel and stop forever (record was deleted upstream)
- Heal is idempotent — every HTTP call is safe to replay

### Server-side coupling

- Status state machine: `recording → healing → complete` (or `failed`)
- Viewer playlist is always rebuilt from disk listing, so playback works through the heal — gets more complete over time
- Derivative pipeline re-runs after a heal completes; new `source.mp4` overwrites the old atomically
- Recordings older than 3 days are deliberately ignored — if it didn't heal by then, it almost certainly never will

## Transcription & Subtitles

- **Where it runs:** locally on the Mac via WhisperKit (Apple Silicon, Core ML, Neural Engine). Apple Silicon transcribes ~15–25× realtime; the Hetzner VPS would manage maybe 0.5–1× — the Mac is the right place
- **Model:** `large-v3-turbo` (~626 MB on disk, ~1.5 GB RAM at inference). Downloaded explicitly via Settings — too big to grab silently. Status managed by an observable singleton; transcription is gated on it being `.ready`
- **When it runs:** post-stop (after URL hits clipboard) + startup scan (same 3-day window as healing). User-invisible, no UI surface beyond a "still transcribing" badge
- **What it produces:** SRT, parsed server-side into plain text, indexed into FTS5 alongside title/description/slug — admin search hits transcripts for free
- **What it serves:**
  - `<track>` element on `/:slug` (Vidstack parses SRT natively, no VTT conversion)
  - `/:slug/captions.srt` (and `.vtt` if uploaded as VTT)
  - Plain-text in `/:slug.json`, `/:slug.md`, and `/feed.json` (truncated to ~200 words in the feed)
  - Transcript tab in the admin video detail page
- **Sentinel-based state:** `.transcribed` written on success; same `.orphaned` skip-forever logic as healing if the server 404s
- **Server endpoint:** `PUT /api/videos/:id/transcript` is transport-agnostic — same endpoint accepts any future server-side or third-party producer

## The Admin Interface

> Note: Stack is Hono JSX + HTMX + vanilla CSS with `@layer`. No client framework, no build step. ~20-line `admin.js` for clipboard / `<dialog>` / upload progress. Worth one line on the rationale — single-user tool, deliberately boring.

### The Dashboard

- Video list with grid (default) and table views — same data, toggled via `data-view` attribute + CSS
- Server-side full-text search via SQLite FTS5 over title, description, slug, and transcript (debounced via `hx-trigger="input changed delay:500ms"`)
- Filters: visibility, status, tags, date range, duration range
- Sort: date / duration / title (newest-first default)
- Cursor-based pagination — "Load More" button, never numbered pages
- URL state preserved via `hx-replace-url` so search/filter is bookmarkable
- Per-card context menu (CSS anchor positioning + native `popover` attribute) with quick actions

### The Video Page

- In-place edit for title, slug, description (HTMX click-to-edit partials)
- Visibility change with a confirmation dialog
- Tag add/remove
- Player works even for private videos via session-gated `/admin/videos/:id/media/*` routes
- Three tabs below the player: Events, Files, Transcript
- File browser tab — flat listing of `data/<id>/`, sizes, subfolder expansion, text-file inline preview

### Slugs & Redirects

- Slug regex: `^[a-z0-9](-?[a-z0-9])*$` — lowercase alphanumeric with single dashes, no dots, no slashes, no leading/trailing/double dashes, max 64 chars
- Reserved word list (admin, api, static, raw, stream, embed, feed, rss, …) — protects every route the server might want to add later
- Globally unique forever — a slug can't match any current video OR any entry in `slug_redirects` (so old URLs never silently resolve to the wrong video)
- Slug change → old slug inserted into `slug_redirects`, video updates, original URL 301s to the canonical
- No UI for managing redirects directly; they accumulate automatically

### The Activity Log

- Append-only `video_events` table — `created`, `completed`, `healed`, `slug_changed`, `title_changed`, `description_changed`, `visibility_changed`, `tag_added`, `tag_removed`, `trashed`, `untrashed`, `duplicated`, `transcript_uploaded`, `derivative_generated`, `derivative_failed`
- Per-video view in the Events tab on the video detail page
- Deliberately NOT logged: per-segment uploads (150 segments per recording is noise, not an audit trail)

### Video Actions

- Available from both the video detail page AND the dashboard card context menu:
  - Open public URL (new tab) — public/unlisted only
  - Copy public URL — public/unlisted only
  - Download (`source.mp4`)
  - Change visibility (with confirmation)
  - Duplicate — full file + DB copy, new UUID + slug + title `(N)`, preserves tags, gets its own event log
  - Trash — soft delete, redirect to dashboard

### Settings & Trash Bin

- **General** pane — placeholder for whatever ends up needing global config
- **Tags** pane — CRUD for tags, each with a name + colour from a constrained 10-colour palette (gray/red/orange/yellow/green/teal/blue/indigo/purple/pink). Same palette mapped to OKLCH custom properties in CSS
- **API Keys** pane — manages both `lck_` (recording API for the macOS app) and `lca_` (admin API for scripting). Web UI replaces the CLI for both. Plaintext shown once at creation, then hash-only
- **Trash Bin** — dedicated page; trashed videos are hidden everywhere else (dashboard, search, filters); slugs and redirects are held; one-click untrash; permanent deletion deliberately not implemented (yet)

### 🆕 Upload (for non-recorded videos)

> Note: This isn't in the original outline but probably belongs under Admin. Worth a section.

- Upload an existing MP4 from the admin (Loom exports, YouTube downloads, historical content)
- Optional metadata at upload time: title, slug, description, visibility, tags
- `source: "uploaded"` distinguishes them from recorded videos
- Goes through the same derivative pipeline as recorded videos (audio processing + thumbnails + variants + storyboard + transcription if mic was present)
- No HLS segments — `source.mp4` is the canonical input

### The Admin API

- Currently HTMX-driven HTML, not a JSON API
- All admin routes accept session cookie OR `lca_` bearer token, so scripting/automation already works against the same endpoints
- A separate JSON API surface deferred until there's a concrete consumer (backup tools, AI metadata enrichment, sync to external systems, etc.)
- Admin tokens are intentionally a separate system from `lck_` recording tokens — different concerns, different security boundaries

## Viewer-Facing Niceties

- **`/:slug` SEO & OEmbed stuff** — canonical link, `og:title`/`og:description`/`og:image`/`og:video`, `og:type=video.other`, Twitter Card `player` type, JSON-LD with author, oEmbed `<link rel="alternate">` discovery. Unlisted videos get `<meta name="robots" content="noindex">` + `X-Robots-Tag: noindex` header
- **`/:slug/embed` stuff including `/oembed` URL** — chromeless player; pre-play overlay with title/duration/play button; `border-radius: 0` forced on Vidstack internals; `/oembed` returns iframe HTML with `maxwidth`/`maxheight` clamping (Notion/WordPress/anything that supports oEmbed discovery picks it up)
- **The player, versions, poster, subtitles, storyboard, transcriptions etc.** — Vidstack via jsDelivr CDN; MP4 preferred / HLS fallback; auto-poster from thumbnail; SRT captions track; storyboard hover-scrub; HTTP Range support on every media route for proper seeking
- **`/:slug.json`** — full structured metadata (id, slug, status, visibility, title, description, duration, dates, transcript, URL bundle with absolute URLs)
- **`/:slug.md`** — Markdown metadata + transcript + bulleted Links section. Designed for `curl`-friendly / LLM-friendly consumption
- **`/feed.xml` (and `/rss`)** — RSS 2.0 + Media RSS namespace; `/rss` 301-redirects to `/feed.xml`. Includes `<enclosure>` (basic readers) and `<media:content>` (richer clients with duration/dimensions/thumbnail). Public + complete + non-trashed only
- **`/feed.json`** — JSON Feed 1.1; per-video `_urls` map (page, embed, json, md, raw); transcripts truncated to ~200 words; top-level `info_for_llms` key explaining the feed and pointing at `/llms.txt`
- **`/llms.txt`** — dynamically generated; intro + "How to Use This Site" endpoint docs (front-loaded so `curl | head` always sees them) + bulleted public video list + Links section. Built for AI agents / programmatic consumers
- **`/` hints for LLMs and machines etc** — 302 redirect to `https://danny.is`. The 302 body contains plaintext hints pointing at `/llms.txt`, `/feed.xml`, `/feed.json`, `/sitemap.xml`. Browsers follow the redirect instantly and never see the body; `curl` (without `-L`) displays it. `Link` header for RSS autodiscovery
- **🆕 `/sitemap.xml`** — DB-backed, video sitemap extension (`<video:video>` with thumbnail/title/content/player/duration), public + complete + non-trashed only
- **🆕 `/:slug.mp4`** — convenience 302 to `/:slug/raw/source.mp4` (302 not 301 so the canonical "default raw" can change as variants get wired up)
- **🆕 `/v/:slug` permanent 301** — preserves every URL ever shared from older app versions. Documented as "do not remove"

## Deployment

- **Hetzner VPS** — modest x86, hosts multiple unrelated services in their own Docker Compose stacks
- **Caddy** — shared reverse proxy across all services, automatic TLS via Let's Encrypt, routes `v.danny.is` to the loom-clone container over a shared Docker network (`caddy-net`)
- **Container** — `loom-clone-server`, no host port mapping (Caddy reaches it over the Docker network)
- **Data volume** — Hetzner Storage Volume mounted at `/mnt/data/loom-clone`, bind-mounted into the container at `/app/data`. Survives container rebuilds; portable to a different VPS
- **Compose layout** — `docker-compose.yml` (base) + `docker-compose.override.yml` (local dev with port mapping) + `docker-compose.prod.yml` (production with `caddy-net` + storage volume + `PUBLIC_URL`)
- **CI/CD** — GitHub Actions on push to `main` touching `server/**`. Tests gate deploy. Deploy SSHes into the VPS, pulls, rebuilds the container. ~40s end-to-end
- **VPS infra docs** — separate `danny-vps-infra` repo handles the host-level setup (Docker, firewall, Caddy)

> Note: Worth being clear that the macOS app is NOT distributed — it's built locally via the `app/scripts/install-prod.sh` script that puts a Release build in `/Applications` and points it at `https://v.danny.is`. Single-user tool — no notarization, no DMG, no auto-update.

### Archiving & Backup

- **Backup target:** Hetzner Storage Box BX11 (€3.20/month, 1 TB, separate from the production VPS)
- **Tool:** `restic` over SFTP, client-side encrypted (Hetzner can't read it), dedups, verifies snapshots
- **What's backed up:** only the irreplaceable bytes — `derivatives/source.mp4`, `recording.json`, `derivatives/thumbnail.jpg`, plus `app.db.bak` (a SQLite `.backup` snapshot taken immediately before each restic run for a consistent point-in-time DB)
- **What's not backed up:** anything regenerable from `source.mp4` — variants (720p/1080p), storyboards, thumbnail candidates, HLS segments. Restore drill regenerates them via the existing pipeline
- **Schedule:** daily at 03:30 UTC via cron on the VPS host (not inside the container). Weekly `restic check` for repository integrity. Optional Healthchecks.io ping for push alerting on failure
- **Retention:** 7 daily / 4 weekly / 12 monthly via `restic forget --prune`
- **Outside-restic safety net:** Hetzner's 10 product-level snapshots on the Storage Box — outside anything our scripts can touch. If a buggy backup run wipes the live contents, yesterday's snapshot is still intact
- **Storage cleanup (primary volume):**
  - HLS segments + `thumbnail-candidates/` deleted 10 days post-`complete` (viewer fallback to HLS only fires before `source.mp4` exists; safe after that)
  - `upload.mp4` deleted as soon as `source.mp4` is generated for that upload
  - Variants kept on disk (small relative to `source.mp4`, will be wired into player later)
- **Restore runbook** — `docs/developer/backup-and-restore.md` with the exact commands to list snapshots, restore to scratch, drop files back into place, restart the server, regenerate derivatives

## Performant Capture & Audio Sync

> Note: This section is the "how is the recording so good" story. Many of the items below double as resilience features — the line between "performance" and "resilience" is blurry. Keep this section focused on the capture-pipeline craft.

### A/V sync — frame-accurate by construction

- **All timestamps derived from hardware capture PTS, never wall clock.** Audio PTS reflects when sound hit the mic; video PTS reflects when frames left the sensor. Wall-clock-at-emit would bake asymmetric capture latency into the timeline
- **`recordingStartTime` anchored to a real captured frame's PTS** at commit, not `CMClockGetTime()`. Otherwise audio would land at PTS ~0 and video at ~70ms, producing a perceptible audio-lead
- **Single `AVCaptureSession` for camera + mic** (when both selected) — both outputs are timestamped against the session's `synchronizationClock`, so PTS values are directly comparable with sub-millisecond residual offset. Eliminates cross-session clock jitter that produces 5–30ms drift in talking-head recordings
- **Standalone mic session runs in parallel** for `audio.m4a` — survives a camera-session crash. Multi-client mic access is fine on macOS (cameras are exclusive, mics aren't)
- **AAC priming offset** handled via `initialSegmentStartTime` so HLS players know where audio actually starts
- **Pause accumulator** retimes both audio and video so resume produces continuous monotonic PTS — the pause "isn't there" in the output
- **HAL input latency diagnostic** explored but compensation deferred — Phase 1 (single session) closed the gap to <1ms residual; the additional HAL correction would be polish on something already imperceptible

### Frame integrity

- **Bounded camera FIFO queue (capacity 4)** instead of a single-slot cache — every captured camera frame in `cameraOnly` mode reaches the output. (The single-slot cache was silently losing 25% of frames whenever the metronome fell behind by even one frame)
- **Drift-corrected metronome** — emits at 30fps even when sources stall briefly
- **NTSC-tolerant camera format selector** — handles 29.97 vs strict 30fps reporting and the locked-format edge cases that throw uncatchable Objective-C exceptions when you try to set a frame duration outside the reported range

### Encoder and GPU performance

- **Three concurrent writers** — composited HLS (H.264), raw screen (ProRes 422 Proxy), raw camera (H.264)
- **ProRes screen master is on the dedicated ProRes engine**, not the H.264 engine. Frees the H.264 engine to handle just two streams (composited HLS + raw camera). On M\*Pro chips with a single H.264 engine, this is the difference between a stable recording and a degraded one — and at 1440p, between a clean recording and a kernel-level GPU deadlock
- **VideoToolbox tunings** — `kVTCompressionPropertyKey_RealTime = false`, `AllowFrameReordering = false`, hardware encoder enforced, writer warm-up before SCStream opens. Empirically resolved the 1440p kernel deadlock that previously required a power-button reboot
- **Rec. 709 colour metadata propagation** — camera buffers tagged on ingest with `.shouldPropagate` so CIImage and AVAssetWriter both honour the tags. Avoids the per-frame `colormatrix → clamp → swizzle → curve → ...` chain on untagged buffers (and avoids the WindowServer hang that comes from declaring an output colour space that doesn't match the input)
- **Camera adjustments at the composition layer only** — raw `camera.mp4` is never touched, preserving sensor-original footage as a master file

### What's NOT in the pipeline (and why)

> Note: Worth a short list of explicit non-features. Preempts "why didn't you do X" questions.

- No 4K preset — attempted, triggered userspace GPU watchdog cascades on M2 Pro. Replaced with 1440p
- No software H.264 fallback — would degrade quality and add complexity for a problem ProRes-on-the-other-engine already solves
- No per-device waveform/motion calibration (Cap-style) — single-shared-session + HAL diagnostic data showed it would be solving a problem that no longer exists at our resolution
- No Bluetooth-mic latency floor — AirPods reported 30ms, well below Cap's 120ms minimum, so we don't enforce one
