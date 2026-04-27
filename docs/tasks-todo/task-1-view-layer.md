# Task 1: BunnyCDN Edge Layer

High-availability CDN/caching layer for serving all viewer-facing routes to users as performantly and efficiently as possible. We care about this because:

1. Better UX & speed for viewers — especially those outside Europe (Hetzner is in Falkenstein, Germany).
2. Higher availability than a single Hetzner VPS can provide.
3. Handles sudden spikes in traffic to certain videos gracefully.
4. Can continue to serve cached content if the Hetzner box is temporarily down.

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
| `/v/:slug`   | `/:slug`           | 301 (back-compat)                                               |
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
| `/:slug/captions.vtt`   | VTT subtitles (or SRT→VTT on-the-fly)    | `max-age=3600`    |

### 6. Video routes — metadata (no binary media)

These return structured text — lightweight, easy to cache.

| Route         | What it returns                                    | Notes                        |
| ------------- | -------------------------------------------------- | ---------------------------- |
| `/:slug.json` | JSON metadata (includes transcript, absolute URLs) | Programmatic/LLM consumption |
| `/:slug.md`   | Markdown metadata (includes transcript)            | Same audience                |
| `/:slug.mp4`  | 302 redirect to `/:slug/raw/source.mp4`            | Convenience "download" URL   |

## Current Serving Setup

Everything below describes what's already in place before any edge layer work.

### The Server

The server is a ~8EUR Hetzner CX33 box in Falkenstein (eu-central) with 4 VCPUs, 8GB RAM plus 80GB of local disc and 20TB of traffic out allowance. It has a 20GB volume attached which is used to store all the video data and will likely be expanded in size over time. The server runs multiple services in Docker containers with Caddy as reverse proxy. See [here](https://github.com/dannysmith/danny-vps-infra/blob/main/README.md) for more on that setup.

### The Hono App

The Loom Clone backend is running on the server as a Hono App and generally serves three "parts":

1. The `/api/*` which is used by the macOS client (mainly for creating recordings)
2. The `/admin/` web app and its associated API which is used for managing videos.
3. The public viewer-facing endpoints, which is what we care about here.

### DNS

DNS for `danny.is` is managed by **DNSimple**. Current A records pointing at the Hetzner server:

- `v.danny.is` — Caddy proxies to the LoomClone container
- `server.danny.is` — Caddy returns a simple 200 (used for SSH convenience)

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

## Research Findings (April 2026)

### CDN Options Evaluated

**Cloudflare free CDN:** Cannot legally serve video from an external origin. Their service-specific terms require non-Enterprise customers to use a Cloudflare service (Stream, R2, or Images) for video delivery. They actively enforce this. Non-video content (HTML, feeds, CSS) is fine on the free CDN, but that's not where the value is.

**Cloudflare R2 + Workers:** Viable architecture (store videos in R2, route via Workers, zero egress). But requires either subdomain delegation of `v.danny.is` to Cloudflare nameservers or a Business plan for CNAME setup. Adds complexity: sync pipeline to upload videos to R2, Workers for routing logic, separate infrastructure to manage. R2 itself is explored further in the separate object storage task.

**AWS CloudFront:** Generous permanent free tier (1TB/month egress). But AWS setup is complex (distributions, behaviors, ACM certs, IAM) and disproportionate to a personal project. Ruled out.

**Hetzner:** No CDN product, no edge compute, no serverless offerings. Object Storage exists but single-region. Load balancers are single-region only. Not a path to geographic distribution.

**Fly.io / edge compute:** Bandwidth costs ($0.02/GB) are 20x Hetzner's. You'd pay more for egress than serving directly from origin. Not viable as a video CDN.

**BunnyCDN:** Best fit for this project. Affordable ($0.01/GB EU/NA), video-optimized, 119 PoPs, pull-through caching with CNAME custom domains (works directly with DNSimple, no DNS transfer needed), full Range request support, granular Edge Rules, built-in stale-cache and optional Perma-Cache for availability. Widely used by indie developers for video delivery.

### BunnyCDN — Key Details

**Pricing:** $0.01/GB in EU/NA, $0.03/GB Asia, $0.045/GB South America. Minimum $1/month. At 300GB/month egress (reasonable for ~100 video views/day), cost is ~$3/month.

**Spend control:** Prepaid credit model with billing alerts. No hard "stop at $X" cap — service stops when credit runs out. Control spend by keeping a low credit balance and limiting auto-recharge.

**"Optimize for Video Delivery":** Must be enabled. Turns on 5MB cache slicing for large files. Without it, seeking (Range requests) on uncached files breaks. Non-negotiable for this use case.

**"Serve stale while origin offline":** When Hetzner is unreachable, BunnyCDN serves expired cached content from edge nodes. Immutable video files (1yr TTL) effectively never expire. HTML pages (60s TTL) would go stale relatively quickly, but stale-while-revalidate extends this.

**Perma-Cache:** Optional secondary cache layer backed by geo-replicated Edge SSD storage (14 regions, $0.02/GB/month per region). Videos permanently stored even after edge cache eviction — survives origin outages indefinitely. Trade-off: wildcard and tag-based cache purges don't work with Perma-Cache enabled (only per-URL purge works). Deferred for now — stale-cache is sufficient initially.

**Edge Rules:** Granular URL path matching including regex. Can bypass cache for specific paths, override TTLs, change origin URL per path, set custom headers. A single pull zone can route different paths to different origins ("Change Origin URL" action). This would be useful later if object storage is added as a secondary origin for video files.

**SSL:** Auto-provisions Let's Encrypt certs when you add a custom hostname. CNAME must be live before provisioning.

**HTTP/2 + HTTP/3:** Both supported. No regression from current setup.

### Cache Invalidation

This is critical for privacy/security: when a video's visibility changes or it's trashed, cached content must be purged from BunnyCDN.

**Per-URL purge:** `POST https://api.bunny.net/purge?url=<url>`. Works always, including with Perma-Cache. Sub-second propagation globally. No SDK needed — plain HTTP with an `AccessKey` header.

**Wildcard purge:** `https://v.danny.is/<slug>/*` purges all URLs for a video in one call. Does NOT work when Perma-Cache is enabled. This is the primary reason for deferring Perma-Cache.

**Tag-based purge:** Origin sets a `CDN-Tag` response header, purge by tag. Also does not work with Perma-Cache.

**Per-video purge list:** A visibility change or trash action needs to purge: the HTML page (`/:slug`), embed page (`/:slug/embed`), all media files (source.mp4, resolution variants, poster, storyboard files, captions), metadata routes (`.json`, `.md`, `.mp4` redirect), and the oEmbed response. Without Perma-Cache, a single wildcard purge covers all of these.

**Global dynamic routes:** When any public video changes (added, renamed, trashed, visibility changed), the sitemap, feeds, and llms.txt should also be purged. These are a fixed small set of URLs.

### DNS & Routing

- `v.danny.is` gets CNAMEd to `<zone>.b-cdn.net` in DNSimple. All viewer-facing traffic flows through BunnyCDN.
- Edge Rules bypass cache for `/api/*` and `/admin/*` (proxied through BunnyCDN but not cached).
- Optionally: `api.v.danny.is` as a direct A record to Hetzner, with Caddy routing it to the LoomClone container. This keeps macOS app API traffic (especially segment uploads during recording) off the CDN entirely. The latency overhead of routing API traffic through BunnyCDN is negligible (~5-15ms), so this is a nice-to-have rather than a blocker.
- Admin traffic through BunnyCDN is fine and may even benefit from edge-cached static assets when accessing from abroad.

### Private / Non-Public Videos

Non-public videos already set `Cache-Control: private` at the origin. BunnyCDN respects origin cache headers by default, so these won't be cached at the edge. Requests pass through BunnyCDN to Hetzner, which handles access control. Worth verifying in testing.

### Live Recordings

During an active recording, HLS segments stream to Hetzner in real-time. The HLS playlist changes frequently (`max-age=60`). Through BunnyCDN, this works as-is: BunnyCDN fetches from Hetzner on cache miss, caches the playlist for 60s, and caches immutable segments indefinitely. No special handling needed.

## Decisions Taken

- **BunnyCDN** as the CDN layer. Best balance of simplicity, cost, and video delivery capabilities.
- **No Perma-Cache initially.** Stale-cache is sufficient for availability. Deferring Perma-Cache keeps purge logic simple (wildcard purge). Revisit later.
- **CloudFront ruled out.** AWS operational complexity isn't justified for a personal project.
- **Cloudflare CDN ruled out for video.** ToS prohibits video from external origin on non-Enterprise plans.
- **Object storage as separate task.** The CDN layer works with Hetzner as origin. Adding R2 or similar as a secondary origin for video files is a separate piece of work — see task-x-object-storage.md.

## Implementation Plan

### Phase 1 — BunnyCDN Setup & DNS

Set up the pull zone and cut over DNS.

- Create BunnyCDN account, add prepaid credit (low initial amount, e.g. $10)
- Create a pull zone with origin = Hetzner VPS IP (or `server.danny.is`)
- Enable "Optimize for Video Delivery" on the pull zone
- Enable "Serve stale while origin offline"
- Add `v.danny.is` as a custom hostname on the pull zone
- In DNSimple: change `v.danny.is` from A record → CNAME to `<zone>.b-cdn.net`
- BunnyCDN provisions Let's Encrypt cert (requires CNAME to be live first)
- Edge Rules:
  - Bypass cache for requests where URL path starts with `/api/`
  - Bypass cache for requests where URL path starts with `/admin/`
- Set a billing alert at a sensible threshold

### Phase 2 — Verification & Testing

Verify everything works correctly before moving on.

- Verify: video playback works end-to-end (MP4 sources, quality switching, seeking via Range requests)
- Verify: HLS fallback works for in-progress or healing recordings
- Verify: HTML pages cache with correct short TTL (check `Age` and `X-Cache` response headers)
- Verify: private/non-public videos are NOT cached (check `Cache-Control: private` is respected)
- Verify: oEmbed responses work (Slack/Notion unfurling)
- Verify: feeds, sitemap, llms.txt serve correctly
- Verify: `/admin/*` and `/api/*` bypass cache (check response headers)
- Verify: macOS app recording + upload still works through the CDN proxy
- Check BunnyCDN dashboard for cache hit ratio, bandwidth, errors
- Test from a non-EU location (VPN or similar) to confirm edge delivery is working

### Phase 3 — Cache Purge Integration

Add server-side logic to purge BunnyCDN when content changes.

- Store the BunnyCDN API key as an environment variable on the server
- Implement a `purgeCdnCache(slugOrUrls)` helper in the Hono app that calls BunnyCDN's purge API
- On video visibility change (public→private, unlisted→private, any→trashed): wildcard purge `https://v.danny.is/<slug>/*`
- On video trash/delete: same wildcard purge
- On slug rename: purge both old and new slug paths
- On any public video change (add, rename, trash, visibility): purge the global dynamic routes (`/sitemap.xml`, `/feed.xml`, `/feed.json`, `/llms.txt`)
- Consider adding `CDN-Tag` headers to video responses (e.g. `CDN-Tag: video-<slug>`) for future tag-based purging if we ever enable Perma-Cache
- Consider whether oEmbed responses need an explicit cache header (currently none set — BunnyCDN may cache based on default behavior)

### Phase 4 — API Subdomain (Optional)

Separate macOS app API traffic from CDN-proxied viewer traffic.

- Add `api.v.danny.is` A record in DNSimple → Hetzner VPS IP
- Add a Caddy site block for `api.v.danny.is` routing to the LoomClone container
- Update the macOS app's API base URL setting to use `api.v.danny.is`
- Both `v.danny.is/api/*` (through BunnyCDN) and `api.v.danny.is/api/*` (direct) can work simultaneously during transition

### Future — Perma-Cache (if needed)

If stale-cache proves insufficient for availability needs:

- Link a BunnyCDN Edge Storage zone to the pull zone
- Enable Perma-Cache (pick 2-3 regions for geo-replication)
- Switch purge logic from wildcard to per-URL purge list (enumerate all URLs for a video and purge each individually)
- Cost: ~$0.02/GB/month per region. At 50GB × 3 regions = ~$3/month
- Wildcard and tag-based purges stop working — per-URL only

### Future — Object Storage as Secondary Origin

See `task-x-object-storage.md`. If video files are moved to R2 or similar, BunnyCDN Edge Rules can route video media paths to the object storage origin instead of Hetzner. This gives origin-down resilience for video files specifically.
