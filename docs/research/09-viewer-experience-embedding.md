# Viewer Experience: Delivery, Embedding & Link Previews

*Research date: 2026-03-30*

The viewer experience is the product for everyone except the person recording. When someone receives a `v.danny.is` link, it needs to work well across every context: clicking in a browser, seeing a preview in Slack, embedding in Notion, sharing on social media. This document covers the architecture, player choice, meta tags, oEmbed, platform-specific behavior, embedding, CDN independence, and Slack app architecture needed to deliver that experience.

For full project context, see `requirements.md`. For prior research, see `04-video-hosting-build-vs-buy.md` (Mux decision), `05-competitive-landscape.md` (UX patterns), `10-open-source-video-platforms.md` (player recommendation), and `video-hosting-research.md` (platform behavior).

---

## 1. Video Page Architecture

### The Requirement

Video pages at `v.danny.is/{slug}` must:

- Load fast (CDN-backed, edge-close to viewer)
- Work when the backend server is down
- Have correct OG/Twitter meta tags for link previews
- Include the oEmbed discovery tag
- Render the video player with the correct Mux playback ID
- Show title, description, and transcript (if available)

### Three Options

**Option A: Static HTML generation (deploy to CDN alongside video)**

When a video is created or its metadata changes, generate a static HTML file and push it to R2/CDN. The page contains all the meta tags, player embed, title, and description baked in. No server needed at view time.

- Pros: True CDN independence. Survives any backend outage. Fastest possible TTFB.
- Cons: Every metadata edit requires regenerating and re-deploying the HTML. Dynamic elements (transcript, view count) require client-side fetching. Slug changes require updating both the file and redirect rules.

**Option B: Cloudflare Workers (edge-rendered)**

A Cloudflare Worker intercepts requests to `v.danny.is/{slug}`, fetches video metadata from a KV store (populated by the backend), and renders the HTML at the edge. The Worker runs on Cloudflare's network, not on our server.

- Pros: Dynamic rendering without backend dependency. KV store is globally distributed and fast. Easy to handle slug redirects. Can serve different content for embed vs. page requests.
- Cons: Adds Cloudflare Workers as a dependency. KV has eventual consistency (writes propagate in ~60 seconds). More moving parts than static files.

**Option C: Server-rendered with aggressive CDN caching**

The backend renders the video page and sets long cache headers. Cloudflare caches the response. Subsequent viewers get the cached version. Cache is purged on metadata updates.

- Pros: Simplest implementation. Standard server-side rendering.
- Cons: First viewer after cache miss hits the backend. If the backend is down and cache expires, pages break. Does not satisfy the "works when backend is down" requirement without careful cache-control (stale-while-revalidate, stale-if-error).

### Recommendation: Cloudflare Workers (Option B)

Cloudflare Workers is the right balance. Here is the reasoning:

1. **Backend independence**: The Worker reads from KV, not from our server. If the backend is down, previously published videos continue to work. New videos won't appear until KV is populated, but that's acceptable -- the backend needs to be up for recording anyway.

2. **Dynamic without a server**: The Worker can render different responses for different contexts (full page vs. embed, with or without transcript), handle slug redirects from KV, and serve correct meta tags -- all without hitting our backend.

3. **Fast globally**: Workers run in 300+ Cloudflare PoPs. Sub-50ms TTFB worldwide.

4. **Metadata updates propagate quickly**: When the backend updates a video's title, slug, or description, it writes to KV. The Worker picks up changes within ~60 seconds. For a personal tool, this latency is invisible.

5. **Slug redirects are trivial**: Store old-slug-to-new-slug mappings in KV. The Worker handles 301 redirects without touching the backend.

6. **Embed detection**: The Worker can check the request path (`/embed/{slug}` vs. `/{slug}`) or headers (`Sec-Fetch-Dest: iframe`) to serve the appropriate response.

### Architecture

```
Backend Server (manages metadata, receives recordings)
    |
    |-- On video create/update: write metadata to Cloudflare KV
    |   (slug, title, description, mux_playback_id, thumbnail_url,
    |    visibility, transcript_url, old_slugs[], duration, created_at)
    |
    v
Cloudflare KV (global key-value store)
    |
    |-- Read by Cloudflare Worker on every request
    v
Cloudflare Worker (renders HTML at the edge)
    |
    |-- v.danny.is/{slug}       -> Full video page HTML
    |-- v.danny.is/embed/{slug} -> Embed-only player HTML
    |-- v.danny.is/oembed       -> oEmbed JSON endpoint
    |-- Old slug                -> 301 redirect to current slug
```

### KV Data Model

Each video is stored in KV with the slug as the key:

```json
{
  "id": "abc123",
  "slug": "welcome-to-the-team",
  "title": "Welcome to the Team",
  "description": "A quick intro for new team members.",
  "mux_playback_id": "DS00Spx1CV902MCtPj5WknGlR102V5HFkDe",
  "thumbnail_url": "https://image.mux.com/DS00Spx1CV902MCtPj5WknGlR102V5HFkDe/thumbnail.jpg",
  "duration": 183,
  "visibility": "unlisted",
  "transcript_url": "https://v.danny.is/api/transcript/abc123",
  "created_at": "2026-03-30T14:22:00Z",
  "mp4_url": "https://stream.mux.com/DS00Spx1CV902MCtPj5WknGlR102V5HFkDe/low.mp4"
}
```

Additional KV entries for slug redirects: key = old slug, value = `{"redirect": "welcome-to-the-team"}`.

An index key (`_index`) can store the list of all public video slugs for a potential sitemap endpoint, but this is optional.

---

## 2. Player Recommendation

### The Decision: Vidstack (not Mux Player)

Prior research in `10-open-source-video-platforms.md` already recommended Vidstack. After investigating Mux Player (`<mux-player>`) more closely, Vidstack remains the right choice. Here is why.

**Mux Player (`<mux-player>`)**:
- Web component that takes a `playback-id` attribute and handles everything
- Tightly coupled to Mux's infrastructure -- designed around Mux playback IDs, not generic HLS URLs
- Includes Mux Data analytics automatically
- Limited documentation on using it with non-Mux sources
- Good default UI with theming support
- If we ever migrate away from Mux (to self-hosted R2, per the fallback plan in `04-video-hosting-build-vs-buy.md`), we would need to replace the player entirely

**Vidstack**:
- Framework-agnostic, supports React, Web Components, and others
- Works with any HLS source -- point it at a Mux HLS URL today, an R2-hosted HLS URL tomorrow
- Built-in HLS support via hls.js, with quality selector, speed controls, captions, keyboard shortcuts
- ~54kB gzipped (vs. ~195kB for Video.js)
- Excellent customization: 150+ CSS variables for the default layout, or build fully custom UI with headless components
- Sponsored by Mux, built for Reddit at scale
- MIT licensed
- Active development

**The coupling argument is decisive.** Our architecture in `04-video-hosting-build-vs-buy.md` explicitly plans for migration from Mux to self-hosted R2 as a fallback. Using Mux Player would make that migration harder -- we would need to swap the entire player component. Vidstack works with Mux today (just point it at `https://stream.mux.com/{playback_id}.m3u8`) and with any other HLS source tomorrow. Zero lock-in.

### Vidstack Configuration for Our Use Case

```html
<media-player
  src="https://stream.mux.com/{PLAYBACK_ID}.m3u8"
  poster="https://image.mux.com/{PLAYBACK_ID}/thumbnail.jpg?time=2"
  title="Welcome to the Team"
  crossorigin
  playsinline
>
  <media-provider>
    <media-poster alt="Welcome to the Team"></media-poster>
  </media-provider>
  <media-video-layout></media-video-layout>
</media-player>
```

Key configuration:
- `playsinline`: Prevents fullscreen on mobile (important for embed context)
- `crossorigin`: Required for HLS from Mux's domain
- `poster`: Mux's thumbnail API with `?time=2` to skip the first 2 seconds (avoids blank frames)
- Default layout provides quality selector, speed controls, fullscreen, PiP, keyboard shortcuts

---

## 3. Open Graph and Twitter Card Meta Tags

### The Complete Meta Tag Set

This is the exact set of tags the Cloudflare Worker should render in the `<head>` of every video page. Values shown are examples for `v.danny.is/welcome-to-the-team`.

```html
<head>
  <!-- Basic page metadata -->
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Welcome to the Team - v.danny.is</title>
  <meta name="description" content="A quick intro for new team members.">

  <!-- Open Graph (primary mechanism for most platforms) -->
  <meta property="og:type" content="video.other">
  <meta property="og:title" content="Welcome to the Team">
  <meta property="og:description" content="A quick intro for new team members.">
  <meta property="og:url" content="https://v.danny.is/welcome-to-the-team">
  <meta property="og:site_name" content="v.danny.is">
  <meta property="og:image" content="https://image.mux.com/DS00Spx1CV902MCtPj5WknGlR102V5HFkDe/thumbnail.jpg?width=1200&height=630&fit_mode=smartcrop">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:type" content="image/jpeg">
  <meta property="og:video" content="https://stream.mux.com/DS00Spx1CV902MCtPj5WknGlR102V5HFkDe/low.mp4">
  <meta property="og:video:type" content="video/mp4">
  <meta property="og:video:width" content="1920">
  <meta property="og:video:height" content="1080">

  <!-- Twitter/X Card -->
  <meta name="twitter:card" content="player">
  <meta name="twitter:title" content="Welcome to the Team">
  <meta name="twitter:description" content="A quick intro for new team members.">
  <meta name="twitter:image" content="https://image.mux.com/DS00Spx1CV902MCtPj5WknGlR102V5HFkDe/thumbnail.jpg?width=1200&height=630&fit_mode=smartcrop">
  <meta name="twitter:player" content="https://v.danny.is/embed/welcome-to-the-team">
  <meta name="twitter:player:width" content="1920">
  <meta name="twitter:player:height" content="1080">

  <!-- oEmbed Discovery -->
  <link rel="alternate" type="application/json+oembed"
        href="https://v.danny.is/oembed?url=https%3A%2F%2Fv.danny.is%2Fwelcome-to-the-team"
        title="Welcome to the Team">

  <!-- Visibility control -->
  <!-- For unlisted videos: -->
  <meta name="robots" content="noindex, nofollow">
  <!-- For public videos, omit the above or use: -->
  <!-- <meta name="robots" content="index, follow"> -->

  <!-- Canonical URL -->
  <link rel="canonical" href="https://v.danny.is/welcome-to-the-team">
</head>
```

### Tag-by-Tag Reasoning

**`og:type = "video.other"`**: The Open Graph video type. `video.other` is correct for a standalone video page (as opposed to `video.movie` or `video.episode`).

**`og:image` dimensions (1200x630)**: This is the ratio that renders best across the most platforms. Slack, LinkedIn, Facebook, and Twitter all prefer roughly this size. Mux's thumbnail API supports `width`, `height`, and `fit_mode` parameters, so we request a 1200x630 smart-cropped version for OG, separate from the poster image used on the page itself.

**`og:video` pointing to direct MP4**: This is critical for platforms that support inline video playback from OG tags. Mux provides a low-quality MP4 rendition at `https://stream.mux.com/{PLAYBACK_ID}/low.mp4`. This should be a relatively small file suitable for preview playback. Note: Discord disabled inline OG video playback in May 2025, so this primarily benefits iMessage and any future platforms that support it.

**`twitter:card = "player"`**: The Twitter/X Player Card type. This enables an embedded player in Twitter timelines. Requires approval from X -- see Section 6 below.

**`twitter:player` pointing to embed URL**: Twitter loads this URL in an iframe. Points to our embed endpoint, which serves just the Vidstack player with no page chrome.

**`twitter:image`**: Twitter uses this as the preview image before the user taps play. Same dimensions as `og:image`.

**Robots tag**: Unlisted videos get `noindex, nofollow`. Public videos get `index, follow` (or omit the tag entirely). Private videos are not served by the Worker at all -- it returns a 404.

---

## 4. oEmbed Implementation

### Specification

oEmbed is a protocol (defined at oembed.com) that lets a consumer (Slack, Notion, WordPress, etc.) fetch an embeddable representation of a URL from a provider (us). The flow:

1. Consumer fetches our video page and finds the `<link rel="alternate" type="application/json+oembed">` discovery tag in the HTML head.
2. Consumer requests our oEmbed endpoint with the video URL.
3. We return JSON describing how to embed the video.
4. Consumer renders the iframe or displays the thumbnail.

### Endpoint

**URL**: `https://v.danny.is/oembed`

**Parameters**:
- `url` (required): The video page URL (e.g., `https://v.danny.is/welcome-to-the-team`)
- `maxwidth` (optional): Maximum width for the embed
- `maxheight` (optional): Maximum height for the embed
- `format` (optional): `json` (default) or `xml`

### Response Format

```json
{
  "version": "1.0",
  "type": "video",
  "title": "Welcome to the Team",
  "author_name": "Danny",
  "author_url": "https://danny.is",
  "provider_name": "v.danny.is",
  "provider_url": "https://v.danny.is",
  "thumbnail_url": "https://image.mux.com/DS00Spx1CV902MCtPj5WknGlR102V5HFkDe/thumbnail.jpg?width=1280&height=720",
  "thumbnail_width": 1280,
  "thumbnail_height": 720,
  "html": "<iframe src=\"https://v.danny.is/embed/welcome-to-the-team\" width=\"640\" height=\"360\" frameborder=\"0\" allow=\"autoplay; fullscreen; picture-in-picture\" allowfullscreen></iframe>",
  "width": 640,
  "height": 360
}
```

### Implementation

The oEmbed endpoint runs inside the same Cloudflare Worker. The flow:

1. Parse the `url` parameter to extract the slug.
2. Look up the video metadata in KV.
3. If not found, return HTTP 404.
4. If the video is private, return HTTP 401.
5. Calculate dimensions respecting `maxwidth`/`maxheight` while maintaining 16:9 aspect ratio.
6. Return the JSON response with appropriate `Content-Type: application/json` header.

### Discovery Tag

Already included in the meta tags above. The `href` must be the full URL to the oEmbed endpoint with the `url` parameter URL-encoded:

```html
<link rel="alternate" type="application/json+oembed"
      href="https://v.danny.is/oembed?url=https%3A%2F%2Fv.danny.is%2Fwelcome-to-the-team"
      title="Welcome to the Team">
```

### Getting Listed with Providers

**oembed.com providers list**: Submit a PR to the oembed.com providers JSON. This makes us discoverable by platforms that consult the central registry, but most modern consumers use the `<link>` discovery tag instead.

**Iframely**: Iframely powers embedding for Notion and many other platforms. They support over 1,900 domains. Getting listed involves contacting them through their QA system. The key requirements are: implement a working oEmbed endpoint with the discovery `<link>` tag, have valid OG tags, and have the embed URL return a properly functioning iframe player. Once Iframely adds us, Notion auto-embed will work.

**Embedly**: Similar to Iframely. Embedly is owned by Medium and powers embedding for many platforms. They have a provider submission form at embed.ly/providers/new.

---

## 5. Platform-by-Platform Preview Behavior

### Slack

**Default behavior (no Slack app)**: Slack discovers links and renders previews using a priority chain: oEmbed > Twitter Cards > Open Graph > HTML meta. For our domain, Slack will:

- Fetch the video page
- Find the oEmbed discovery tag
- Request our oEmbed endpoint
- Render a **rich link preview card**: thumbnail image, title, description, provider name
- **No inline video player** -- Slack whitelists a handful of domains (YouTube, Vimeo, Loom) for inline video. Our domain will not be whitelisted.
- Clicking the preview opens the video page in a browser

**With a Slack app (see Section 8)**: We can build a Slack app that intercepts `link_shared` events for `v.danny.is` and responds with a custom unfurl containing a Video Block. This gives us an inline video player in Slack. The Video Block requires `links.embed:write` scope, and the `video_url` must point to our embed URL (`v.danny.is/embed/{slug}`), which must be registered as an unfurl domain in the app.

**Recommendation**: Start without the Slack app. The OG-tag-based preview (thumbnail + title + description) is good enough for launch. Build the Slack app later as a quality-of-life improvement -- it is the only way to get inline video playback in Slack for a custom domain.

### Discord

**Current behavior (post-May 2025)**: Discord disabled support for inline video playback from OG video embeds in May 2025. This means:

- Discord reads our OG tags (`og:title`, `og:description`, `og:image`)
- Renders a **rich link preview card**: thumbnail, title, description
- **No inline video player** -- even with a valid `og:video` pointing to a direct MP4
- Clicking the preview opens the video page in a browser
- Discord does NOT use oEmbed for arbitrary domains

**What we get**: A clean thumbnail card. This is the same experience as sharing a Loom link in Discord now (post-May 2025). Adequate for our needs.

### Notion

**Default behavior**: Notion uses Iframely to power its embed system. For unknown domains:

- Pasting a URL renders a **bookmark** (link preview with title, description, thumbnail)
- Users can use `/embed` and paste the URL to manually embed via iframe
- The manual embed will work if `v.danny.is/embed/{slug}` returns a proper iframe-friendly page

**After Iframely listing**: Once our domain is added to Iframely's provider database (by contacting them and having a working oEmbed endpoint):

- Pasting a URL auto-creates an **inline embedded video player**
- The embed uses our oEmbed response to generate the iframe
- This matches the experience of pasting a Loom or YouTube link

**Recommendation**: Launch with manual `/embed` support (which works immediately). Pursue Iframely listing as a follow-up. The manual embed path is acceptable for personal use -- it is one extra step.

### Twitter/X

**Player Card**: Twitter supports a Player Card type that renders an embedded player in the timeline. Requirements:

- `twitter:card` = `player`
- `twitter:player` = HTTPS URL of an embeddable iframe (our embed URL)
- `twitter:player:width` and `twitter:player:height` must be specified
- All assets must be HTTPS
- The player must work without requiring sign-in
- Player Cards require **approval from X**. Submit via the Card Validator tool. Approval involves screenshots proving the player works across Twitter clients (web, iOS, Android).

**Without approval**: Twitter falls back to a **Summary Large Image** card using `og:image`, `og:title`, and `og:description`. This shows a large thumbnail with title and description.

**Recommendation**: Launch with OG tags (Summary Large Image fallback). Apply for Player Card approval after launch. The approval process is manual and can take time, but the fallback is perfectly adequate.

### iMessage / Apple Messages

**Behavior**: iMessage uses Open Graph tags for rich link previews. Key specifics:

- Only reads `og:title` and `og:image` for the preview card
- `og:image` should be at least 1200x1200 or larger for best display (150x150 minimum)
- Supports `og:video` for inline video preview -- the URL should point to a small, downloadable MP4 file in a format iOS can natively play (MPEG-4/H.264)
- If `og:video` points to a valid small MP4, iMessage may show a playable video preview
- JavaScript does NOT execute during preview generation -- all OG tags must be in the static HTML source
- The video preview aspect ratio should match the `og:image` aspect ratio

**What we get**: A rich preview card with our thumbnail and title. Potentially inline video playback if the Mux low-quality MP4 is small enough and fast enough to load. The Cloudflare Worker renders static HTML, so the "no JavaScript" requirement is satisfied by design.

### LinkedIn

**Behavior**: LinkedIn's scraper (`LinkedInBot`) reads OG tags:

- Uses `og:title` (truncated at ~70 characters), `og:description` (truncated at ~150 characters), `og:image` for the preview card
- Renders a **link preview card** with thumbnail, title, and description
- Does not support `og:video` for inline playback
- Caches link data for up to 7 days. Use LinkedIn Post Inspector to force a re-scrape.

**What we get**: A clean link preview card. Same as any other link shared on LinkedIn. Adequate.

### Google Docs

**Behavior**: Google Docs shows link previews using OG tags when hovering over a link. Users can also use Insert > Embed to embed a URL via iframe. The embed approach works with our embed URL.

**What we get**: Link hover preview with thumbnail and title. Manual embed via iframe works.

### Summary Table

| Platform | Preview Type | Inline Video? | Mechanism | Action Required |
|----------|-------------|---------------|-----------|-----------------|
| **Slack** (no app) | Thumbnail + title card | No | oEmbed > OG | None (works at launch) |
| **Slack** (with app) | Video Block player | Yes | link_shared + chat.unfurl | Build Slack app |
| **Discord** | Thumbnail + title card | No (disabled May 2025) | OG tags | None |
| **Notion** (no Iframely) | Bookmark card | No (manual /embed works) | OG tags | None |
| **Notion** (with Iframely) | Inline embed player | Yes | oEmbed via Iframely | Contact Iframely |
| **Twitter/X** (no approval) | Summary Large Image | No | OG tags | None |
| **Twitter/X** (with approval) | Player Card | Yes | twitter:player | Apply for approval |
| **iMessage** | Rich preview | Maybe (if MP4 loads) | og:image + og:video | None |
| **LinkedIn** | Link card | No | OG tags | None |
| **Google Docs** | Hover preview / iframe | Via manual embed | OG tags / iframe | None |

---

## 6. Embedding Approach

### Embed URL

**`v.danny.is/embed/{slug}`** serves a minimal HTML page containing only the Vidstack player. No page chrome, no title, no description, no header/footer.

### Embed Page HTML

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 100%; height: 100%; overflow: hidden; background: #000; }
    media-player { width: 100%; height: 100%; }
  </style>
  <link rel="stylesheet" href="/assets/vidstack.css">
</head>
<body>
  <media-player
    src="https://stream.mux.com/{PLAYBACK_ID}.m3u8"
    poster="https://image.mux.com/{PLAYBACK_ID}/thumbnail.jpg"
    crossorigin
    playsinline
  >
    <media-provider></media-provider>
    <media-video-layout></media-video-layout>
  </media-player>
  <script src="/assets/vidstack.js" type="module"></script>
</body>
</html>
```

### Responsive Sizing

For consumers embedding via iframe, provide a responsive wrapper. The oEmbed response includes the iframe HTML, and our documentation should recommend this pattern:

```html
<div style="position: relative; padding-bottom: 56.25%; height: 0; overflow: hidden;">
  <iframe
    src="https://v.danny.is/embed/welcome-to-the-team"
    style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; border: 0;"
    allow="autoplay; fullscreen; picture-in-picture"
    allowfullscreen>
  </iframe>
</div>
```

The `padding-bottom: 56.25%` creates a 16:9 aspect ratio container. The iframe fills it completely.

### Embed Detection

The Cloudflare Worker distinguishes between page and embed requests:

1. **Path-based** (primary): `/embed/{slug}` always returns the embed page. `/{slug}` always returns the full page.
2. **Header-based** (secondary, optional): If `Sec-Fetch-Dest: iframe` is present on a request to `/{slug}`, the Worker *could* redirect to `/embed/{slug}`. However, this is fragile and not recommended -- explicit URLs are more reliable.

### Vidstack Asset Hosting

Vidstack's CSS and JS files should be hosted on our own CDN (R2), not loaded from a third-party CDN like JSDelivr. This ensures the embed page works regardless of third-party CDN availability and avoids mixed-content or CORS issues. The Worker serves these from R2 at paths like `v.danny.is/assets/vidstack.js`.

---

## 7. CDN Independence Strategy

### The Requirement

From `requirements.md`: "If my server is down for maintenance, restarting, or otherwise unavailable, previously published videos must still be watchable."

### How the Architecture Achieves This

The architecture has three independently available layers:

1. **Cloudflare Worker + KV**: Renders video pages. Runs on Cloudflare's edge network. Does not depend on our backend server. As long as KV contains the video metadata, pages render correctly. KV data persists indefinitely -- it does not expire when the backend goes down.

2. **Mux CDN**: Serves HLS streams and thumbnails. Completely independent of our server. Mux's multi-CDN infrastructure has its own availability guarantees.

3. **R2 (backup storage)**: Contains local copies of all videos. If Mux were to go down, we could point the player at R2-hosted HLS (a manual migration, but the data is there).

**The backend server is only needed for**:
- Creating new video records (writing to KV)
- Updating metadata (writing to KV)
- Admin operations (managing the video library)
- Receiving new recordings from the desktop app

**The backend server is NOT needed for**:
- Viewing a video
- Rendering a video page
- Serving link previews / OG tags
- oEmbed responses
- Embed pages

### Failure Scenarios

| What's down | Impact on viewers | Impact on recording |
|-------------|-------------------|---------------------|
| Backend server | Zero. Pages and videos continue working. | Cannot record or manage videos. |
| Cloudflare Workers | Video pages don't render. Videos are still on Mux CDN but there is no HTML page. | No impact on recording. |
| Mux CDN | Video pages render but player cannot load HLS stream. Thumbnail may also fail. | Cannot stream-upload recordings. |
| Cloudflare KV | Worker cannot read metadata to render pages. | No direct impact. |

The most likely failure (backend server restart/maintenance) has zero viewer impact. Cloudflare and Mux outages are possible but rare and outside our control.

### KV Population

The backend writes to KV via Cloudflare's API whenever:
- A new video is created (after Mux live stream converts to VOD asset)
- Video metadata is updated (title, slug, description, visibility)
- A video is deleted (KV entry removed)
- A slug is changed (new KV entry created, old slug entry becomes a redirect)

The write is a simple HTTP PUT to Cloudflare's KV API. This should be fire-and-forget with retry on failure -- not blocking the user's admin action.

---

## 8. Slack App Architecture for Rich Unfurls

### Is It Worth Building?

The Slack app is the only way to get inline video playback in Slack for a custom domain. Without it, Slack users see a thumbnail card and must click through to the browser. Given the requirements ("Quick Slack replacements" is the first use case listed), this is a meaningful quality-of-life improvement.

However, it is not critical for launch. The thumbnail preview with a good OG image is adequate. The Slack app is a Phase 2 enhancement.

### How It Works

1. **User pastes** `v.danny.is/welcome-to-the-team` in a Slack message.
2. **Slack dispatches** a `link_shared` event to our Slack app's webhook (our backend server).
3. **Our backend** extracts the slug from the URL, looks up the video metadata.
4. **Our backend calls** `chat.unfurl` with a Video Block pointing to our embed URL.
5. **Slack renders** an inline video player in the message.

### Required Scopes

- `links:read` -- Read links posted in Slack
- `links:write` -- Post custom unfurls
- `links.embed:write` -- Required specifically for Video Block unfurls

### Domain Registration

In the Slack app configuration, register `v.danny.is` as an unfurl domain. Up to 5 domains can be registered per app.

### Video Block Payload

```json
{
  "type": "video",
  "title": {
    "type": "plain_text",
    "text": "Welcome to the Team"
  },
  "title_url": "https://v.danny.is/welcome-to-the-team",
  "description": {
    "type": "plain_text",
    "text": "A quick intro for new team members."
  },
  "video_url": "https://v.danny.is/embed/welcome-to-the-team",
  "thumbnail_url": "https://image.mux.com/DS00Spx1CV902MCtPj5WknGlR102V5HFkDe/thumbnail.jpg",
  "alt_text": "Welcome to the Team video",
  "author_name": "Danny",
  "provider_name": "v.danny.is",
  "provider_icon_url": "https://v.danny.is/favicon.ico"
}
```

### Key Constraints

- `video_url` must be HTTPS and return an embeddable iframe page
- `video_url` must be on a domain registered as an unfurl domain in the app
- The embed page must return HTTP 2xx (or 3xx with fewer than 5 redirects to a 2xx)
- Title is limited to 200 characters
- Description is limited to 200 characters
- Video Blocks can only be posted by apps, not users directly

### Architecture

```
Slack User posts v.danny.is link
    |
    v
Slack dispatches link_shared event (webhook)
    |
    v
Our Backend Server
    |-- Receives webhook at /api/slack/events
    |-- Extracts slug from URL
    |-- Looks up video metadata in database
    |-- Calls Slack chat.unfurl API with Video Block
    |
    v
Slack renders inline video player
    |-- Loads iframe from v.danny.is/embed/{slug}
    |-- Cloudflare Worker serves embed page
    |-- Vidstack player loads HLS from Mux
```

### Dependency Note

The Slack app's `link_shared` webhook hits our backend server. If the server is down, the webhook fails and Slack falls back to its default unfurling behavior (thumbnail card from OG tags, via the Cloudflare Worker). This is a graceful degradation -- viewers still get a preview, just not an inline player.

### Implementation Effort

The Slack app is a small piece of work:
- Register a Slack app at api.slack.com
- Add the 3 scopes and register `v.danny.is` as an unfurl domain
- Implement a single webhook endpoint (`/api/slack/events`) that handles `link_shared` events
- Call `chat.unfurl` with the Video Block payload
- Total: one webhook endpoint, one API call, one Block Kit payload

The main overhead is distribution: each Slack workspace that wants rich unfurls must install the app. For personal use (my own workspace), this is trivial. For sharing with others' workspaces, the app would need to be distributed (possibly via Slack App Directory, which requires a review process).

---

## 9. Performance Optimization

### Fast HLS Start

The primary factor in perceived video load time is how quickly the first frame appears. Key optimizations:

**Short initial segments**: Mux automatically handles this. Their HLS implementation uses shorter initial segments to enable fast start. No configuration needed on our side.

**Preload hints (LL-HLS)**: Low-Latency HLS uses `#EXT-X-PRELOAD-HINT` tags to tell the player to prefetch the next segment before the playlist updates. Mux supports LL-HLS. For VOD content (which is our primary use case), this is less relevant than for live streaming, but it still helps with smooth playback.

**Player preload**: Vidstack supports `preload="metadata"` and `preload="auto"` attributes. For the video page, use `preload="metadata"` to fetch the HLS manifest and first segment headers without downloading video data. This means the player knows the video's duration, resolution, and available qualities before the user hits play.

**Poster image**: Always provide a poster (thumbnail) image. This gives the user something to see immediately while the player initializes. Mux's thumbnail API serves these from CDN with no additional setup.

**DNS prefetch and preconnect**: In the video page `<head>`, add hints for the domains the player will connect to:

```html
<link rel="preconnect" href="https://stream.mux.com" crossorigin>
<link rel="preconnect" href="https://image.mux.com" crossorigin>
<link rel="dns-prefetch" href="https://stream.mux.com">
```

### Adaptive Bitrate Switching

Mux handles this automatically. All videos get multiple HLS renditions (typically 360p, 540p, 720p, 1080p). The player (via hls.js in Vidstack) starts with a rendition appropriate for the viewer's bandwidth and switches up as conditions allow. No configuration needed.

### Video Page Load Performance

The Cloudflare Worker should render a minimal, fast-loading page:

- Inline critical CSS (player styling) in the `<head>` to avoid render-blocking requests
- Load Vidstack JS as a module with `async` or `defer`
- Keep the HTML payload small (under 20kB for the full page)
- Vidstack assets served from R2 via Cloudflare CDN (same edge network as the Worker)
- No heavy frameworks -- the video page is vanilla HTML rendered by the Worker, with Vidstack handling the player

The video page should not load React, Next.js, or any SPA framework. It is a static HTML page with a Vidstack player. The Cloudflare Worker generates this HTML on each request (or from cache).

---

## 10. Implementation Priority

### Phase 1 (Launch)

1. **Cloudflare Worker** that reads from KV and renders video pages with correct OG tags, Twitter tags, and oEmbed discovery.
2. **oEmbed endpoint** in the same Worker.
3. **Embed page** at `/embed/{slug}` with Vidstack player.
4. **Vidstack player** on both the full page and embed page, pointing to Mux HLS URLs.
5. **Backend writes to KV** on video create/update/delete.
6. **Slug redirect handling** via KV.

This gives us: working video pages, good link previews everywhere, manual embed support, and full CDN independence.

### Phase 2 (After launch, when Slack friction becomes noticeable)

7. **Slack app** with `link_shared` webhook and Video Block unfurl.
8. **Iframely listing** -- contact Iframely to get `v.danny.is` added as a provider for Notion auto-embed.
9. **Twitter/X Player Card approval** -- apply via Card Validator.
10. **Embedly listing** for broader platform coverage.

### Phase 3 (Future)

11. **Transcript display** on the video page (client-side fetch from backend API, with graceful degradation if backend is down).
12. **View counter** (client-side increment via lightweight API, non-blocking, non-critical).
13. **Sitemap generation** for public videos (from KV index).

---

## Sources

- [oEmbed Specification](https://oembed.com/)
- [Open Graph Protocol](https://ogp.me/)
- [Slack Video Block Reference](https://docs.slack.dev/reference/block-kit/blocks/video-block/)
- [Slack Unfurling Links Documentation](https://docs.slack.dev/messaging/unfurling-links-in-messages/)
- [Slack link_shared Event](https://api.slack.com/events/link_shared)
- [Slack chat.unfurl Method](https://docs.slack.dev/reference/methods/chat.unfurl/)
- [X/Twitter Player Card](https://developer.x.com/en/docs/x-for-websites/cards/overview/player-card)
- [X/Twitter Player Card Approval](https://developer.twitter.com/en/docs/twitter-for-websites/cards/guides/player-card-approval)
- [Apple TN3156: Create Rich Previews for Messages](https://developer.apple.com/documentation/technotes/tn3156-create-rich-previews-for-messages)
- [Discord Embed Changes (May 2025)](https://discord.nfp.is/)
- [Iframely Providers](https://iframely.com/docs/providers)
- [Iframely Domains](https://iframely.com/domains)
- [Embedly Provider Submission](https://embed.ly/providers/new)
- [Notion Embeds Help](https://www.notion.com/help/embed-and-connect-other-apps)
- [Vidstack Player Documentation](https://vidstack.io/docs/)
- [Mux Player Documentation](https://www.mux.com/docs/guides/play-your-videos)
- [Cloudflare Workers Documentation](https://developers.cloudflare.com/workers/)
- [Cloudflare KV Documentation](https://developers.cloudflare.com/kv/)
- [LinkedIn Link Preview Requirements](https://share-preview.com/blog/linkedin-link-preview)
- [HLS Preload Hints (WWDC 2020)](https://developer.apple.com/videos/play/wwdc2020/10229/)
