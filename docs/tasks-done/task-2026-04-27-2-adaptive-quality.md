# Task 2 — Adaptive Quality for Viewers

## What this is

The viewer-facing player at `/:slug` and `/:slug/embed` currently picks one source — `derivatives/source.mp4` if it exists, else the live HLS playlist — and hands that single URL to Vidstack. The 720p (and where applicable 1080p) MP4 derivatives the post-processing pipeline already generates exist on disk and are reachable via `/:slug/raw/:file`, but the viewer never references them. They are dead bytes from a viewer's perspective.

This task wires those existing variants into the player so viewers get a Quality menu (powered by Vidstack's default `<media-video-layout>`) and can switch between source / 1080p / 720p as needed.

## What we've decided to do

When `derivatives/source.mp4` exists, render multiple `<source>` children inside `<media-provider>` instead of the current single `src` prop. Vidstack populates `player.qualities` from `data-width` and `data-height` attributes on those `<source>` elements, and the default settings menu surfaces a Quality submenu automatically.

```html
<media-player>
  <media-provider>
    <source src="/:slug/raw/source.mp4"  type="video/mp4" data-width="1920" data-height="1080" />
    <source src="/:slug/raw/1080p.mp4"   type="video/mp4" data-width="1920" data-height="1080" />
    <source src="/:slug/raw/720p.mp4"    type="video/mp4" data-width="1280" data-height="720" />
  </media-provider>
  <media-video-layout thumbnails="..." />
</media-player>
```

(The widths above are illustrative — the actual values are derived from the source aspect ratio and the variant target height; see "Implementation notes" below.)

The healing-window path (no `source.mp4` yet) stays unchanged: a single `src` pointing at the live HLS playlist.

## What we've decided NOT to do

These were considered and explicitly ruled out for this task. Recording the reasoning so we don't relitigate later.

- **No codec strings in the `type` attribute** (e.g. `type="video/mp4; codecs=\"avc1.640028,mp4a.40.2\""`). All variants are H.264 + AAC-LC; every browser that can play `video/mp4` at all can play that. There is nothing for the codec string to help the browser reject. Adding it would mean either probing each derivative at generation time and storing the result, or hardcoding a string that might be wrong for some encodes — and getting it wrong silently breaks playback. Plain `type="video/mp4"` is the right amount of information.
- **No experimental network-aware hints** (`prefers-reduced-data`, `Save-Data` request header, Network Information API). None are Baseline; `prefers-reduced-data` isn't implemented in any browser, the header is Chromium-only and would force `Vary: Save-Data`, the API is Chromium-only and JS-only. The complexity isn't justified for a personal tool. The Quality menu gives users manual control on a slow connection.
- **No `<source media="...">` queries.** Theoretically Baseline for HTML, but Vidstack's docs are silent on whether their source selection respects the `media` attribute. Not worth the uncertainty when the Quality menu solves the same problem.
- **No 720p-as-default to favour cellular viewers.** The trade-off (worse desktop UX for marginally better cellular UX) is wrong for the use cases in `AGENTS.md` — viewers are overwhelmingly on broadband desktops viewing Slack-style screenshares and Notion embeds, where the first impression should be crisp. Cellular viewers can pick down via the menu.

## Implementation notes

- **Derivative widths are derivable from the DB.** `videos.width`, `videos.height`, `videos.aspectRatio` give the source dimensions. Each `Np.mp4` derivative was encoded with `scale=-2:N`, so its width is `round_to_even(N × aspectRatio)`. No need to ffprobe the derivative files at request time.
- **Source ordering matters for the initial pick.** Vidstack's docs are silent on whether multiple MP4 sources have a documented selection rule (highest, first-listed, viewport-based, etc.). List them **highest quality first** (source → 1080p → 720p) so that whatever Vidstack does, the default biases toward the better experience. If testing shows a different behaviour, we can adjust order.
- **Existing serving infra is sufficient.** The `/:slug/raw/:file` route already allowlists `source.mp4` and `<N>p.mp4` and serves them with HTTP Range. Nothing to add server-side beyond the resolver / view changes.
- **`/:slug.mp4` redirect stays as-is.** It continues to point at `source.mp4` — that's the canonical "raw download" URL.
- **Variant existence still needs to be checked per request.** `derivativeFlags` in `resolve.ts` currently does three file-exists checks. Adding `1080p.mp4` and `720p.mp4` brings it to five at most. Bun's `Bun.file().exists()` is a stat call — fine for now.

## Verify before declaring done

- The Quality submenu actually appears in the default `<media-video-layout>` settings menu when sources are MP4-only (not HLS). Vidstack's docs strongly imply yes — the menu surfaces whenever `player.qualities` is non-empty, regardless of source kind — but most documented examples use HLS. A 60-second visual check on the local dev server is enough.
- The video resumes near the previous playback position when the user changes quality (rather than restarting from zero). Vidstack's behaviour here is documented as graceful but worth eyeballing.
- The healing-window single-HLS path is unaffected. Quickest way: stop the local server, drop a fresh recording's `derivatives/source.mp4` aside temporarily, hit the page, see the HLS fallback.

## Test fixture

There's a usable video at `/f28cee40-test` on the local dev server. Its data lives under `server/data/ee734631-a683-4f7b-b03d-a502bd2ebee5/` — a 1920×1080 source with a 720p variant (no 1080p variant, because the policy is "only generate variants smaller than the source"). Useful for validating both the two-variant case (1080p source + 720p) and confirming that no `1080p.mp4` is offered when the source is itself 1080p.

For the three-variant case (source 1440p+ with both 1080p and 720p variants), record a fresh video at 1440p+ to test against.

## Where the relevant code lives

- Viewer resolver (returns `src`, will need to return an array of source descriptors): `server/src/routes/videos/resolve.ts`
- Viewer page (renders `<media-player src={...}>`): `server/src/views/viewer/VideoPage.tsx`
- Embed page (same pattern): `server/src/views/viewer/EmbedPage.tsx`
- Variant generation policy (`VARIANTS`, `variantsForHeight`): `server/src/lib/derivatives.ts`
- Allowlist for `/:slug/raw/:file` (already permits `<N>p.mp4`): `server/src/routes/videos/media.ts`
