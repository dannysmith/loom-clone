# Cover Image Generator

GitHub: [#14](https://github.com/dannysmith/loom-clone/issues/14)

## Goal

Bring the standalone cover/thumbnail generator (currently sitting at the repo root as `thumbnail-creator-spike/`) into the admin app, wired to a real video. Reach a state where, from the admin video detail page, you can:

- Open a full-size cover editor for a video.
- See the spike's editor exactly as it works today — same UI, same colours, same toggles, sliders, draggable slots, QR code, framed media slot, exports.
- Have the video's real **title**, **page URL** and **current thumbnail** pre-populated as the starting state. Reset buttons restore *those* DB-backed values, not the spike's hardcoded defaults.
- Upload your own image into the media slot (already works in the spike).
- Click **Add to thumbnails** to save the rendered cover into the video's existing `thumbnail-candidates/` collection, so it shows up in the regular thumbnail picker and can be promoted from there.
- Optionally still download PNG / JPEG / SVG straight to disk (the spike already does this).

The spike already solves the hard parts: SVG composition, font embedding, image inlining, canvas rasterisation, foreignObject text fit, drag interaction, QR + avatar rendering, three export formats. **v1 is a port + integration, not a redesign.**

Out of scope for v1:

- Changing the cover's visual design. The colours, fonts and palette in the spike do not match the rest of the admin UI yet — that's intentional. Admin UI restyle is a separate piece of work; the cover renderer stays as-is.
- Multi-template selector. There's exactly one template.
- Server-side rendering / batch / CLI regeneration.
- Auto-promoting the generated cover. "Add to thumbnails" saves a candidate; promotion happens via the existing thumbnail picker.
- Aspect ratios other than the spike's current 1545×869.

## What's already done (in `thumbnail-creator-spike/`)

Everything in `thumbnail-creator-spike/src/`:

- `cover/Background.tsx`, `Blobs.tsx`, `Title.tsx`, `Footer.tsx`, `Avatar.tsx`, `MediaSlot.tsx`, `QrCode.tsx`, `Preview.tsx`, `constants.ts`, `useSvgDrag.ts` — the SVG cover itself.
- `Editor.tsx` — the right-hand control panel.
- `App.tsx` — splits the page into preview (left) + editor (right).
- `state.ts` — `CoverState` shape, defaults, reset constants.
- `export.ts` — `exportPng`, `exportJpeg`, `exportSvg`, `dataUrlToBlob`, font embedding for SVG output. Uses `html-to-image` for raster paths.
- `styles.css` — dark editor chrome with the orange accent. Keep verbatim.
- Deps: `html-to-image`, `qrcode.react`, plus React 18.

This code works end-to-end in the spike's `vite` dev server. The port should change as little of it as possible.

## Where it lives in the admin app

The cover editor is a **full page**, not a modal — same shape as the existing video editor at `/admin/videos/:id/editor`. The control surface is too rich for a dialog and the existing editor's pattern already solves the layout problem.

- Route: `GET /admin/videos/:id/cover` → returns an HTML shell with `data-*` attributes (id, slug, title, public URL, current thumbnail URL), mounts a React root.
- Mirrors `server/src/routes/admin/editor.ts` almost exactly. The manifest / Vite-dev-server scripts loader from `editor.ts:33-54` should be lifted into a small shared helper since we're now using it twice. Keep the helper tiny — no premature abstraction.
- Lives inside the existing `server/editor/` Vite project as a **second Vite entry**:
  - New `server/editor/cover.html` + `server/editor/src/main-cover.tsx`.
  - `vite.config.ts` gets `build.rollupOptions.input = { editor: 'index.html', cover: 'cover.html' }` so both build into the same `server/public/editor/` output, with separate manifest entries.
  - Shared infra: same `base: "/static/editor/"`, same TS config, same dev-server proxy.
- React **19** (matches the existing editor), not React 18 from the spike. The spike code is plain enough that the upgrade is automatic — no APIs change for this code.

Add deps to `server/editor/package.json`: `html-to-image`, `qrcode.react`. (Already present in the spike's package.json.)

## Entry point on the video detail page

Add a single button to `server/src/views/admin/pages/VideoDetailPage.tsx` next to the existing `ThumbnailPicker` partial: **"Open cover editor"** → links to `/admin/videos/:id/cover`. No HTMX, no modal — just a link, like the editor's edge has.

## File layout (proposed)

```
server/editor/
  cover.html                            # NEW — second entry HTML
  index.html                            # unchanged
  vite.config.ts                        # add rollupOptions.input with both entries
  package.json                          # add html-to-image, qrcode.react
  src/
    main.tsx                            # editor entry (unchanged)
    main-cover.tsx                      # NEW — mounts <CoverApp /> on #cover-root
    cover/                              # NEW — port of thumbnail-creator-spike/src
      App.tsx                           #   the spike's App.tsx, taking VideoInputs as a prop
      Editor.tsx                        #   spike Editor.tsx, with "Upload to server" → "Add to thumbnails"
      state.ts                          #   spike state.ts, defaults now derived from VideoInputs
      export.ts                         #   spike export.ts (unchanged)
      styles.css                        #   spike styles.css (unchanged)
      api.ts                            # NEW — POST blob to /admin/videos/:id/thumbnail/upload
      preview/                          #   spike src/cover/* moved here verbatim
        Background.tsx
        Blobs.tsx
        Title.tsx
        Footer.tsx
        Avatar.tsx
        MediaSlot.tsx
        QrCode.tsx
        Preview.tsx
        constants.ts
        useSvgDrag.ts
server/src/
  routes/admin/
    cover.ts                            # NEW — GET /admin/videos/:id/cover (HTML shell only)
    editor.ts                           # refactor: extract manifest loader into ../../lib/vite-manifest.ts
  lib/
    vite-manifest.ts                    # NEW — loadEntryAssets(entryName): { scripts: string }
  views/admin/pages/
    VideoDetailPage.tsx                 # add link to the cover editor near ThumbnailPicker
```

The spike's `public/avatar.jpg` and `public/thumbnail.jpg` test assets are not ported. Avatar is sourced from a static asset in the admin app; thumbnail is sourced from the video.

## Wiring the spike's state to real video data

The spike's `state.ts` exports `initialState` (with hardcoded "Danny's Loom Replacement" title etc.) and per-field reset constants (`TITLE_CONTENT_DEFAULTS`, `URL_CONTENT_DEFAULTS`, `QR_CONTENT_DEFAULTS`, `MEDIA_DEFAULTS`, `QR_DEFAULTS`). In the port:

- `initialState` becomes a `buildInitialState(inputs: VideoInputs)` function.
- `TITLE_CONTENT_DEFAULTS` and `URL_CONTENT_DEFAULTS` become *runtime* values derived from `VideoInputs`, not module constants. The Reset buttons in `Editor.tsx` keep working as they do today, but the value they restore is the DB title / public URL, not the spike string.
- The media slot's `imageSrc` defaults to `inputs.currentThumbnailUrl` (the video's existing `thumbnail.jpg`). The user can still "Upload image" to replace it — that path already works in the spike and stays unchanged.
- The QR slot's `url` defaults to the same public URL as the URL field.

`VideoInputs` is built once in `main-cover.tsx` from `data-*` attributes on `#cover-root`:

```ts
type VideoInputs = {
  videoId: string;
  slug: string;
  title: string;            // empty string if video has no title set
  publicUrl: string;        // absolute, e.g. "https://v.danny.is/my-slug"
  currentThumbnailUrl: string;  // e.g. `/admin/videos/${id}/media/thumbnail.jpg`
};
```

If `inputs.title` is the empty string (video has no title set in the DB), the Title field defaults to placeholder text — `"Untitled video"` — rather than the slug or an empty string. The Reset button restores the same placeholder.

Author meta (`@dannysmith`, copyright, avatar.jpg) stays hardcoded — single-user tool, no settings pane required. Put the constants in `cover/state.ts` next to the existing exports.

## "Add to thumbnails"

Repurpose the spike's `Editor.tsx` **Upload to server** button:

- Label: **Add to thumbnails**.
- Format: JPEG. The cover's background is solid `#2f3437` so JPEG is the right choice (smaller, no alpha needed).
- **Save as candidate only — no auto-promote.** The existing `/thumbnail/upload` endpoint auto-promotes the upload, which is wrong for this surface (the user is exploring designs, not committing to one). Add a sibling endpoint `POST /admin/videos/:id/thumbnail/add-candidate` that mirrors the existing upload's validation + save path but skips the promote step. The user promotes via the regular `ThumbnailPicker` afterwards.
- Implementation: render the SVG with `exportJpeg`, convert via `dataUrlToBlob`, post as multipart to the new endpoint.

After a successful save, **stay on the cover page** and show a toast ("Added to thumbnails ✓"). No redirect.

The PNG / JPEG / SVG download buttons in the spike's Editor stay exactly as they are.

## Persistence of cover state

**Defer.** A first pass that does not persist any state is meaningfully simpler:

- No `cover-config.json`, no `PUT` endpoint, no debounced save, no shape-versioning.
- Every time you open the cover editor, it starts from "title = current title, URL = current public URL, media = current thumbnail, sliders at defaults."
- The user's session-local edits live in React state until they click "Add to thumbnails" or close the tab.

Trade-off: re-opening the editor for the same video forgets your slider tweaks and any uploaded media image. For a feature you use a handful of times per video, that's probably fine.

If it turns out to be annoying in real use:

- Cheap follow-up: persist `CoverState` *minus the media slot's `imageSrc`* to `derivatives/cover-config.json`. Toggles, slider positions, custom title/URL/QR text all survive.
- Expensive follow-up: also persist uploaded media images (would need a directory + filename management + cleanup story). Probably never worth it for a single-user tool.

Capture this in the doc rather than build it now. Revisit after using the feature on real videos.

## Refactor: shared Vite manifest loader

Pull `editor.ts:33-54` (manifest path check + dev/prod script tag construction) into `server/src/lib/vite-manifest.ts`:

```ts
export function loadEntryAssets(entryName: string): { scripts: string; }
```

Where `entryName` is `'index.html'` or `'cover.html'`. The function reads `server/public/editor/.vite/manifest.json` if present, falls back to dev-server URLs (`http://localhost:5173/static/editor/src/main.tsx` style) otherwise. Both `editor.ts` and the new `cover.ts` then call this helper. Five-line refactor; no behavioural change.

## Tests

The hard parts of this feature — SVG composition, canvas rasterisation, font embedding — are exercised every time a human renders a cover. They aren't worth unit-testing.

- **Server**: no new endpoint to test (the existing `/thumbnail/upload` already has coverage). The new `cover.ts` route is HTML-shell-only; one integration test confirming `200 OK` + the `#cover-root` data attributes are present is enough.
- **Client**: skip. The spike has zero tests; the port shouldn't add framework just for this. If `Editor.tsx` grows non-trivial pure logic during the port, write a unit test for that specific function; otherwise rely on manual visual review.

Run `bun run check && bun run typecheck && bun test` before finishing as usual.
