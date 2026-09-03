# Admin Client

`server/admin-client/` is the home for every React app served inside the admin panel. Today that's two: the video editor and the cover-image generator. This document covers the package itself — layout, build, the seam that joins it to the Hono server — plus the two decisions that shape the frontend as a whole: why the viewer's player is a separate package, and when a third-party dependency is acceptable.

For the editor app's own architecture (EDL format, edit pipeline, keyboard shortcuts) see [`admin-editor.md`](admin-editor.md).

## Why a separate package at all

The server has no build step: Bun runs `.tsx` natively and browsers fetch the CSS as-is. That's worth protecting — it makes the server trivially runnable and debuggable. But two things genuinely need bundling: a React editor with wavesurfer, and a web-components video player with a lazy-chunk graph. So they're built as isolated islands, joined to the server by a Vite manifest. The rest of the admin panel stays HTMX + server-rendered Hono JSX, which is the right tool for CRUD forms and page navigation.

## Layout

```
server/admin-client/
  editor.html               # Vite entry — the video editor
  cover.html                # Vite entry — the cover-image generator
  package.json              # React, wavesurfer, qrcode.react, html-to-image, the two webfonts
  tsconfig.json             # React JSX config (not hono/jsx), plus vite/client ambient types
  vite.config.ts            # base=/static/admin-client/, builds to ../public/admin-client/
  src/
    editor/                 # the video editor app
      main.tsx              #   entry — reads data-* attributes from the HTML shell
      App.tsx api.ts types.ts
      components/ hooks/ styles/
    cover/                  # the cover-image generator app
      main.tsx              #   entry — reads data-* attributes from the HTML shell
      App.tsx Editor.tsx api.ts export.ts state.ts styles.css
      preview/              #   the SVG canvas that gets exported
```

Each app is self-contained: they share the build, the dependency set and the design tokens, and no code. Adding a third app means adding an entry `.html`, a `src/<name>/` directory, an entry in `rollupOptions.input`, and one line in `ADMIN_CLIENT_ENTRIES` in `server/src/lib/vite-manifest.ts`.

## Build and dev workflow

**Production build** (from `server/`):

```sh
bun run admin-client:build
```

Output lands in `server/public/admin-client/` — **gitignored**, built in its own Dockerfile stage at deploy time. CI builds it too, so a broken build fails in GitHub rather than first surfacing as a failed `docker build` on the VPS.

**Development** (two terminals):

```sh
# Terminal 1: Hono server, with the admin client in dev mode
cd server && ADMIN_CLIENT_DEV=1 bun run dev

# Terminal 2: Vite dev server with HMR
cd server && bun run admin-client:dev
```

Dev mode is an explicit opt-in. With `ADMIN_CLIENT_DEV=1` the page loads its scripts from the Vite dev server (`localhost:5173`) for HMR, even if a local build exists. Without it, the built assets are always used and a missing manifest is a hard error. This replaced a file-presence check that failed in both directions: a missing production build silently served `localhost:5173` script tags (a blank page, no error), and a stale local build disabled HMR forever.

**Quality gates.** Both apps are covered by the same gates as the server: Biome lint + format (`biome.jsonc` includes `admin-client/src/**`), `tsc --noEmit` via `bun run typecheck:admin-client`, and CI. All of it runs under `bun run check:all`.

## The server seam

`server/src/lib/vite-manifest.ts` is the only place that knows how built assets are named. It reads the Vite manifest and returns structured `EntryAssets` (`{ js, css, devClient? }`) — never HTML strings. Turning those into tags is a view's job:

```
lib/vite-manifest.ts          adminClientAssets("editor" | "cover") → EntryAssets
views/admin/components/       <AdminClientAssets entry="editor" />  → <link> + <script>
views/admin/pages/            <EditorPage> / <CoverPage>            → RootLayout + the root div
routes/admin/editor.tsx       guards, then c.html(<EditorPage video={video} />)
routes/admin/cover.tsx        guards, then c.html(<CoverPage video={video} />)
```

Both pages are ordinary Hono JSX built on `RootLayout`, so they get the versioned stylesheet link and favicons every other page gets, and attribute escaping comes from the JSX renderer rather than a hand-rolled `escapeAttr`.

Each app receives its inputs as `data-*` attributes on its root element and reads them once on mount — no metadata round-trip. The page views are the contract: every attribute they render is one the app actually reads.

Resolved production assets are cached per entry, like the player's. Dev-mode URLs deliberately aren't: there's no manifest read to save, and a cached dev result would outlive a change to the env var.

## Why the player stays a separate package

`server/player/` builds the self-hosted Vidstack bundle and is **not** part of the admin client, even though merging them would collapse some duplicated tooling. The public/admin boundary is the real architectural line:

- The player is the only thing standing between a viewer and a video. It's committed to git as a built artefact specifically so serving it never depends on the npm registry being up, or on `vidstack@1.15.6` still being published.
- Keeping `player/` tiny, exactly-pinned and rarely-touched is the point. Merging it into a lockfile shared with React, wavesurfer and a webfont set would let routine editor dependency work churn transitive deps underneath the vendored build — exactly the coupling that vendoring exists to prevent.

So the two packages have deliberately opposite commit policies: `public/admin-client/` is gitignored and rebuilt at deploy; `public/player/` is committed, and CI fails if it drifts from `player/src`. See `server/CLAUDE.md` for the Vidstack upgrade procedure.

## Dependency policy: public vs admin

**Public viewer surfaces must not depend on a third party at runtime.** Video URLs need to outlive everything else in this system. Anything the viewer, embed or feed surfaces need is served from our own origin — which is why the player is self-hosted at all.

**Admin surfaces may depend on a third party at runtime, within reason.** An outage there breaks Danny's admin panel for an afternoon; it doesn't touch a single published video. That's why the admin panel loads htmx, head-support and highlight.js from jsDelivr and that's fine.

**Build-time dependencies are not the same thing.** Every deploy already runs `bun install`; npm being down means no deploy, not a broken site. So pulling a package to build an admin asset is unremarkable — the line is about what the *browser* fetches at runtime.

The cover tool's webfonts sit on the interesting edge of this. They're rendered on an admin-only page, so the runtime rule would permit fetching them from Google — but they also bake into an exported cover, which then becomes a published thumbnail. A font fetch that quietly fails wouldn't break the admin panel; it would produce a wrong-looking published artefact. So Inter and Fira Code are npm dependencies (`@fontsource-variable/*`), bundled by Vite and served from our own origin.

## The cover-image generator

A tool for making a branded cover image for a video, at `/admin/videos/:id/cover`. It renders an SVG canvas — blob background, title, avatar, optional media slot and QR code, attribution footer — and exports it as PNG, JPEG or SVG, or adds it directly to the video's thumbnail candidates.

- **Canvas**: a 1545×869 `<svg>` in `src/cover/preview/`. Text blocks use `<foreignObject>` so they get real HTML text layout; `Title` binary-searches a font size so any title fits its box. The media slot and QR code are independently draggable (`useSvgDrag`), each with its own position, scale and rotation.
- **State**: one `CoverState` object in `src/cover/state.ts`, with per-field defaults derived from the video so every control can offer a Reset.
- **Identity**: the author's name, handle and avatar come from the server's `src/lib/site-config.ts`, passed in as `data-author-*` attributes by `CoverPage`. Nothing in the cover tool hardcodes them.
- **Export** (`src/cover/export.ts`): PNG and JPEG are rasterized from the live SVG by `html-to-image`. SVG export clones the canvas, strips editing-only attributes, and base64-inlines both the images and the two webfonts, so the exported file renders standalone with no network.
- **Adding to a video**: "Add to thumbnails" posts the rendered JPEG to `/admin/videos/:id/thumbnail/add-candidate`, which stores it as a candidate without promoting it. Promotion stays with the normal thumbnail picker on the video detail page.

The tool's own chrome is styled by `src/cover/styles.css`, which — like the editor's CSS — consumes the shared design tokens and pins itself to dark mode. See [`design.md`](design.md).
