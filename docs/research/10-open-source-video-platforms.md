# Open Source Video Platforms & Tools Survey

Survey of open-source video platforms, players, and processing tools. The goal is to understand what exists, identify anything worth adopting or studying, and recommend a video player for the viewer page.

For full project context, see `requirements.md`. For prior research on hosted video platforms (Mux, Bunny, Cloudflare Stream, etc.), see `docs/research/video-hosting-research.md`.

---

## Video Hosting / Sharing Platforms

### PeerTube

**What it is**: Federated, decentralized video hosting platform. The largest open-source YouTube alternative. TypeScript/Node.js backend, Angular frontend, PostgreSQL database. 14.6k GitHub stars, 152 releases, actively maintained by Framasoft.

**Architecture**: Node.js + Express server, Angular SPA for the frontend, PostgreSQL for metadata, Redis for caching/jobs. Uses FFmpeg for all transcoding. Supports ActivityPub federation (instances can follow each other and share content). Uses WebRTC for optional P2P viewing to reduce server bandwidth.

**Video processing**: FFmpeg-based transcoding pipeline that generates multiple HLS renditions (adaptive bitrate). Supports configurable transcoding profiles (resolution ladder, codec selection). Has a job queue system for processing. Generates thumbnails and preview sprites automatically.

**Delivery**: Serves HLS directly from the instance (or via WebTorrent/WebRTC P2P). No built-in CDN integration, though you could put one in front. The HLS implementation is mature and well-tested.

**Relevance to our project**: Too heavy and too opinionated for our needs. It's a full social video platform with federation, comments, subscriptions, channels, and multi-user accounts. Stripping this down to a single-user tool would be more work than building from scratch. However, there are specific patterns worth studying:

- **Encoding pipeline**: PeerTube's FFmpeg job queue and HLS generation logic is battle-tested. Worth studying the transcoding profiles and how they handle the resolution ladder.
- **HLS packaging**: The way they generate and serve HLS manifests with multiple renditions.
- **Resumable upload handling**: They support tus-based resumable uploads.

**Verdict**: Not a foundation candidate. Study the encoding pipeline and HLS generation code.

---

### MediaCMS

**What it is**: Modern video and media CMS. Django + React, PostgreSQL, Celery task queue, Redis, Nginx, FFmpeg. 4.8k GitHub stars. AGPL-3.0 licensed. Actively maintained.

**Architecture**: Django backend with Django REST Framework API, React frontend, Celery workers for async transcoding, PostgreSQL for data, Redis for caching and Celery broker. Uses FFmpeg and Bento4 (for MP4 fragmentation/HLS packaging) for transcoding.

**Video processing**: Multiple transcoding profiles with sane defaults for resolutions from 144p through 1080p. Supports H.264, H.265, and VP9 codecs. Generates HLS for adaptive streaming. Uses Celery for background processing with priority-based transcoding queues. Supports remote transcoding workers for scaling. Automatic transcription via Whisper integration.

**Key features relevant to us**: Public/private/unlisted visibility workflows, chunked/resumable uploads, REST API, video trimmer, configurable transcoding profiles, Whisper-based transcription, customizable player (based on Video.js), embed code generation.

**Relevance to our project**: This is the closest thing to what we need. A self-hostable video CMS with the right feature set: upload, transcode, serve HLS, manage metadata, public/unlisted/private visibility. The Django + Celery + FFmpeg architecture is a proven pattern.

However, there are significant reasons we likely would not use it as a direct foundation:

- It's Django/Python. Our existing research suggests we'd build the server in something like Node.js/TypeScript or Go for better alignment with the streaming upload pipeline and real-time processing needs.
- It's designed as a multi-user platform with RBAC, which adds complexity we don't need.
- The transcoding pipeline is tightly coupled to the Django/Celery stack.

**Patterns worth studying**:
- Transcoding profile configuration (resolution ladder, codec settings, FFmpeg flags)
- Bento4 integration for MP4 fragmentation and HLS packaging
- Whisper transcription integration
- Visibility workflow (public/unlisted/private) -- their implementation matches our requirements closely
- Chunked upload handling

**Verdict**: Not a foundation candidate (wrong language, too much multi-user complexity). The single most useful open-source project to study for our encoding pipeline and metadata management patterns.

---

### Castopod

**What it is**: Open-source podcast hosting platform. PHP/CodeIgniter. 833 GitHub stars. AGPL-3.0 licensed.

**Relevance to our project**: Minimal. Castopod is podcast-focused (audio, RSS feeds, ActivityPub social features). The distribution model (RSS + podcast directories) is fundamentally different from video hosting. The ActivityPub/fediverse integration is interesting but irrelevant to our use case.

**Verdict**: Skip. Not relevant to a video hosting project.

---

### Tube Archivist

**What it is**: Self-hosted YouTube media server for archiving YouTube content. Python/Django, Elasticsearch for search, Redis, yt-dlp for downloading. 7.7k GitHub stars. GPL-3.0 licensed.

**Architecture**: Django backend, Elasticsearch for indexing/search, yt-dlp for downloading videos from YouTube, stores videos on local filesystem. Uses a custom web UI. Docker-based deployment.

**Relevance to our project**: Limited. Tube Archivist is focused on downloading and archiving content from YouTube, not hosting original recordings. It doesn't have a transcoding pipeline, upload API, or HLS streaming. The search/indexing approach (Elasticsearch) is overkill for our scale.

**One useful pattern**: Their metadata management and organization model (tags, playlists, watched/unwatched state) is well-designed for a personal video library. Worth a glance if we want ideas for library management UI.

**Verdict**: Not relevant for our core use case. Tangentially interesting for library management patterns.

---

## Video Players

This is the most directly actionable section. We need a player for the viewer page that handles HLS adaptive streaming, looks clean, and is customizable.

### HLS.js

**What it is**: JavaScript library for HLS playback in browsers. The standard for playing HLS in browsers that don't natively support it (everything except Safari). Uses MediaSource Extensions. 15k+ GitHub stars. MIT licensed. Actively maintained by the video-dev community.

**Bundle size**: ~70kB gzipped (full), ~45kB gzipped (light build without subtitles/EME/alternate audio).

**HLS support**: Comprehensive. VOD, live, DVR, fMP4, MPEG-2 TS, adaptive bitrate with multiple quality switching modes, AES-128 decryption, CEA-608/708 captions, WebVTT subtitles, low-latency HLS.

**UI**: None. HLS.js is a playback engine only -- it attaches to a standard HTML5 `<video>` element and handles HLS parsing/transmuxing. You provide your own UI or use a player that wraps it.

**Relevance**: HLS.js is the foundation that most other players build on for HLS support. If we use Vidstack, Plyr, or build a custom player, HLS.js is almost certainly the HLS engine underneath. We don't use HLS.js directly unless we're building a completely custom player UI.

**Verdict**: Essential infrastructure. Will be used indirectly through whichever player we choose.

---

### Vidstack

**What it is**: Modern, framework-agnostic media player. The successor to Plyr 3.x and Vime 5.x. TypeScript-first. Supports React, Vue, Svelte, Solid, Angular, and Web Components. 3.5k GitHub stars. MIT licensed.

**Bundle size**: ~54kB gzipped for all core features and components. Tree-shakeable. Heavier parts (providers, captions) are lazy loaded.

**HLS support**: Uses HLS.js under the hood. Full adaptive streaming support. Also supports DASH via dash.js.

**Features**: Quality selector, playback speed, subtitles/captions (VTT, SRT, SSA), keyboard controls, fullscreen, picture-in-picture, AirPlay, Google Cast, thumbnails/previews on seek, chapters, tooltips, accessible (WCAG 2.1). Production-ready default layout included, or build your own with 30+ headless components.

**UI customizability**: Excellent. Two approaches: use the pre-built Default Layout and customize via 150+ CSS variables, or build a completely custom UI using headless components and hooks. First-class Tailwind CSS support. SSR-friendly.

**Maintenance status**: Actively developed. Originally built for Reddit at scale. Backed by Mux (streaming sponsor). Regular releases.

**Relevance**: The most modern and well-designed player option. TypeScript-first, excellent React support, clean API, good defaults, highly customizable. The pre-built layout would get us to a polished viewer page quickly, with the option to customize later. The fact that it was built for Reddit and is sponsored by Mux is a strong signal.

**Verdict**: Strong recommendation. Best combination of modern architecture, features, customizability, and maintenance.

---

### Plyr

**What it is**: Simple, accessible, customizable HTML5 media player. 26k+ GitHub stars. MIT licensed.

**Bundle size**: ~30kB gzipped (JS + CSS).

**HLS support**: Not built-in. Requires pairing with HLS.js as a separate integration. Works but requires manual wiring.

**Features**: HTML5 video/audio, YouTube and Vimeo embeds, speed controls, captions, keyboard shortcuts, fullscreen, PiP, preview thumbnails, i18n. Monetization (ad) support.

**UI customizability**: Good. Clean default design. Customizable via CSS custom properties. The markup structure is semantic and accessible.

**Maintenance status**: The original author (Sam Potts) has effectively moved on to Vidstack, which is positioned as the successor. The last major release (3.x) is stable but feature-frozen. Bug fixes continue but no significant new development.

**Relevance**: Plyr is the spiritual predecessor to Vidstack. It's simpler and lighter, but lacks built-in HLS support, has no framework-specific integrations, and is in maintenance mode. If we wanted the absolute lightest player and were okay manually integrating HLS.js, Plyr would work. But Vidstack does everything Plyr does, better, with active development.

**Verdict**: Superseded by Vidstack. Only consider if bundle size is the primary concern and you want maximum simplicity.

---

### Video.js

**What it is**: The most established open-source web video player. 15 years old. 39.6k GitHub stars. Apache 2.0 licensed. Now sponsored by Mux (as of 2025).

**Bundle size**: ~195kB gzipped. Significantly larger than alternatives.

**HLS support**: Via the videojs-http-streaming (VHS) plugin, which is included by default. Full adaptive streaming support.

**Features**: Comprehensive. Every feature you'd expect: quality selector, speed controls, captions, keyboard shortcuts, fullscreen, PiP, ads. Massive plugin ecosystem (hundreds of plugins). Works on desktops, mobile, tablets, smart TVs.

**UI customizability**: Moderate. Customizable via CSS and the plugin system, but the component architecture is older and less flexible than Vidstack's. Skinning requires more effort.

**Maintenance status**: Active. Video.js 10 is coming in early 2026 with a major rewrite. Currently sponsored by Mux. Large community.

**Relevance**: Video.js is the safe, established choice. MediaCMS uses it. It works. But it's showing its age -- the bundle is large, the API is older, and customization requires more work. The upcoming v10 rewrite may address some of this, but it's not available yet.

**Verdict**: A valid choice if you want maximum ecosystem/plugin support. But for a new project where bundle size and modern DX matter, Vidstack is preferable.

---

### Shaka Player

**What it is**: Google's adaptive streaming player. Supports DASH, HLS, and experimental MOQT. 7.5k GitHub stars. Apache 2.0 licensed.

**Bundle size**: ~130kB gzipped (estimated). Heavier than Vidstack, lighter than Video.js.

**HLS support**: Full HLS support including low-latency, fMP4, MPEG-2 TS, DRM (FairPlay, Widevine, PlayReady), offline storage. Also supports DASH natively (without a separate library).

**Features**: Comprehensive adaptive streaming, DRM support across all major systems, offline playback via IndexedDB, broad device support (smart TVs, Chromecast, Xbox, PlayStation). Very strong on the streaming/DRM side.

**UI customizability**: Limited default UI. Shaka is more of a streaming engine than a player with a polished UI. The built-in UI is functional but basic. Customization requires more work.

**Maintenance status**: Actively maintained by Google. Regular releases.

**Relevance**: Shaka is overkill for our use case. Its strengths (DRM, DASH, offline playback, smart TV support) are not things we need. We don't need DRM, we're using HLS (not DASH), and we're targeting web browsers (not smart TVs). The UI is not as polished or customizable as Vidstack's.

**Verdict**: Skip unless DRM or DASH support becomes a requirement. Too heavy and enterprise-focused for a personal video tool.

---

### Player Comparison Summary

| Feature | Vidstack | Plyr | Video.js | Shaka | HLS.js |
|---------|----------|------|----------|-------|--------|
| Bundle size (gzip) | ~54kB | ~30kB | ~195kB | ~130kB | ~70kB |
| Built-in HLS | Yes (via hls.js) | No (manual) | Yes (VHS) | Yes (native) | N/A (is HLS) |
| UI quality | Excellent | Good | Good | Basic | None |
| Customizability | Excellent | Good | Moderate | Limited | N/A |
| React support | First-class | None | None | None | N/A |
| TypeScript | First-class | No | Partial | Partial | Yes |
| Framework support | React, Vue, Svelte, Solid, Angular, WC | Vanilla JS | Vanilla JS, plugins | Vanilla JS | Vanilla JS |
| Maintenance | Active | Maintenance mode | Active (v10 coming) | Active | Active |
| License | MIT | MIT | Apache 2.0 | Apache 2.0 | Apache 2.0 |

### Player Recommendation

**Use Vidstack.** It is the clear best choice for a new project:

1. Modern, TypeScript-first architecture with first-class React support.
2. Excellent pre-built layout that can be customized via CSS variables, or build completely custom UI with headless components.
3. Built-in HLS support via hls.js, with quality selector, speed controls, captions, keyboard shortcuts, and all the viewer features we need.
4. Lightweight (~54kB gzip) and tree-shakeable. Roughly a quarter of Video.js.
5. Built for production at Reddit's scale and sponsored by Mux.
6. MIT licensed.

The viewer page could be functional with Vidstack's Default Layout in minimal time, then progressively customized to match the design we want.

---

## Video Processing Tools

### FFmpeg

**What it is**: The foundational command-line tool for video/audio processing. Used by virtually every video platform, open-source or commercial, for transcoding, muxing, filtering, and analysis.

**Relevance**: Non-negotiable. FFmpeg is the encoding engine we'll use regardless of other decisions. The key question is how we invoke it: directly via CLI (shelling out from our server), via a library binding (e.g., fluent-ffmpeg in Node.js), or via a wrapper/queue system.

**Key patterns to study**:
- HLS generation with multiple renditions: `ffmpeg -i input.mp4 -map 0:v -map 0:a -c:v libx264 -preset fast -crf 23 -g 48 -sc_threshold 0 -c:a aac -b:a 128k -f hls -hls_time 6 -hls_list_size 0 -hls_segment_type fmpegts output.m3u8`
- Multi-bitrate encoding in a single pass using complex filter graphs
- Thumbnail/sprite generation for seek previews
- Hardware acceleration options (VideoToolbox on macOS, NVENC on Linux with NVIDIA GPUs)

**Verdict**: Will be used directly. Study MediaCMS and PeerTube's FFmpeg invocation patterns for HLS generation.

---

### Jellyfin (transcoding pipeline)

**What it is**: Free software media server (.NET/C#). Fork of Emby. 37k+ GitHub stars. GPL-2.0 licensed.

**Architecture**: .NET 9 backend, uses its own fork of FFmpeg (jellyfin-ffmpeg) with additional patches for hardware transcoding. Supports real-time transcoding (transcode-on-the-fly when a client requests playback) and ahead-of-time transcoding.

**Relevance to our project**: Limited direct relevance -- Jellyfin is a media server for playing back existing media libraries (movies, TV shows), not a video hosting/recording platform. It doesn't have upload APIs, HLS pre-generation, or the sharing/embedding features we need.

**Patterns worth noting**:
- Their FFmpeg fork (jellyfin-ffmpeg) includes useful patches for hardware acceleration and codec support that could inform our FFmpeg configuration.
- The real-time transcoding approach (transcode on playback request) is interesting but not our model -- we want to pre-generate HLS renditions after upload so playback is instant without transcoding.

**Verdict**: Not relevant as a foundation. The jellyfin-ffmpeg patches could be useful reference for hardware acceleration configuration.

---

### Remotion

**What it is**: Framework for creating videos programmatically using React. 41.2k GitHub stars. 602 releases. Special license (free for individuals, paid for companies).

**Architecture**: Write React components that describe video frames. Remotion renders each frame using a headless browser and stitches them into a video using FFmpeg. Can be used for automated video generation, data-driven videos, and programmatic editing.

**Relevance to our project**: Not relevant for recording or hosting. Potentially interesting as a future direction for a web-based video editor (the "longer assembled videos" use case mentioned in requirements). The Remotion Recorder is a separate product built on Remotion, but it's a JavaScript-based recording tool, not native macOS.

**Verdict**: Not relevant now. Bookmark for the future "web-based editor" nice-to-have.

---

## Upload Tools

### tus (Resumable Upload Protocol)

**What it is**: An open protocol for resumable file uploads over HTTP. Supported by Mux, Cloudflare, Vimeo, and many other services. The protocol spec is at tus.io.

**How it works**: The client splits a file into chunks and uploads them sequentially. If the upload is interrupted, the client can query the server for the current offset and resume from where it left off. The protocol uses HTTP headers (`Upload-Offset`, `Upload-Length`, `Tus-Resumable`) to coordinate.

**Implementations**:
- **tusd**: Reference server implementation in Go. 3.7k GitHub stars. Supports local disk, S3, GCS backends. Can trigger webhooks on upload completion.
- **tus-js-client**: Official JavaScript client. Works in browsers and Node.js.
- **tus-node-server**: Node.js server implementation. Supports local disk and S3 backends.

**Relevance to our project**: Highly relevant. Our streaming upload pipeline needs resumability -- if the network drops during a recording upload, we need to continue without losing data. Both Mux and Cloudflare Stream support tus for direct uploads. If we build our own server, we should either use tus-node-server or implement the tus protocol.

However, our primary upload model is streaming HLS segments during recording (not uploading a single file afterward). tus is more relevant for the fallback case: uploading a complete recording after the fact (e.g., when the network was down during recording, or for importing existing MP4s).

**Verdict**: Adopt for the MP4 upload/import path. For the primary streaming-during-recording path, we'll use our own chunked HLS segment upload, but tus is the right protocol for single-file uploads.

---

### Uppy

**What it is**: Modular JavaScript file upload library by Transloadit. 29k+ GitHub stars. MIT licensed. Supports React, Vue, Svelte, Angular.

**Features**: Drag-and-drop UI, webcam capture, import from Google Drive/Dropbox/Instagram/URL, resumable uploads via tus, direct S3 uploads, progress tracking, file recovery after browser crashes ("Golden Retriever" plugin).

**Architecture**: Plugin-based. Core is lightweight; add plugins for UI (Dashboard), sources (Webcam, Google Drive), and destinations (tus, XHR, S3).

**Relevance to our project**: Relevant for the admin web interface's file upload feature (the "Upload MP4" action for importing existing videos). Uppy's tus plugin + Dashboard UI would give us a polished upload experience with drag-and-drop, progress bars, and resumability out of the box.

Not relevant for the desktop app's streaming upload pipeline (that's a custom native implementation in Swift).

**Verdict**: Consider for the admin web interface's import/upload feature. It would save us from building upload UI from scratch.

---

## Strategic Assessment

### Can any open-source platform serve as our server foundation?

**No.** After surveying the landscape:

- **PeerTube** is far too complex (federation, multi-user, social features). Stripping it down would be harder than building from scratch.
- **MediaCMS** is the closest match in features, but it's Django/Python (likely not our stack), multi-user, and tightly coupled. Extracting just the parts we need isn't practical.
- **Jellyfin** is a media consumption server, not a video hosting/sharing platform.
- **Tube Archivist** is a YouTube archival tool, not a hosting platform.

The conclusion matches what requirements.md already states: hosting and distributing video is a well-solved problem, and we should lean on managed services (Mux, Bunny) or proven patterns (FFmpeg + HLS + S3 + CDN) rather than adopting a heavyweight open-source platform.

### What's worth studying or adopting?

**Adopt directly:**
- **Vidstack** as the viewer page video player
- **tus protocol** (via tus-node-server or Mux's tus support) for resumable MP4 uploads
- **Uppy** for the admin upload UI (optional, but saves time)
- **FFmpeg** for all transcoding (obvious, but worth stating)

**Study for patterns:**
- **MediaCMS** transcoding pipeline: FFmpeg flags, resolution ladder, Bento4 for HLS packaging, Celery job queue pattern, Whisper transcription integration
- **PeerTube** HLS generation: how they structure manifests, handle the encoding queue, and manage transcoding profiles
- Both platforms' visibility workflow implementations (public/unlisted/private)

**Skip:**
- Castopod (podcast, not video)
- Tube Archivist (archival, not hosting)
- Jellyfin (consumption, not hosting)
- Shaka Player (enterprise-focused, overkill)
- Remotion (future bookmark only)

---

## Summary of Recommendations

1. **Video Player**: Vidstack. Modern, lightweight, TypeScript-first, built-in HLS, excellent customizability. Use the Default Layout initially, customize later.

2. **No open-source platform as foundation**: Build the server ourselves using proven patterns (FFmpeg + job queue + S3 + CDN), informed by studying MediaCMS and PeerTube's encoding pipelines.

3. **Upload protocol**: Use tus for single-file uploads (MP4 import, fallback upload). Use a custom chunked HLS segment upload for the streaming-during-recording primary path.

4. **Admin upload UI**: Consider Uppy for drag-and-drop MP4 import in the admin interface.

5. **Encoding pipeline study**: MediaCMS is the single best open-source reference for our transcoding pipeline. Study their FFmpeg invocations, resolution ladder, Bento4 usage, and Whisper integration. PeerTube is a secondary reference.
