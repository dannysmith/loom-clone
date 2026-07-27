# Task 1: Self-host Vidstack — pin the player, drop the third-party runtime dependency

https://github.com/dannysmith/loom-clone/issues/54

Every public video page, every embed, and the admin video detail page load the player from `cdn.vidstack.io` at runtime. This task replaces that with a pinned npm dependency built into `server/public/player/` and committed to the repo, so a rendered video page depends on nothing but our own origin.

This reverses a decision made during task-x2 (`docs/tasks-done/task-2026-04-18-x2-proper-server-api.md`, Phase 7): _"Vidstack stays on the CDN … it's actually the more current distribution vs the stale npm package. No version pinning — updates arrive automatically, and for a personal tool the risk of a breaking change is lower than the cost of remembering to update a pinned version."_ Both halves of that premise turned out to be false. See below.

---

## What's actually on the page today

Measured 2026-07-27 against the live CDN, brotli-encoded, crawling the full eager module graph:

| | requests | bytes (br) | waterfall depth | origins |
| --- | --- | --- | --- | --- |
| JS | 18 | 102,669 (100.3 KB) | 2 | `cdn.vidstack.io`, `cdn.jsdelivr.net` |
| CSS | 2 | 12,351 (12.1 KB) | 1 | `cdn.vidstack.io` |

`cdn.vidstack.io/player` is a thin alias over jsDelivr's `@vidstack/cdn@1.15.6`. The entry file is 42 KB; the other 17 modules are discovered only once it parses, so the issue's "42 KB" figure understates the real eager cost by 2.4×.

Two runtime dependencies are not in the issue's description at all:

- **`media-captions@1.0.4`** — lazily fetched from jsDelivr whenever captions or chapters render, i.e. on every video here.
- **`hls.js@^1.5.0`** — an unpinned semver range that jsDelivr resolves at request time. Reached via `resolve.ts:181`, which falls back to `urls.hls` while derivatives are still processing. That is exactly the record-and-share-immediately flow, not a dead path.

So the current surface is two third-party origins, four packages, and one floating semver range.

## The risk is not hypothetical — it fired eight weeks ago

Vidstack was dormant for 15 months (1.12.13 in Feb 2025 → 1.13.0 in May 2026), then shipped 1.13.0 → 1.15.6 in 16 days. In that window, four separate fixes landed against the **CDN distribution specifically**:

| Date | Fix |
| --- | --- |
| 2026-05-26 | #1820 — CDN externals not resolving |
| 2026-05-27 | lit-html and `@floating-ui` missing from CDN builds |
| 2026-06-01 | #1831 → #1834 — `/player` referenced `./providers/vidstack-video-DFgSRBza.js`, which **404'd** |
| 2026-06-09 | #1841 → #1842 — `fscreen` undeclared, patched in the CDN bundle the next day |

#1831 is the exact failure this task exists to prevent: the unversioned entry file pointing at a chunk that did not exist, served to every consumer of that URL. The back catalogue rode 1.12.13 → 1.15.6 through all of it with no deploy on our side and no pinned version to roll back to.

Supporting signal: all releases are by a single maintainer, 151 open issues, no tagged GitHub releases, and npm's `latest` dist-tag still points at **0.6.15** (2023, incompatible API) while real work ships under `next`. That last point also refutes the task-x2 premise — the CDN is not "more current than npm"; they are the same 1.15.6 build, just published under a different tag.

## What self-hosting buys

A Vite build of `vidstack/player` + `/player/ui` + `/player/layouts/default`, measured:

**1 request, 76,746 bytes brotli (299 KB raw), same origin, depth 1.**

That is 25 KB _less_ and 17 fewer requests than today. The issue's "a naive bundle might be bigger" worry does not hold — Rollup tree-shakes better than the CDN's generic chunk split, and the lazy chunks still split out (hls, youtube, vimeo, dash, google-cast, srt/ssa parsers, media-captions). Two further wins fall out for free:

- `media-captions` becomes a local 16.9 KB lazy chunk instead of a jsDelivr fetch on every page.
- `media-icons` disappears entirely. Only the CDN build imports it externally; the npm build inlines its icons.

The CSS is trivially portable: both files are self-contained, with no `@import` and no `url()`. npm ships them unminified (66 KB + 16 KB) and Vite minifies them to roughly the CDN's 48/11.

Nothing is lost on shared-CDN cache reuse — cross-site HTTP cache sharing has been dead since cache partitioning shipped in Chrome 86, Safari and Firefox. And BunnyCDN already serves the video bytes, so that connection is warm before the player is requested. Self-hosting removes a cold cross-origin connection rather than adding one.

## Agreed design decisions (treat these as requirements)

1. **The build output is committed to git**, not gitignored. This deliberately breaks with the `server/public/editor/` precedent. A deploy must not depend on the npm registry being up or on `vidstack@1.15.6` still being published — that dependency is the thing this task exists to remove. Upgrades become `bun run build` in `server/player/` plus a commit.
2. **`server/player/` is a new sibling to `server/editor/`**, with its own `package.json`, `bun.lock` and `vite.config.ts`, building to `server/public/player/` and served at `/static/player/*`. A public viewer asset should not be served from a `/static/editor/…` URL, and the admin editor's dependency tree stays independent of the viewer's.
3. **hls.js is self-hosted too**, via `HLSProvider.library`. It must stay lazy — assign a dynamic import loader (`() => import('hls.js')`), not an eager top-level `import HLS from 'hls.js'`, or ~150 KB becomes eager for every viewer. The `library` setter accepts either a loader function or a URL string.
4. **The version is pinned exactly** (`vidstack@1.15.6`, no `^`). `bun add vidstack` without a version resolves to 0.6.15 — a 2023 build with an incompatible API.
5. **Asset URLs come from the Vite manifest, not `staticUrl()`.** `STATIC_VERSION` hashes the whole of `public/`, so a CSS tweak would otherwise bust a 300 KB player. Vite's content-hashed filenames are already stable per build; `src/lib/vite-manifest.ts` is the existing reader.

---

## Phase 1 — Build pipeline

Stand up the build and prove its output before any page changes. Nothing user-visible ships in this phase.

### [P1.1] Create `server/player/`

- `package.json` (private, `type: module`), pinning `vidstack@1.15.6` and `hls.js` exactly, with `vite` as a dev dependency. Match the versions and script names in `server/editor/package.json`.
- `vite.config.ts`: `base: "/static/player/"`, `build.outDir: "../public/player"`, `emptyOutDir: true`, `manifest: true`, single `rollupOptions.input` entry named `player`.
- `src/player.ts` entry, importing in this order — CSS first, then the element registrations:

  ```ts
  import "vidstack/player/styles/default/theme.css";
  import "vidstack/player/styles/default/layouts/video.css";
  import "vidstack/player";
  import "vidstack/player/ui";
  import "vidstack/player/layouts/default";
  ```

- Add a `player:build` script to `server/package.json` alongside the existing `editor:build`.

### [P1.2] Verify the bundle registers the elements we actually use

The four custom elements in `VideoPage.tsx` / `EmbedPage.tsx` are `media-player`, `media-provider`, `media-poster` and `media-video-layout`. All four appear in the built entry, but that was confirmed by grepping the bundle, **not** by loading a page. Confirm in a browser before proceeding — this is the one assumption in the plan that has not been verified end to end.

Also confirm the two behaviours driven by the inline `<script type="module">` in `VideoPage.tsx` still work: the `playbackRates` assignment via `customElements.whenDefined('media-video-layout')`, and the `?t=` deep-link seek.

### [P1.3] Confirm the size and request numbers

Re-measure against the table above. Expected: one JS request, one CSS request, ~77 KB brotli eager. If the entry comes out materially larger, find out which lazy chunk got pulled eager before continuing.

### [P1.4] Commit the output

Confirm `server/public/player/` is **not** matched by any `.gitignore` rule (the existing `server/public/editor/` entry is specific enough that it should not be) and that `server/player/node_modules/` is caught by the root `node_modules/` rule.

---

## Phase 2 — Swap the viewer and embed pages

### [P2.1] Generalise the manifest reader

`src/lib/vite-manifest.ts` currently hardcodes the `editor` directory and an editor-specific dev-server fallback. Extend it to take the build directory as a parameter, or add a sibling function. The player has no dev-server mode — it is a committed artefact, so a missing manifest is a hard error, not a fall-through to `localhost:5173`.

### [P2.2] Replace the tags in `VideoPage.tsx` and `EmbedPage.tsx`

Remove the `preconnect`, both `<link rel="stylesheet">` tags and the `<script type="module">`. Emit the manifest's CSS link and module script in their place, and repoint `modulepreload` at the self-hosted entry.

**Preserve the cascade position.** `RootLayout.tsx:33` links the page stylesheet _before_ the `head` slot, so Vidstack's CSS currently lands after `viewer-app.css` (which imports our `player.css` theming). Our overrides work on specificity, not source order — but keep the new tags in the same slot so the cascade is unchanged. A theming regression here would be silent and easy to miss.

### [P2.3] Update the tests

`src/routes/videos/__tests__/embed.test.ts:45` and `page.test.ts:91` both assert the literal CDN `modulepreload` URL. Rewrite them to assert a self-hosted `/static/player/` URL, and add an assertion that no `cdn.vidstack.io` or `cdn.jsdelivr.net` reference survives anywhere in the rendered viewer and embed HTML. That second assertion is the one that stops this regressing.

---

## Phase 3 — hls.js and the admin page

### [P3.1] Point `HLSProvider` at the local hls.js

In `src/player.ts`, after the element registrations, attach a listener that swaps the library on provider change:

```ts
document.addEventListener(
  "provider-change",
  (e) => {
    const provider = (e as CustomEvent).detail;
    if (provider?.type === "hls") provider.library = () => import("hls.js");
  },
  true,
);
```

Two things to verify rather than assume: that `provider-change` reaches a capture-phase document listener (it is dispatched on the `media-player` element), and that the `provider.type === "hls"` check is correct for the custom-element API — the documented React equivalent is the `isHLSProvider(provider)` guard. If the document listener does not work, wire it per-player in the existing inline script instead.

### [P3.2] Test the HLS path specifically

The MP4 derivative path will pass whatever happens here, because it never touches hls.js. Test a video whose derivatives have not landed — that is the only route that exercises this, and it is the flow that matters most (record, share the link immediately, derivatives finish later).

Confirm in the network panel that `hls.min.js` is served from our origin and only for `.m3u8` sources.

### [P3.3] Swap the admin video detail page

`src/views/admin/pages/VideoDetailPage.tsx:75-77` carries the same three CDN tags. Lower stakes — admin-only, not a permanent URL — but there is no reason to keep a second copy of the dependency once the bundle exists. Note that admin pages bypass the CDN cache by Edge Rule, so no purge considerations apply.

---

## Phase 4 — Docs and verification

### [P4.1] Docs

- `server/CLAUDE.md:61` — _"No build step; Bun handles `.tsx` natively"_ is already untrue (the Dockerfile runs Vite for the editor) and this makes it doubly so. Rewrite that paragraph to describe both builds and note that the player output is committed while the editor's is not, with the reason.
- `AGENTS.md` — add `server/player/` to the project-structure tree.
- `docs/developer/design.md:377` — the Vidstack section should say where the player CSS now comes from.
- Document the upgrade procedure somewhere durable: bump the pin, `bun run build`, verify, commit the output. Include the `latest`-vs-`next` dist-tag trap, because it will bite whoever does the next upgrade.

### [P4.2] Definition of done

- No `cdn.vidstack.io` reference remains in `server/src/`, and no `cdn.jsdelivr.net` reference on any **public** surface (grep is the check). Admin surfaces keep pre-existing, version-pinned jsDelivr deps that were never in this task's scope: highlight.js on `VideoDetailPage.tsx` and htmx in `AdminLayout.tsx`. Self-hosting those is a possible follow-up, not part of #54.
- A rendered video page makes zero third-party requests other than Simple Analytics, verified in a browser network panel with the cache disabled — both the MP4 path and the HLS path.
- Eager player payload is one JS request and one CSS request, ~77 KB brotli.
- Player theming is visually unchanged: brand colour, slider tints, the coral paused-state play icon.
- Captions, chapters, storyboard thumbnails, the quality menu, playback rates and `?t=` seeking all still work.
- `bun run check && bun run typecheck && bun test` green.
- A cold `docker build` succeeds with the npm registry unreachable for `server/player/` — that is the property the committed-output decision was made for, and it is worth actually testing once.

---

## Explicitly not doing

- **Simple Analytics stays.** Async, privacy-preserving, and a deliberate product choice.
- **No dashjs handling.** Its provider also defaults to a jsDelivr URL, but no DASH source is ever produced or served, so the code path is unreachable. It stays lazy and unloaded.
- **No Vite dev-server mode for the player.** It is a committed artefact rebuilt on version bumps, not something iterated on.
- **No upgrade automation.** Deliberate, manual upgrades are the point of the change.

---

## References

- Issue #54
- `docs/tasks-done/task-2026-04-18-x2-proper-server-api.md` — the Phase 7 decision this reverses
- `docs/tasks-done/task-2026-04-27-x-viewer-buffering-tuning.md` — where the `modulepreload` hint came from
- Vidstack CDN breakages: vidstack/player #1820, #1831, #1834, #1841, #1842
