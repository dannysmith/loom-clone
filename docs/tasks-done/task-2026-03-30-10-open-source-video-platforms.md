# Research: Open Source Video Platforms & Tools

## Priority

Tier 3 — Useful context but not blocking. These platforms could provide a foundation for our server/delivery layer, or at minimum teach us useful patterns.

## Context

Before building our server and delivery infrastructure from scratch, we should understand what open-source video platforms exist. Some might be usable as a foundation (saving us from building everything ourselves). Even if we don't adopt any of them, their architectures and solutions to common problems (encoding pipelines, HLS packaging, video page serving, API design) are worth studying. Read `requirements.md` for full project context.

## Platforms to Evaluate

### Video Hosting / Sharing Platforms

- **[PeerTube](https://github.com/Chocobozzz/PeerTube)** — Federated video hosting. Full-featured platform with encoding, HLS, and a viewer. Probably too heavy for our needs, but the encoding pipeline and HLS implementation are worth studying.
- **[MediaCMS](https://github.com/mediacms-io/mediacms)** — Modern video CMS built with Django + React. Self-hostable. Might be closer to our needs.
- **[Castopod](https://github.com/ad-aures/castopod)** — Podcast hosting, not video, but similar distribution challenges.
- **[Tube Archivist](https://github.com/tubearchivist/tubearchivist)** — YouTube archival tool. Interesting for how they handle video storage, metadata, and organization.

### Video Players (for the viewer page)

- **[HLS.js](https://github.com/video-dev/hls.js)** — JavaScript HLS player. The standard for playing HLS in browsers that don't support it natively.
- **[Plyr](https://github.com/sampotts/plyr)** — Clean, accessible media player. Supports HLS via plugins.
- **[Video.js](https://github.com/videojs/video.js)** — Established video player framework with HLS support.
- **[Shaka Player](https://github.com/shaka-project/shaka-player)** — Google's player for DASH and HLS. Good adaptive streaming.
- **[Vidstack](https://github.com/vidstack/player)** — Modern, framework-agnostic player. Worth a look.

### Video Processing Tools

- **[FFmpeg](https://ffmpeg.org/)** — The foundation. Not a platform, but the encoding engine everything else builds on.
- **[Jellyfin](https://github.com/jellyfin/jellyfin)** — Media server. Their transcoding pipeline handles many of the same challenges.
- **[Remotion](https://github.com/remotion-dev/remotion)** — Programmatic video creation in React. Not relevant for recording, but potentially interesting for future web-based editing.

### Other Relevant Open Source

- **[tus](https://github.com/tus/tus-resumable-upload-protocol)** — Resumable upload protocol. Relevant for reliable video upload.
- **[Uppy](https://github.com/transloadit/uppy)** — File upload library that supports tus, S3, and more.

## Key Questions

### For Each Platform

- What's the architecture? (Language, framework, database, storage, CDN approach.)
- How do they handle video processing? (Encoding, HLS generation, thumbnail creation.)
- How do they serve video to viewers? (Direct, CDN, adaptive streaming.)
- Could we use this as a foundation (or fork it), or is it too opinionated / too heavy?
- What specific code or patterns are worth studying?

### For Video Players

- What's the bundle size and performance?
- How well does it handle HLS adaptive streaming?
- Does it support the features we need? (Quality selector, playback speed, subtitles, keyboard controls.)
- How customizable is the player UI?
- What's the maintenance status and community activity?

### Strategic Question

- Is there a lightweight open-source video hosting solution that we could deploy as our server, rather than building one from scratch? It would need to support: custom domain, HLS delivery, simple metadata management, API for the desktop app. Probably not — but worth checking.

## Research Approach

- Start by reading the existing research: `docs/research/video-hosting-research.md` (prior research on hosting and delivery options).
- For platforms: review their GitHub repos, architecture docs, and feature lists. Focus on the parts relevant to us (encoding pipeline, HLS, delivery, API).
- For players: look at demos, documentation, bundle sizes, and GitHub activity. The player is a smaller decision but affects the viewer experience directly.
- Don't spend too much time here — this is context-gathering, not deep analysis. Flag anything that's clearly worth a deeper look.

## Expected Output

A research document that:

1. Briefly profiles each evaluated platform/tool with its relevance to our project.
2. Identifies any platforms that could serve as a foundation (likely none, but worth confirming).
3. Highlights specific code, patterns, or approaches worth studying further.
4. Recommends a video player for the viewer page (or narrows to 2-3 candidates).
5. Notes any other useful open-source tools or libraries discovered during research.

## Related Tasks

- Task 06 (Video Processing & Encoding) — open-source encoding pipelines are directly relevant.
- Task 08 (Server & Admin Stack) — an open-source platform could shortcut server development.
- Task 09 (Viewer Experience) — video player choice is a key part of the viewer experience.
