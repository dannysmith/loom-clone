# Task — Viewer Buffering & Preload Tuning

Unprioritised. Low-hanging-fruit collection: small changes to the viewer pages (`/:slug` and `/:slug/embed`) that should noticeably improve cold-start latency and reduce mid-playback buffering for viewers on slow or transatlantic connections — without needing a CDN or adaptive bitrate work.

## Background

We have a viewer in Frankfurt and viewers all over the world. Until we move serving to a CDN/edge (separate future work) and/or adopt true ABR HLS (see `task-x-adaptive-bitrate-hls.md`), every byte travels from Hetzner to the viewer over a single long-haul connection. Today's setup is already doing several things right:

- HTTP/2 + HTTP/3 (`alt-svc: h3=":443"`) are enabled.
- MP4 derivatives are encoded with `+faststart` so the `moov` atom is at the front of the file.
- Range requests work (`206 Partial Content` with `Content-Range`).
- MP4 derivatives and HLS segments are served with `Cache-Control: public, max-age=31536000, immutable`.
- HLS playlists carry a short `max-age=60`.
- There's a `preconnect` to `https://cdn.vidstack.io`.

What is *not* tuned is the cold-start path: the browser is being told (via Vidstack defaults) to load lazily and to preload only metadata. That produces the "buffers a little, stops, then can't keep ahead once you hit play" symptom we've observed on transatlantic connections.

## What this task covers

A coherent set of small changes. Land them together — they're cheap, additive, and reinforce each other.

### 1. Tell the browser to actually buffer ahead

In `server/src/views/viewer/VideoPage.tsx` and `server/src/views/viewer/EmbedPage.tsx`, add the following attributes to `<media-player>`:

- `preload="auto"` — Vidstack's default is `metadata`, which is exactly the "fetch enough for the first frame, then stop" behaviour. `auto` lets the browser fill its forward buffer (Chrome targets ~30s ahead, Safari less but still meaningfully more) before the user hits play.
- `load="eager"` — Vidstack's default `load` strategy is lazy (`visible`), which gates source attachment behind an IntersectionObserver tick after the JS module loads from the CDN. `eager` attaches the source immediately on mount.

Trade-off acknowledged: `preload="auto"` means every pageview pulls a chunk of video even if the viewer never plays. Acceptable for this project (single-user, low-traffic, Hetzner egress is plentiful).

### 2. Preload the Vidstack JS module

Next to the existing `<link rel="preconnect" href="https://cdn.vidstack.io">`, add:

```html
<link rel="modulepreload" href="https://cdn.vidstack.io/player">
```

Cheap, no downside. Speeds up first-script-eval on slow connections.

### 3. Make the default `<source>` always ≤1080p

Today the resolver (`server/src/routes/videos/resolve.ts`) puts `source.mp4` first regardless of resolution. When `source.mp4` is 1440p or higher (rare today but supported), defaulting to it on a transatlantic connection is unnecessarily painful — the video is huge, the bitrate is high, and the viewer probably can't tell the difference between 1080p and 1440p in a Loom-style playback context.

Change the resolver so the *first* `<source>` element is always at most 1080p:

- Source recording is ≤1080p → no `1080p.mp4` derivative exists → leave `source.mp4` first. (No change from today.)
- Source recording is >1080p → `1080p.mp4` derivative exists → put it first, with `source.mp4` second and `720p.mp4` third.

Browsers always pick the first compatible `<source>` for default playback, so this controls default play quality without removing the source-quality option. Vidstack's quality menu sorts internally by `data-width`/`data-height`, so the menu order in the UI is unchanged regardless of DOM order.

Explicit non-goal: do **not** make 720p the default. For most viewers that would be worse net UX. 1080p is the sweet spot.

Explicit non-goal: do **not** create a new "virtual 1080p endpoint" that aliases to `source.mp4` when source is ≤1080p. The resolver already knows what files exist; it can pick the right `<source>` order without inventing a URL whose bytes vary.

### 4. Preload the default video URL

Once (3) is in place, the resolver always knows which URL will be the default. In the page `<head>` (both `VideoPage.tsx` and `EmbedPage.tsx`), emit:

```jsx
<link rel="preload" as="video" fetchpriority="high" href={sources[0].src} />
```

This kicks the video request off during HTML parse, in parallel with the Vidstack JS module fetch from `cdn.vidstack.io`. The browser reuses the in-flight bytes when `<video>` later attaches the same URL (same origin, no `crossorigin` mismatch). Saves roughly one transatlantic RTT × the chain depth between HTML parse and source attach.

Skip this hint when there are no sources (the rare healing-window HLS case where `src` is a single playlist). It's safe to also emit it pointing at the HLS playlist URL during the healing window if that proves useful, but the healing window is typically short-lived enough not to bother.

Caveat to verify in Safari: open devtools network panel on a real `/:slug` page and confirm the `<video>` request shows up as cache-reused, not a duplicate fetch. Same-origin no-`crossorigin` should be fine, but worth a one-time check.

### 5. (Optional) Short HTML cache for `/:slug` and `/:slug/embed`

The rendered HTML currently has no `Cache-Control` header. Add something like:

```
Cache-Control: public, max-age=60, stale-while-revalidate=300
```

Helps repeat visitors and any future intermediate caches. No downside as long as the TTLs stay short — viewer page content rarely changes after publish, and `stale-while-revalidate` covers the "I just edited the title" case.

This is the most optional item in the list. Skip if it adds friction; landing 1–4 alone is the bulk of the win.

## What we're explicitly *not* doing here

- True ABR HLS — covered by `task-x-adaptive-bitrate-hls.md`.
- CDN / edge serving — separate future work referenced in `AGENTS.md` ("Viewer Layer").
- Any change to encoding parameters — `+faststart` is already correct.
- Any attempt to force 100% pre-buffer before play. There is no standard knob for that on a native `<video>`; `preload="auto"` is the practical maximum without an MSE-based player.

## Where the relevant code lives

- `server/src/views/viewer/VideoPage.tsx` — main `/:slug` page, `<head>` and `<media-player>` element.
- `server/src/views/viewer/EmbedPage.tsx` — `/:slug/embed` equivalent.
- `server/src/routes/videos/resolve.ts` — builds the `sources` array and `src` for the player. The resolver-reorder change in (3) lives here.
- `server/src/routes/videos/page.tsx` and `server/src/routes/videos/embed.tsx` — the route handlers; if (5) lands, the response headers are set here.
- `server/src/routes/videos/media.ts` and `server/src/lib/file-serve.ts` — current MP4/HLS serving. No changes expected here for this task.
