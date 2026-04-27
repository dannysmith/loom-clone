# Task: Viewer-facing Edge Layer

High-availability CDN/Caching layer for serving all viewer-facing routes to users as performantly and efficiently as possible. We care about this because:

1. Better UX & Speed for viewers.
2. Higher availability than we can manage with just our Hertzner VPS.
3. Handles sudden spikes in traffic to certain videos gracefully.
4. Can potentially continue to serve content if the Hertzner box is temporarilly down for any reason.

## Public Routes

Full reference: `docs/developer/server-routes-and-api.md`.

### 1. Global routes

Static or rarely-changing content with no per-video slug. These are cheap to cache aggressively.

| Route          | What it returns           | Notes                              |
| -------------- | ------------------------- | ---------------------------------- |
| `/robots.txt`  | Static text               | Disallows `/admin` and `/api`      |
| `/favicon.ico` | 204 No Content            | Placeholder — no file served yet   |
| `/static/*`    | CSS, fonts, client assets | Static files from `server/public/` |

### 2. Global dynamic routes

Generated from DB state. Can be cached but need invalidation when *public* videos change (added, renamed, trashed, visibility changed, etc).

| Route             | What it returns                             | Notes                                                           |
| ----------------- | ------------------------------------------- | --------------------------------------------------------------- |
| `/sitemap.xml`    | XML sitemap with `<video:video>` extensions | Public + complete + non-trashed videos                          |
| `/feed.xml`       | RSS 2.0 + Media RSS feed                    | Canonical RSS URL                                               |
| `/feed.json`      | JSON Feed 1.1                               | Includes truncated transcript excerpts, `_urls` map per video   |
| `/llms.txt`       | Dynamic markdown (llmstxt.org format)       | Endpoint docs + public video list                               |
| `/oembed?url=...` | oEmbed JSON                                 | Called by Notion, Slack, WordPress etc to get iframe embed code |

### 3. Global redirects

| Route        | Target             | Type                                                            |
| ------------ | ------------------ | --------------------------------------------------------------- |
| `/`          | `https://danny.is` | 302 (HTML body has feed/llms.txt hints for curl/AI agents)      |
| `/rss`       | `/feed.xml`        | 301                                                             |
| `/v/:slug`   | `/:slug`           | 301 (back-compat                                              ) |
| `/v/:slug/*` | `/:slug/*`         | 301 (same)                                                      |

### 4. Video routes — HTML pages

These return HTML that loads the Vidstack player. The player then fetches actual video bytes from the media routes below. Renamed slugs 301-redirect to the canonical slug via the `slug_redirects` table.

| Route          | What it returns                                       | Cache                                                         |
| -------------- | ----------------------------------------------------- | ------------------------------------------------------------- |
| `/:slug`       | Full video page (player + title + metadata + OG tags) | `public, max-age=60, s-w-r=300` (or `private` for non-public) |
| `/:slug/embed` | Chromeless player for iframe embeds                   | Same as above                                                 |

### 5. Video routes — media files

These serve actual binary content (video, images, subtitles). Edge-caching these has the highest value — they're the heavy bytes, and serving them close to the viewer matters most for playback quality.

**Video files** (the heaviest content — benefits most from edge caching):

| Route                       | What it serves                    | Cache                                   |
| --------------------------- | --------------------------------- | --------------------------------------- |
| `/:slug/raw/source.mp4`     | Source MP4 derivative             | `immutable` (1yr)                       |
| `/:slug/raw/{N}p.mp4`       | Resolution variants (720p, 1080p) | `immutable` (1yr)                       |
| `/:slug/stream/stream.m3u8` | HLS playlist                      | `max-age=60` (changes during recording) |
| `/:slug/stream/init.mp4`    | HLS init segment                  | `immutable` (1yr)                       |
| `/:slug/stream/seg_NNN.m4s` | HLS media segments                | `immutable` (1yr)                       |

All video routes support HTTP Range requests (`206 Partial Content`).

**Images and subtitles** (lighter, but still benefits from edge proximity):

| Route                   | What it serves                            | Cache             |
| ----------------------- | ----------------------------------------- | ----------------- |
| `/:slug/poster.jpg`     | Video thumbnail                           | `immutable` (1yr) |
| `/:slug/storyboard.jpg` | Sprite sheet for scrubber hover previews  | `immutable` (1yr) |
| `/:slug/storyboard.vtt` | WebVTT time→sprite mapping for storyboard | `immutable` (1yr) |
| `/:slug/captions.srt`   | SRT subtitles                             | `max-age=3600`    |
| `/:slug/captions.vtt`   | VTT subtitles (or SRT→VTT on-the-fly)     | `max-age=3600`    |

### 6. Video routes — metadata (no binary media)

These return structured text — lightweight, easy to cache.

| Route         | What it returns                                    | Notes                        |
| ------------- | -------------------------------------------------- | ---------------------------- |
| `/:slug.json` | JSON metadata (includes transcript, absolute URLs) | Programmatic/LLM consumption |
| `/:slug.md`   | Markdown metadata (includes transcript)            | Same audience                |
| `/:slug.mp4`  | 302 redirect to `/:slug/raw/source.mp4`            | Convenience "download" URL   |

## Current Serving Setup

The origin server is a single Hetzner VPS in Frankfurt. Everything below describes what's already in place before any edge layer work.

### Player & quality selection

The Vidstack player on `/:slug` and `/:slug/embed` renders multiple `<source>` elements when MP4 derivatives exist (source, 1080p, 720p), giving viewers a Quality menu. When source is >1080p, the 1080p variant is listed first so browsers default to it. When source is ≤1080p, it leads. The 720p option is always available for viewers on slow connections. During recording or the healing window (derivatives not yet generated), a single HLS playlist URL is used as fallback.

### Preloading & buffering

- `preload="auto"` and `load="eager"` on the player — the browser starts buffering immediately on page load rather than waiting for an IntersectionObserver tick + play click.
- `<link rel="modulepreload">` for the Vidstack JS module from `cdn.vidstack.io`.
- `<link rel="preload" as="video">` for the default source URL — kicks off the video request during HTML parse, in parallel with Vidstack JS loading.

### Caching (origin headers)

- MP4 derivatives and HLS segments: `Cache-Control: public, max-age=31536000, immutable` — these are written once and never mutated.
- HLS playlists: `max-age=60` — the playlist can change during a live recording, or later if healing occurs.
- Poster, storyboard images/VTT: `immutable`.
- Captions (SRT/VTT): `max-age=3600` — may be re-uploaded.
- HTML pages (`/:slug`, `/:slug/embed`): `public, max-age=60, stale-while-revalidate=300` (or `private` for non-public videos).
- HTTP/2 + HTTP/3 (`alt-svc: h3=":443"`) are enabled.
- MP4 derivatives are encoded with `+faststart` (moov atom at front).
- Range requests work on all media routes.
