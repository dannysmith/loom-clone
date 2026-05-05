# Task 1 — Viewer Player Improvements (Done)

Small improvements to the Vidstack player on the viewer page (`/:slug`), embed page (`/:slug/embed`), and admin video detail page.

## What was done

### Playback speed options

Changed the speed control from a continuous slider (0x–2x) to discrete options: 0.75x, 1x, 1.2x, 1.5x, 2x. Set via JavaScript property on `<media-video-layout>` since array-typed props can't be reliably set via HTML attributes on web components. Applied to both the viewer and embed pages.

### Download button

Enabled the built-in Vidstack download button on the viewer page by setting the `download` attribute on `<media-video-layout>` to the absolute raw source URL. Not added to the embed page (download doesn't make sense in an iframe).

### Timestamp links

Added support for `?t=` query parameter to deep-link to a specific moment in a video. A small inline script parses the parameter on `can-play` and sets `player.currentTime`.

Supported formats:
- Seconds: `?t=135`
- Human-readable: `?t=2m15s`, `?t=1h2m15s`, `?t=5m`, `?t=30s`
- Colon: `?t=2:15`, `?t=1:02:15`

Works on both `/:slug` and `/:slug/embed`.

### Admin "Copy URL at current time"

Added a "Copy URL at current time" button to the video actions bar on the admin video detail page. Reads the player's current playback position, formats it as a `?t=` parameter (e.g. `2m15s`), and copies the full public URL to the clipboard. If the player is at 0:00, copies the URL without a timestamp.

## What was already built in

Research confirmed that the following Vidstack features are already working out of the box with `<media-video-layout>`, requiring no configuration:

- Keyboard shortcuts (space/k, arrows, f, i, m, c, `<`/`>`)
- PiP button (auto-hides if unsupported)
- AirPlay button (Safari only, requires AirPlay receiver on network)
- Google Cast button (requires Cast SDK loaded separately)
- Captions toggle

## Outstanding

- **Quality selector** — not appearing despite correct `data-width`/`data-height` on `<source>` elements. May be a Vidstack limitation with MP4 multi-source vs HLS adaptive streaming. Needs further investigation.

## Files changed

- `server/src/views/viewer/VideoPage.tsx` — download attribute, playback rates + timestamp script
- `server/src/views/viewer/EmbedPage.tsx` — playback rates + timestamp script
- `server/src/views/admin/partials/VideoActions.tsx` — "Copy URL at current time" button
- `server/public/js/admin.js` — `copyTimestampedUrl()` function
