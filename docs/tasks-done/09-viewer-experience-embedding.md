# Research: Viewer Experience — Delivery, Embedding & Link Previews

## Priority

Tier 2 — This is product-critical. The viewer experience IS the product for everyone except the person recording. If links don't unfurl well in Slack or embed properly in Notion, the tool fails at its primary job of sharing.

## Context

When someone receives a video URL (`v.danny.is/some-video`), the experience needs to be good across multiple contexts: clicking the link in a browser, seeing a link preview in Slack, embedding in Notion or Google Docs, sharing on social media. The video page itself must be clean, fast, and CDN-independent (works even if the backend is down). Read `requirements.md` for full project context, particularly the "Delivery Requirements" section.

## Key Questions

### Video Page Architecture

- Should video pages be **statically generated** and deployed to CDN alongside the video files? This would give us true backend independence.
- Or should they be **server-rendered** and cached at the CDN edge? (Cloudflare Workers, Vercel Edge, etc.)
- Or **server-rendered with aggressive caching** so the CDN serves them even when the backend is down?
- How do we handle the "video page works when backend is down" requirement? What's the simplest approach?
- What's the right player? HLS.js (open source, widely used), Plyr, Video.js, Shaka Player, or a managed player from a service like Mux?
- What does a great minimal video page look like? (Design inspiration — study Loom, Cap, Wistia, Vimeo player pages.)

### Link Previews & Unfurling

- **Open Graph tags**: What specific tags do we need? (`og:title`, `og:description`, `og:image`, `og:video`, `og:type`, `og:url` — what values for each?)
- **Twitter Card tags**: `twitter:card`, `twitter:player` — what's needed for a video card vs a summary card?
- How do Slack, Notion, Discord, iMessage, LinkedIn, and Twitter/X each discover and render link previews? Do they all use Open Graph, or do some have their own mechanisms?
- What **image dimensions and format** work best for thumbnails in link previews across platforms?
- Can we get **inline video playback** in Slack? (Slack whitelists specific domains — YouTube, Vimeo, Loom. What's the process for getting whitelisted? Is it realistic?)
- What does Slack actually show for a non-whitelisted domain with good OG tags? (Thumbnail + title + description?)

### oEmbed

- What is the oEmbed specification and how does it work?
- What endpoints and responses do we need to implement?
- Which platforms use oEmbed discovery? (Notion, WordPress, others?)
- What's the `<link rel="alternate" type="application/json+oembed">` discovery tag and how do we implement it?
- What does **Iframely** do, and how would we get listed? Is it worth pursuing?

### Embedding (iframe)

- What should `v.danny.is/embed/{slug}` return? (Just the player, no page chrome.)
- How do we detect when a request is coming from an iframe context vs a direct browser visit? (`Sec-Fetch-Dest` header? Referer? Or just always have the embed URL be explicit?)
- What responsive sizing approach works for embedded video players?
- How does Notion embedding work? Can users use `/embed` with our URL? What about auto-embedding?

### CDN-Independent Delivery

- How do we ensure the viewer experience works when the backend server is down?
- If using static generation: the pages and videos are on CDN, no backend needed.
- If using server rendering: how do we cache effectively enough that a backend outage doesn't break things?
- What about dynamic elements on the page (e.g. view count, if we add it later)? Can these gracefully degrade?

### Performance

- What affects video start time? (DNS, TLS, initial segment size, player configuration, CDN proximity.)
- What are best practices for fast HLS playback start? (Short initial segments, preload hints, low-latency HLS?)
- How do we handle adaptive bitrate switching smoothly?

## Research Approach

- Study the Open Graph protocol specification and video-specific extensions.
- Study the oEmbed specification.
- Read the existing Loom research at `docs/research/loom-research.md` for context on how Loom handles delivery and embedding.
- Examine how Loom, Vimeo, and YouTube implement their video pages, OG tags, oEmbed endpoints, and embed pages. Use browser dev tools to inspect their meta tags and oEmbed responses.
- Test how various platforms (Slack, Notion, Discord, Twitter) handle links from Loom and Vimeo — what tags do they actually use?
- Research Iframely and how to get a domain listed.
- Look at HLS player options (HLS.js, Plyr, Video.js, Shaka) and compare features, bundle size, and ease of use.
- Research static site generation approaches for video pages (could be as simple as generating HTML files alongside the video assets).

## Expected Output

A research document that:

1. Recommends an architecture for video pages (static, server-rendered, or hybrid) with reasoning.
2. Provides the exact Open Graph and Twitter Card meta tags we need, with example values.
3. Describes the oEmbed implementation (endpoint, response format, discovery tag).
4. Covers the embedding approach (embed URL, player configuration, responsive sizing).
5. Evaluates HLS player options and recommends one.
6. Describes what link previews will actually look like in Slack, Notion, Discord, Twitter, and other key platforms.
7. Addresses the CDN-independence requirement.
8. Identifies any platform-specific quirks or requirements (e.g. Slack whitelisting, Notion auto-embedding).

## Related Tasks

- Task 04 (Build vs Buy) — some managed services provide player SDKs and handle delivery.
- Task 07 (Storage, CDN & Cost Modelling) — delivery architecture affects CDN choices and costs.
- Task 08 (Server & Admin Stack) — the server may generate or serve these pages.
- Task 05 (Competitive Landscape) — studying competitor video pages informs this.
