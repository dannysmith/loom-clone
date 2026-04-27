# Task 1 — Public RSS Feed, llms.txt & JSON Feed

Add public feed endpoints to `v.danny.is` for discovery by feed readers, AI agents, and programmatic consumers. Also clean up the root route and extract hardcoded site metadata into a central config.

## Decisions

- **RSS**: Canonical path `/feed.xml`, with `/rss` redirecting to it. RSS 2.0 + Media RSS namespace (`xmlns:media`). Include both `<enclosure>` (for basic readers) and `<media:content>` (for richer clients with duration, dimensions, thumbnail). Link to `source.mp4` for enclosures.
- **JSON Feed**: `/feed.json` served as `application/feed+json`. JSON Feed 1.1 spec. Include an `info_for_llms` top-level key with a plain-English explanation of the endpoint and pointer to `/llms.txt`. Truncate transcripts to ~200 words. Include per-video `_urls` map (page, embed, json, md, raw).
- **llms.txt**: Dynamic, generated from public video list. Structure: H1 + blockquote intro, "How to Use This Site" section (endpoint docs — goes before video list so `curl | head` always sees it), bulleted video list (title, duration, description if present, newest first, slug as fallback title), "Links" section at bottom (RSS, JSON feed, sitemap, author website).
- **Root route**: Replace current HTML landing page with a 302 temporary redirect to `https://danny.is`. The 302 response includes an HTML body with hints pointing curl/AI agents to `/llms.txt`, `/feed.xml`, `/feed.json`, `/sitemap.xml`. Browsers follow the redirect instantly and never render the body; `curl` (without `-L`) displays it. Add `Link` header for RSS discovery.
- **Site config**: New `server/src/lib/site-config.ts` with centralised metadata (site name, tagline, author name/URL, default OG/oEmbed dimensions). Replace hardcoded values in oEmbed, viewer meta tags, JSON-LD, and attribution links. Leave admin-only strings (brand, title suffix) hardcoded — they're UI concerns on a private surface.
- **"loom-clone" in public endpoints**: Only appears in oEmbed `provider_name` (fixed via site config) and the root route (replaced by redirect). Auth realm stays as-is.
- **Query**: Same as sitemap — `visibility === "public" && status === "complete" && trashedAt === null`, ordered by `createdAt DESC`.

## Phases

### Phase 1 — Site Config + RSS Feed

1. Create `server/src/lib/site-config.ts` with centralised site metadata.
2. Update existing code to use site config: oEmbed (`provider_name`, `author_name`), VideoPage (JSON-LD author, meta author, attribution link), EmbedPage (meta author).
3. Add `/feed.xml` route in the site module — RSS 2.0 + MRSS, public complete non-trashed videos.
4. Add `/rss` → `/feed.xml` 301 redirect.
5. Update/add tests for all of the above.

### Phase 2 — llms.txt & JSON Feed

1. Add `/llms.txt` endpoint — dynamically generated markdown listing all public videos with endpoint documentation.
2. Add `/feed.json` endpoint — JSON Feed 1.1 with `info_for_llms` key, truncated transcripts, per-video URL maps, media attachments.
3. Add `<link rel="alternate">` discovery tags to viewer page `<head>` for both feeds.
4. Tests for both endpoints.

### Phase 3 — Root Route Cleanup

1. Replace `GET /` with 302 redirect to `https://danny.is`. Include HTML body with feed/llms.txt hints for non-browser clients. Add `Link` header for RSS autodiscovery.
2. Update robots.txt to add feed paths as `Allow` hints (optional, minor).
3. Update existing root route test.
