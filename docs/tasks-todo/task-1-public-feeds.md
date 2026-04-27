# Task 1 — Public RSS Feed, llms.txt & JSON Feed

**Public RSS Feed, llms.txt & JSON feed** for public videos: Add an RSS feed and `llms.txt` to http://v.danny.is which contain suitable representations of all PUBLIC videos. We may also want to add a JSON endpoint which returns the same info as JSON, probably in a similar shape to that returned by the authenticated `GET /api/videos` endpoint (but only for public vids, and perhaps omitting certain fields). The RSS rss should conform to whatever the accepted standard for feeds of video content is and obviously contain suitable metadata about both the feed items themselves and also the feed itself. The llms.txt should conform to the proposed standard at https://llmstxt.org.  While we're here, I thnk we can remove the HTML template etc for GETs to `http://v.danny.is` and instead redirect that to `http://danny.is`- I'd be inclined to use a HTTP status code which doesn;t indicate this is a perm redirect just in case we ever want to serve something proper at `http://v.danny.is`. We should also probably serve suitable headers and body content (HTML comments?) to indicate that routes like http://v.danny.is/rss, http://v.danny.is/llms.txt etc exists... purely for the use of AI agents hitting the root with curl etc?

## Phases

### Phase 1 — RSS Feed
Implement an RSS feed at `/rss` (or `/feed` — decide on the canonical path) for all public videos. Conform to the appropriate standard for video content feeds. Include proper feed-level and item-level metadata.

### Phase 2 — llms.txt & JSON Feed
Add `/llms.txt` conforming to the llmstxt.org spec and a public JSON endpoint (e.g. `/feed.json`) returning public video metadata in a shape similar to the authenticated API but scoped to public videos only.

### Phase 3 — Root Route Cleanup
Remove the existing HTML template for `GET /` and replace with a temporary redirect to `http://danny.is`. Add discoverability hints (Link headers, HTML comments, or similar) so that AI agents and feed readers hitting the root can find `/rss`, `/llms.txt`, and `/feed.json`.
