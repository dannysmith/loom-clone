# Task: Viewer-facing Edge Layer

High-availability CDN/Caching layer for serving all viewer-facing routes to users as performantly and efficiently as possible. We care about this because:

1. Better UX & Speed for viewers.
2. Higher availability than we can manage with just our Hertzner VPS.
3. Handles sudden spikes in traffic to certain videos gracefully.
4. Can potentially continue to serve content if the Hertzner box is temporarilly down for any reason.

## Viewer-Facing Routes

See `docs/developer/server-routes-and-api.md` for more info.

### 1. Simple routes

- Simple static routes like `https://v.danny.is/robots.txt` (or CSS files etc) should be cached on the edge. These change rarely.
- Other "simple" routes like `https://v.danny.is/sitemap.xml` can also be cached agressively but are generated dynamically so must be invalidated whenever new public videos are added etc.

### 2. Video Routes

Serving these from an edge layer *before* the Hetzner server is hit has the highest value, especially where we can serve the actual video content from an edge as close to the viewer as possible. Note: Renamed slugs 301-redirect to the canonical slug via the `slug_redirects` table.

- `/:slug`
- `/:slug/embed`
- `/:slug/raw/:file`
- `/:slug/stream/:file`
- `/:slug.mp4`

#### Video routes with no actual videos

These routes do not include actual video content.

- `/:slug/poster.jpg`
- `/:slug.json`
- `/:slug.md`


### 3. Serving Appropriate Video Formats

Currently, the `/:slug` and `/:slug/embed` routes always serve the HTML video player which loads either the HLS segments as a playlist or the source.mp4 if available. In 99% of cases this means the source.mp4 is served to viewers regardless of the speed of their connection. It would make more sense to detect the client's speed and capabilities and serve the most appropriate video file (ie derivitive). If possible we could also consider adaptive streaming etc.
