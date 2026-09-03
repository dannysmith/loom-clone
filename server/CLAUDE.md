# Server — AI Agent Notes

Hono + Bun app. Receives HLS segments from the macOS recorder, assembles playlists, generates MP4 derivatives via ffmpeg, and serves the viewer page. See `docs/developer/streaming-and-healing.md` at the repo root for how segments flow client → server.

## Scripts

All scripts run from `server/`:

- `bun run dev` — hot-reload dev server on `http://localhost:3000`. Do NOT start this unless explicitly asked.
- `bun test` — run the full test suite (Bun's built-in runner, bun:test APIs)
- `bun run test:watch` — re-run tests on file changes
- `bun run check` — Biome lint + format check (read-only; covers `src/`, `scripts/`, `editor/src/`, `player/src/` per `biome.jsonc`)
- `bun run check:fix` — auto-fix lint + format issues
- `bun run check:all` — lint + format check, typecheck (server + editor + player), and full test suite in one command (what CI runs)
- `bun run lint` / `bun run lint:fix` — lint only
- `bun run format` / `bun run format:check` — format only
- `bun run typecheck` — `tsc --noEmit` on the server
- `bun run typecheck:editor` / `bun run typecheck:player` — `tsc --noEmit` on the sub-packages (needs `bun install` run in `editor/` / `player/` once)
- `bun run db:generate` — generate a new migration SQL file from `src/db/schema.ts` changes
- `bun run db:migrate` — apply pending migrations to `data/app.db` (also applied automatically on server startup)
- `bun run db:studio` — browse `data/app.db` in the Drizzle Studio web UI

Before finishing a change, run `bun run check:all` (or the equivalent `bun run check && bun run typecheck && bun test`). CI runs the same `check:all` command, inside the same `oven/bun` image the production Dockerfile builds from, with ffmpeg installed — so the ffmpeg-gated media tests run at the deploy gate (only the two audio tests that need macOS `say` skip on Linux, and CI fails on any other skip).

## Database

SQLite via `bun:sqlite` + Drizzle ORM. Schema in `src/db/schema.ts`, migrations in `drizzle/` (commit them — drizzle-kit needs the snapshot to diff future changes). Client factory in `src/db/client.ts`.

- **Location**: `data/app.db` in prod (inherits the `server/data/` gitignore).
- **Startup**: `initDb()` in `index.ts` opens the file and applies any pending migrations automatically.
- **Foreign keys**: `PRAGMA foreign_keys = ON` is set per-connection in `createDb()`. Without it, SQLite silently ignores `ON DELETE CASCADE`.
- **Tests**: `setupTestEnv()` creates a fresh `:memory:` DB per test with migrations applied. No shared state.
- **Migration discipline**: never rename or renumber a migration file once it has been applied to any database (yours, anyone else's, CI). Drizzle tracks applied migrations by hash + tag in `__drizzle_migrations`; rewriting a tag leaves local DBs in an unfixable state ("table already exists" on the rerun). If you need to change something, add a new migration. Local `data/app.db` is expendable — `rm -f data/app.db` to recover from any historical mess.

## Auth

Two separate auth systems. See `docs/developer/auth.md` at the repo root for the full picture.

**API keys** (`lck_…`): bearer token on all `/api/videos/*` routes. Middleware: `requireApiKey()` in `src/lib/auth.ts`, mounted in `app.ts`. CLI: `bun run keys:create <name>`, `bun run keys:list`, `bun run keys:revoke <id>`.

**Admin auth**: cookie-based sessions for the web UI, plus `lca_…` bearer tokens for programmatic access. Middleware: `requireAdmin()` in `src/lib/admin-auth.ts`. Locally (`NODE_ENV` unset), an unset `ADMIN_PASSWORD` skips auth so you can iterate without logging in. In production (`NODE_ENV=production`, set in `docker-compose.prod.yml`), `getAdminConfig()` throws if `ADMIN_PASSWORD` is missing and the server refuses to start. See `.env.example` for the three admin env vars (`ADMIN_PASSWORD`, `ADMIN_USERNAME`, `SESSION_SECRET`).

## API response envelope

All `/api/*` error responses: `{ error: "<human message>", code: "<MACHINE_CODE>" }`. Success: resource directly, or `{ ok: true }`. Use the `apiError(c, status, message, code)` helper from `src/lib/errors.ts` — never construct error responses by hand.

## Route modules

Four modules in `src/routes/`, each with its own auth profile. Full route reference with request/response shapes, error codes, and content types: `docs/developer/server-routes-and-api.md`.

| Module    | Mount      | Auth                                  | Purpose                             |
| --------- | ---------- | ------------------------------------- | ----------------------------------- |
| `api/`    | `/api`     | Bearer on `/videos/*`; `/health` open | JSON API for macOS app              |
| `admin/`  | `/admin`   | Session cookie or `lca_` bearer       | Admin panel                         |
| `site/`   | `/`        | Open                                  | Root redirect, well-known files, feeds, oEmbed |
| `videos/` | `/` (last) | Open                                  | `/:slug` viewer surface (catch-all) |

- **Auth at the mount**: bearer middleware is applied in `app.ts` to `/api/videos/*` only, keeping the api router itself auth-agnostic and easy to test.
- **Co-located tests**: each module has its own `__tests__/` next to its handlers. App-level integration tests live at `src/__tests__/app.test.ts`.

## Views & Static Assets

Hono JSX (`hono/jsx`) for server-rendered HTML, vanilla CSS with `@layer` + custom properties for styling. The server itself has no build step — Bun handles `.tsx` natively, browsers fetch CSS as-is. Two Vite builds produce static assets, with opposite commit policies:

- `editor/` → `public/editor/` — the admin React editor. **Gitignored**, built in its own Dockerfile stage at deploy time (CI also builds it as a check). In local dev, set `EDITOR_DEV=1` on the Hono server to load the editor from the Vite dev server (`bun run editor:dev`) with HMR; without the flag a missing `public/editor/` build is a hard error. See `docs/developer/admin-editor.md`.
- `player/` → `public/player/` — the self-hosted Vidstack player bundle (viewer, embed, and admin video pages). **Committed to git**, deliberately: serving the player must never depend on the npm registry being up or `vidstack@1.15.6` still being published. That durability is the reason the player is self-hosted at all (issue #54). (Deploys as a whole still hit the registry — the Dockerfile runs `bun install` for the server and editor — but the committed player bundle means the registry can't take the *viewer* surface hostage.)

**Upgrading Vidstack**: bump the exact pin in `player/package.json`, `bun install` + `bun run player:build` (from `server/`), verify a video page in the browser, commit source + built output together — CI rebuilds the player and fails if `public/player/` doesn't match the source. Trap: vidstack's npm `latest` dist-tag points at a stale 2023 build (0.6.15) — real releases ship under the `next` tag, so always pin an explicit version, never `bun add vidstack` bare. `hls.js` is pinned in the same package and bundled as a lazy chunk (fetched only for `.m3u8` sources, via the `provider-change` hook in `player/src/player.ts`).

**Layout**:

```
src/views/
  layouts/   RootLayout, ViewerLayout, AdminLayout — shared <html>/<head>/body shells
  viewer/    public viewer pages (VideoPage, EmbedPage, TagPage), SiteFooter, icons.tsx
  admin/     admin UI components (dashboard, video detail, settings, upload, trash)
             plus components/Icons.tsx (Lucide set), components/VideoCard
public/
  styles/    CSS — see below
  player/    committed Vidstack build (see above) — hashed filenames read via playerAssets() in src/lib/vite-manifest.ts, not staticUrl()
```

- **JSX config**: `tsconfig` sets `jsx: "react-jsx"`, `jsxImportSource: "hono/jsx"`. Route files that return JSX must be `.tsx`.
- **DOCTYPE**: `RootLayout` emits `<!DOCTYPE html>` via `raw()` from `hono/html`. Don't repeat it elsewhere.
- **`head` slot**: layouts accept an optional `head` prop for page-specific `<link>`/`<script>` tags. Use this for stylesheets that only one page needs (e.g. Vidstack on `VideoPage`).
- **Static assets**: `server/public/` served at `/static/*` by `serveStatic` from `hono/bun`. The root path is resolved absolutely in `src/app.ts` so it survives test chdirs. Per-video media is served under `/:slug/raw/*` and `/:slug/stream/*` by the videos module.

**CSS**: full reference in [`docs/developer/design.md`](../docs/developer/design.md). Read it before touching the admin or viewer UI.

- Three entry points, one per surface, so admin styles never reach public visitors:
  - `public/styles/app.css` — admin (linked by `RootLayout` by default). Imports reset + tokens + base + components.
  - `public/styles/viewer-app.css` — public viewer/tag pages (linked by `ViewerLayout`). Imports reset + tokens + base + viewer + player.
  - `public/styles/embed-app.css` — embed page. Imports reset + tokens + base + embed + player.
  - `RootLayout` accepts a `stylesheet` prop; `ViewerLayout` and `EmbedPage` set it.
- `public/styles/admin.css` is linked separately by `AdminLayout`'s head slot — it ships only on admin pages.
- `tokens.css` is the single source of truth for design tokens (OKLCH brand palette, semantic mappings via `light-dark()`, type/spacing scales, motion). Change values here; everything downstream uses `var(--…)`.
- Editor pages (`server/editor/`) consume the same tokens — their `:root` sets `color-scheme: dark` and aliases shared vars onto the local `--bg`/`--panel-bg`/`--text`/`--accent` names.
- Use modern CSS freely: nesting, `:has()`, container queries, `light-dark()`, `color-mix(in oklch, …)`, `oklch(from <c> …)`, native `<dialog>`/`popover`. All Baseline.

## Testing

Tests live in `__tests__/` directories co-located with the modules they test. Follow the patterns in the existing tests — notably the `setupTestEnv`/`teardownTestEnv` helpers in `src/test-utils.ts` for per-test filesystem isolation.

Preferences:
- Prefer real filesystem + real `:memory:` SQLite over mocks (tests are fast and catch integration bugs).
- Routes: integration-style tests using `app.request(path, init)`.
- ffmpeg-dependent tests: gate on `Bun.which("ffmpeg") !== null` via `test.skipIf`.
- The "processAudio (chain effects)" tests synthesise speech with macOS `say`, which silently produces an EMPTY file inside a bash sandbox (blocked speech-synthesis service) — the tests then fail with a cryptic loudnorm error. If they fail for you as an agent, run them unsandboxed before suspecting the audio chain.
- Test-only helpers go on the module they test, prefixed with `_` (e.g. `_setDbForTests`, `_inFlightPromise`).

## Style

- **Keep the lib acyclic.** `paths.ts` (`DATA_DIR` + path helpers) has no project imports; `store.ts` is data access; whole-video orchestration lives in `lifecycle.ts` beside it. New orchestration goes beside the store, not in it — orchestration accumulating inside `store.ts` is what made it the module everything routed through, and forced a run of `await import()` calls purely to break cycles. There are none left; don't reach for one.
- Path imports use `"path"` / `"fs/promises"` (not `"node:..."`) — Bun accepts both; keep consistent with existing files.
- `noUncheckedIndexedAccess` is on. Array/record access gives `T | undefined` — destructure with defaults or guard explicitly.

## Gotchas

- **Module-level `await`** in `index.ts` calls `initDb()` at import. The `createApp()` factory in `src/app.ts` is the side-effect-free entry — import that from tests, not `index.ts`.
- **`DATA_DIR = "data"`** lives in `src/lib/paths.ts` and is relative. Tests depend on this. In production the Docker bind-mount maps it to `/mnt/data/loom-clone` — don't hard-code absolute paths.
- **Segment filename allowlist** in `routes/api/videos.ts` (`/^(init\.mp4|seg_\d+\.m4s)$/`) is the real path-traversal defense. Don't weaken it without understanding why it exists. Similar allowlists exist in `routes/videos/media.ts` for raw and stream routes.
- **Derivatives are fire-and-forget.** `scheduleDerivatives(id)` returns immediately; the `/complete` response never waits on ffmpeg. Tests use `_inFlightPromise(id)` to await completion.
- **Default queries hide trashed videos.** `getVideo` / `getVideoBySlug` / `resolveSlug` / `listVideos` all accept `{ includeTrashed: true }` to opt in. Admin-side code needs the opt-in; public routes should never use it.
