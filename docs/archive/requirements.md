# Product Requirements: Personal Video Tool

## What This Is

A personal tool for recording, sharing, and hosting video — replacing Loom and Cap. It consists of three parts: a native macOS app for recording, a server for processing and management, and a CDN-backed delivery layer for serving videos to viewers.

This is a single-user tool. There are no team features, no social features, no viewer accounts. One person records videos; other people watch them via URLs.

### Why This Exists

Loom works, but: I don't own my URLs, I can't switch between camera and screen-share mid-recording, the interface is cluttered with features I don't use, Atlassian keeps adding AI bloat, and it costs more than it should for what I need.

Cap is open-source and lets me use my own domain, but it feels half-baked — things break randomly, the codebase feels uncared-for, and it's not something I'd bet my permanent video library on.

I want a tool I control completely, on a domain I own, that does exactly what I need and nothing more.

### The Domain

Videos live at `v.danny.is`. A video's URL might be `v.danny.is/welcome-to-the-team` (public) or `v.danny.is/ef0de89916f0...` (unlisted with a long hash). These URLs are permanent.

### How I Use Video

These are the real-world situations this tool needs to serve:

- **Quick Slack replacements** — One-off talking-head videos or quick screenshares shared in Slack in place of a text message. "Hey, here's how you do this." These are fast, often throwaway once the other person has watched them. Speed of recording and sharing is everything.
- **Async announcements and briefings** — Videos that go out in public Slack channels or get embedded in Google Docs and Notion pages. "Pre-brief for the senior leadership meeting" or "Welcoming Sarah to the company." These have a wider audience and a longer shelf life.
- **Document intros** — Short talking-head videos at the top of longer documents, whether internal or external (like client proposals). A personal way of introducing what's in the document below.
- **Evergreen learning content** — Screen shares and talking-head videos embedded in Notion, Google Docs, GitHub docs, and internal knowledge bases. Tutorials, process explanations, "why we do things this way" content. These are permanent — they'll still be in those knowledge bases years from now. Some of these I've historically exported and uploaded to YouTube just to ensure they remain publicly available long-term.
- **Longer assembled videos** — Product demos, detailed tutorials, help documents. These often involve recording multiple segments and assembling them into a single video. With good pause and mode-switching in the desktop app, the need for post-recording assembly is reduced — but it remains a use case for more polished content down the line.

### Where The Hard Problem Is

Reliably managing, hosting, and distributing video is a well-solved problem. There are established services and open-source projects that handle encoding, storage, CDN delivery, and adaptive streaming. We should lean heavily on these.

The less-solved problem is the recording side: easily recording on a Mac with the flexibility I want (mode switching, high-quality capture, instant streaming upload) and having that video immediately available at a URL. Only Loom and Cap are close to this, and both have significant drawbacks. This is where the novelty and risk lie, and where most of the development effort will go.

The desktop app should be a proper native macOS application (Swift), not an Electron or Tauri wrapper. I've built Tauri apps before, but this needs direct access to OS-level screen capture, camera, and audio APIs for performance and reliability — and it needs to feel like a lightweight native menu bar app, not a web app pretending to be one. Loom's Electron-based desktop app frequently feels janky, which is part of the motivation for building this.

### Constraints

- **Single user**: Only I record and manage videos. No team or social features.
- **macOS only**: The desktop app only needs to work on macOS.
- **Traffic profile**: Most videos get 1-2 views (quick Slack messages). Some get 30-100 views/day for a while (docs, announcements). Occasionally something might get a few thousand views if shared publicly. Not YouTube scale, but needs to handle moderate spikes gracefully.
- **Cost**: This is a personal project. Infrastructure costs should be proportional to actual usage — ideally under $5-10/month at expected volumes (~75 videos/month, ~3 minutes average, modest viewership).
- **Existing video library**: I have hundreds of videos on Loom and some on Cap. The ability to import MP4 exports of these is important for migrating off those platforms over time.

---

## The Workflow

Every video follows the same path, regardless of whether it took 30 seconds or 30 minutes to make:

1. **Record** — Open the macOS app, choose inputs (camera, screen, mic), hit record. Optionally switch between modes during recording (e.g. talking head → screen share with camera overlay → back to talking head). Pause and resume as needed.

2. **Get it online** — The recording streams up to the server during recording, so that when I hit stop, the video is already available (or very nearly). A shareable URL is on my clipboard within seconds of stopping.

3. **Share** — Paste the URL into Slack, Notion, a Google Doc, an email, wherever. The recipient sees a clean video page or an embedded preview.

4. **Manage** — Log into the web admin to edit the title, slug, description, tags, or visibility. Or do nothing — the defaults should be good enough for quick-fire sharing.

5. **It lives there** — The video remains available at its URL indefinitely. It's backed up. It's served from a CDN. It doesn't depend on my server being up at the moment someone clicks the link.

Some videos are throwaway Slack messages that one person watches once. Some are evergreen tutorials embedded in documentation that hundreds of people will watch over years. The system treats them the same. The only difference is how much care I put into recording and managing them.

---

## Core Principles

These are the non-negotiable design constraints. When making tradeoffs, these are what we optimise for.

### 1. Instant Shareability

The moment I stop recording, I need a working URL. Not "processing, check back in 2 minutes" — a URL I can paste into Slack and the other person can watch immediately. This is the single most important feature. It's what makes async video a viable replacement for a quick call or a long message. Every architectural decision in the recording and upload pipeline should serve this requirement.

### 2. Never Lose Footage

Recording a 20-minute tutorial and losing it to an upload glitch or encoding failure is unacceptable. The system must guarantee that footage is recoverable. In practice this means: the desktop app keeps a full local copy of everything it records, and does not delete it until the server has confirmed the video is fully processed, encoded, backed up, and playable. If the network drops mid-recording, the local copy survives and can be uploaded later.

This principle also extends to the server side: processed videos should be backed up to durable object storage (S3 or equivalent), not solely dependent on the server's local disk.

### 3. Own My URLs

Every video lives on `v.danny.is`, a domain I control. The underlying infrastructure can use whatever services make sense, but the public-facing URL is mine.

### 4. Permanent URLs

A video URL works forever. If I change a video's slug, the old URL becomes a 301 redirect to the new one. Videos embedded in Notion pages, Google Docs, and knowledge bases years from now must still work.

### 5. Reliability for Viewers

When someone clicks a video link, it works. The video loads fast, buffers quickly, and plays smoothly — regardless of where the viewer is, what device they're on, or whether my server happens to be restarting at that moment. Viewer-facing video delivery must not depend on my backend server's availability.

### 6. Simplicity

This tool does one thing: record, host, and share video. No comments, no likes, no reactions, no team workspaces, no viewer analytics dashboards. The viewer sees a video. I see a clean admin interface. The desktop app has the controls I need and nothing else.

---

## Recording Requirements (Desktop App)

The desktop app is a native macOS application. It sits in the menu bar and is fast to invoke.

### Inputs

- **Camera**: I must be able to select which camera input device to use.
- **Microphone**: I must be able to select which microphone input device to use.
- **Screen**: I must be able to select which display to record when screen sharing. Recording a specific window or a region of the screen is not required initially.

### Recording Modes

Three modes, selectable before and during recording:

1. **Camera + Mic** — Talking head. Full-frame camera feed with audio. For direct-to-camera messages, announcements, document intros.
2. **Screen + Mic** — Screen capture with audio, no camera. For quick demos and walkthroughs.
3. **Screen + Camera + Mic** — Screen capture with a camera overlay (picture-in-picture) and audio. The camera feed appears in a small circle or square in a corner of the screen. For screen shares where I want to be visible.

### Mode Switching

I must be able to switch between these modes during a recording. A hard cut between modes is fine — no transition effects needed. If the simplest reliable implementation requires me to pause recording, switch mode, then resume, that's acceptable. But ideally I can switch with a keyboard shortcut or button press without pausing.

This is a key differentiator from Loom and Cap, which cannot do this reliably during a single recording.

### Camera Overlay (Picture-in-Picture)

When recording in Screen + Camera + Mic mode:

- The camera feed appears as a small overlay in a corner of the screen recording.
- I should be able to choose the corner placement (bottom-left, bottom-right, etc.).
- I should be able to choose between a circular or rectangular crop for the overlay.
- Ideally, I can move and resize the overlay during recording (or at least while paused).

### Recording Controls

- **Pause / Resume**: I must be able to pause and resume recording without creating a new file or losing context.
- **Stop**: Stops recording. The URL should be available on my clipboard within seconds.
- **Trash**: Cancels the current recording and trashes any recorded footage.

### Quality

- Camera, microphone, and screen capture should all be captured at full or near-full native resolution and quality.
- High-quality local capture is the priority. What gets streamed up during recording can be at a lower quality/resolution if needed, as long as the full-quality version is uploaded afterward to "replace" it.

### Local Safety Net

- The app must always keep a complete local recording of everything captured.
- Local files are only cleaned up after the server confirms the video is fully processed, backed up, and playable.
- If the network fails during recording, the recording continues locally and can be uploaded when connectivity is restored.

### Streaming Upload

- The recording should be streamed to the server during recording, not uploaded as a single file after stopping. This is what enables the "instant URL" requirement.
- The desktop app uses AVAssetWriter's native fMP4 HLS segment output (`.mpeg4AppleHLS` profile) to produce segments during recording, uploaded individually via HTTPS PUT. The server stores segments in R2 and assembles the HLS playlist. When recording stops, the final segment is flushed and uploaded, the playlist is finalised, and the video is immediately playable. No FFmpeg or RTMP is needed client-side.

### Resource Behaviour

- When not recording, the app should use negligible system resources (CPU, memory, battery).
- When recording, it should be as performant as possible — minimal dropped frames, no audio sync issues, no degraded system performance.

### Nice-to-Haves (Recording)

These are not required for an initial version but are worth keeping in mind:

- **Quick metadata editing**: After recording, a small UI to edit the video's title and slug and see/copy the URL — without opening a browser.
- **Basic trimming**: Trim the start and end of a recording before or after upload. Remove dead air, false starts, etc.
- **Audio enhancement**: Basic noise reduction, gating, and pop reduction — either applied during recording or as a processing step before upload. Should be configurable and toggleable. If this proves difficult locally, we could choose to do this on the server instead after upload.
- **Camera adjustments**: Simple white balance and exposure tweaks directly in the app, for quick corrections before hitting record depending on lighting conditions.
- **On-device transcription**: Use Apple's on-device AI (or a local transcription model) to generate a transcript and suggested title, and send them to the server alongside the video.

---

## Processing & Management Requirements (Server)

The server receives video from the desktop app, processes it, stores it, and provides a web interface for management.

### Receiving & Processing

- Reliably receive the streamed recording from the desktop app (HLS segments or equivalent).
- Process and encode the video into formats suitable for delivery (adaptive bitrate HLS with multiple quality renditions).
- Generate thumbnails.
- Store the source recording and all processed outputs.
- Back up everything to durable object storage (S3 or equivalent).

The processing pipeline must be reliable above all else. If something fails mid-process, it should be recoverable — not silently lost.

### Storage & Backup

- All videos (source and processed) are stored on the server and backed up to object storage.
- The server should not be the single point of storage. If the server's disk fails, videos are recoverable from backups.

### Admin Web Interface

A web app for managing videos. Simple and functional — not a product in itself.

#### Video Library

- See all videos in a list and/or grid view.
- Each video shows a thumbnail, title, duration, date, and visibility status.
- Sort by date (newest first by default), title, or duration.
- Filter by tags and/or visibility status.
- Search by title or description.

#### Video Details & Editing

For each video:

- **Title**: Editable. Used as the page heading on the public video page.
- **Slug**: Editable. Determines the URL path (e.g. `v.danny.is/my-video`). When changed, the old slug becomes a 301 redirect.
- **Description**: Editable. Shown on the public video page. Optional.
- **Tags**: Add/remove tags for organisation.
- **Visibility**: One of three states:
  - **Public** — Short, readable slug. Indexable by search engines. Appropriate meta tags.
  - **Unlisted** — Long hash-based URL. Not indexable (`noindex` meta tag, excluded from sitemap). Accessible to anyone with the link.
  - **Private** — No public URL at all. Only visible in admin. Can be changed to public or unlisted later.
  - New videos default to **Unlisted** — they get a working URL immediately (for the instant-share workflow) but aren't indexed until explicitly made public.

#### Actions

- **View**: Watch the video in the admin interface.
- **Copy URL**: Copy the public/unlisted URL to clipboard.
- **Download**: Download the original recording as an MP4 file.
- **Delete**: Delete the video (with confirmation). Removes from public access, storage, and backups.
- **Upload**: Upload an MP4 file directly (for importing existing videos from Loom, Cap, YouTube exports, etc.).

### Nice-to-Haves (Server)

- **Automatic transcription**: Generate a text transcript of the video. Store alongside the video metadata.
- **Subtitles**: Generate and serve closed captions/subtitles derived from the transcript.
- **AI title & slug suggestions**: Suggest a title and slug based on the transcript content.
- **Basic web-based editor**: Trim, cut, and stitch videos in the browser. This may be where Remotion becomes interesting as a future direction.

---

## Delivery Requirements (Public-Facing)

This is what viewers see and what platforms interact with when they encounter a video URL.

### Video Page

When someone visits a video URL in a browser (e.g. `v.danny.is/welcome-to-the-team`), they see:

- A clean, minimal page with the video player front and centre.
- The video title below (or above) the player.
- The description, if one exists.
- The transcript, if one exists.
- Nothing else. No comments, no likes, no sign-up prompts, no related videos, no branding beyond what's appropriate for a personal tool.

The page should feel fast and intentional — like it was made by someone who cares about the viewer's experience.

The page should have appropriate SEO metadata etc.

### Embedding

When someone embeds the URL in an iframe, they should get just the video player with no surrounding page chrome. This makes embedding in documentation, blog posts, and other tools straightforward.

An explicit embed URL (e.g. `v.danny.is/welcome-to-the-team/embed`) should be available for this purpose, but if possible we should try to detect when requests are coming from this kinda context and server this instead of the video page.

### Unfurling & Link Previews

When the URL is shared in tools like Slack, Notion, Discord, iMessage, LinkedIn, etc., it should produce a good link preview. This requires:

- **Open Graph tags**: `og:title`, `og:description`, `og:image` (thumbnail), `og:video` (direct MP4 URL for platforms that support inline video), `og:type`, etc.
- **Twitter Card tags**: For Twitter/X link previews.
- **oEmbed endpoint**: A `/oembed` endpoint that returns standard oEmbed JSON. This enables discovery-based embedding in platforms that support it.
- **oEmbed discovery tag**: A `<link rel="alternate" type="application/json+oembed" ...>` tag in the video page's HTML head.

**Known reality**: Slack only shows inline video players for whitelisted domains (YouTube, Vimeo, Loom, etc.). For my domain, Slack will show a rich link preview (thumbnail + title + description) but not an inline player. Similarly, Notion auto-embeds videos from known providers (via Iframely). My domain won't be auto-embedded initially — users would need to use `/embed` manually. Getting listed with Iframely is a possible future step.

The baseline goal is: **a good-looking link preview with thumbnail, title, and description everywhere**. Inline playback in specific platforms should be supported *wherever possible*, and especially in Slack & Notion.

### Performance & Reliability

This is where the "delivery" layer earns its keep:

- **CDN-backed**: Video files are served from a CDN, not directly from my server. Viewers should get content from an edge location close to them.
- **Independent of backend**: If my server is down for maintenance, restarting, or otherwise unavailable, previously published videos must still be watchable. The delivery layer must not depend on the backend being up.
- **Fast loading**: Videos should start playing quickly. Adaptive bitrate streaming (HLS) helps here — the player starts with a lower quality and steps up as bandwidth allows.
- **Handles traffic spikes**: If a LinkedIn post goes mildly viral and a few thousand people hit the same video URL in an hour, it should be fine. We're not designing for YouTube scale, but we're not designing for "falls over at 50 concurrent viewers" either.

---

## Inspiration & Prior Art

- **Loom**: The industry standard for async video. Their HLS segment-during-recording architecture (client-side FFmpeg to .ts segments) proved the "instant URL on stop" concept. Our approach achieves the same result using native macOS APIs (AVAssetWriter fMP4 segments) instead of bundling FFmpeg. See `docs/research/loom-research.md`.
- **[Cap.so](https://github.com/CapSoftware/Cap)**: Open-source screen recorder, analysed in depth. Key lessons: their use of ScreenCaptureKit via Rust bindings validates native capture APIs; their progressive MP4 upload approach (not HLS) cannot achieve instant playback and is an anti-pattern we avoid; their dual Studio/Instant mode split informed our decision to build a single unified pipeline. See `docs/research/03-cap-codebase-analysis.md`.
- **[Screen Studio](https://www.screen.studio/)**: Mac-native recorder with automatic zoom and cursor smoothing. The benchmark for polished screen recording output. Not a sharing platform, but worth studying for future post-processing features.
- **[Remotion](https://www.remotion.dev/)**: Programmatic video in React. Not relevant for recording, but potentially interesting for future web-based editing.

---

## Future Possibilities

- **On-device transcription**: WhisperKit (open-source Swift Whisper) for on-device transcription in the near term. Apple's SpeechAnalyzer framework (macOS 26) as the long-term native solution. Transcripts enable AI-generated titles, summaries, and searchable video content. Planned for Phase 2.
- **Watermarking**: Optional subtle watermark in the bottom corner, toggleable.
- **Video editor**: A web-based or desktop editor for trimming, cutting, stitching, and assembling videos. Remotion is a potential foundation for a browser-based editor. Tella's text-based editing (edit the transcript to edit the video) is a compelling pattern to study.
- **Basic view analytics**: Simple per-video view counts. Not a dashboards-and-funnels analytics product — just enough to know which videos are being watched. Planned for Phase 3.
- **Automatic zoom and cursor effects**: Screen Studio-style post-processing (auto-zoom into click targets, cursor smoothing). Aspirational for polished content.
