# Server — AI Agent Notes

Hono + Bun app. Receives HLS segments from the macOS recorder, assembles playlists, generates MP4 derivatives via ffmpeg, and serves the viewer page. See `docs/developer/streaming-and-healing.md` at the repo root for how segments flow client → server.

## Scripts

All scripts run from `server/`:

- `bun run dev` — hot-reload dev server on `http://localhost:3000`. Do NOT start this unless explicitly asked.
- `bun test` — run the full test suite (Bun's built-in runner, bun:test APIs)
- `bun run test:watch` — re-run tests on file changes
- `bun run check` — Biome lint + format check (read-only)
- `bun run check:fix` — auto-fix lint + format issues
- `bun run lint` / `bun run lint:fix` — lint only
- `bun run format` / `bun run format:check` — format only
- `bun run typecheck` — `tsc --noEmit`
- `bun run db:generate` — generate a new migration SQL file from `src/db/schema.ts` changes
- `bun run db:migrate` — apply pending migrations to `data/app.db` (also applied automatically on server startup)
- `bun run db:studio` — browse `data/app.db` in the Drizzle Studio web UI

Before finishing a change, run `bun run check && bun run typecheck && bun test`.

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

**Admin auth**: cookie-based sessions for the web UI, plus `lca_…` bearer tokens for programmatic access. Middleware: `requireAdmin()` in `src/lib/admin-auth.ts`. When `ADMIN_PASSWORD` env var is not set, admin auth is bypassed (dev mode). See `.env.example` for the three admin env vars (`ADMIN_PASSWORD`, `ADMIN_USERNAME`, `SESSION_SECRET`).

## API response envelope

All `/api/*` error responses: `{ error: "<human message>", code: "<MACHINE_CODE>" }`. Success: resource directly, or `{ ok: true }`. Use the `apiError(c, status, message, code)` helper from `src/lib/errors.ts` — never construct error responses by hand.

## Route modules

Four modules in `src/routes/`, each with its own auth profile. Full route reference with request/response shapes, error codes, and content types: `docs/developer/server-routes-and-api.md`.

| Module    | Mount      | Auth                                  | Purpose                             |
| --------- | ---------- | ------------------------------------- | ----------------------------------- |
| `api/`    | `/api`     | Bearer on `/videos/*`; `/health` open | JSON API for macOS app              |
| `admin/`  | `/admin`   | Session cookie or `lca_` bearer       | Admin panel                         |
| `site/`   | `/`        | Open                                  | Root, well-known files, oEmbed      |
| `videos/` | `/` (last) | Open                                  | `/:slug` viewer surface (catch-all) |

- **Auth at the mount**: bearer middleware is applied in `app.ts` to `/api/videos/*` only, keeping the api router itself auth-agnostic and easy to test.
- **Co-located tests**: each module has its own `__tests__/` next to its handlers. App-level integration tests live at `src/__tests__/app.test.ts`.

## Views & Static Assets

Hono JSX (`hono/jsx`) for server-rendered HTML, vanilla CSS with `@layer` + custom properties for styling. No build step; Bun handles `.tsx` natively, browsers fetch CSS as-is.

**Layout**:

```
src/views/
  layouts/   RootLayout, ViewerLayout, AdminLayout — shared <html>/<head>/body shells
  viewer/    public-facing pages (VideoPage today; embed/etc. later)
  admin/     admin UI components (dashboard, video detail, settings, upload, trash)
public/
  styles/    CSS — see below
```

- **JSX config**: `tsconfig` sets `jsx: "react-jsx"`, `jsxImportSource: "hono/jsx"`. Route files that return JSX must be `.tsx`.
- **DOCTYPE**: `RootLayout` emits `<!DOCTYPE html>` via `raw()` from `hono/html`. Don't repeat it elsewhere.
- **`head` slot**: layouts accept an optional `head` prop for page-specific `<link>`/`<script>` tags. Use this for stylesheets that only one page needs (e.g. Vidstack on `VideoPage`).
- **Static assets**: `server/public/` served at `/static/*` by `serveStatic` from `hono/bun`. The root path is resolved absolutely in `src/app.ts` so it survives test chdirs. Per-video media is served under `/:slug/raw/*` and `/:slug/stream/*` by the videos module (Phase 6.4).

**CSS**:

- Single entry point `public/styles/app.css` declares `@layer reset, tokens, base, components, utilities;` then `@import`s modular files into named layers.
- `tokens.css` holds all design tokens (colours in OKLCH, type/spacing scales, radii, transitions). Change values here; everything downstream uses `var(--…)`.
- `player.css` holds shared Vidstack player overrides for both the video page and embed page. Per-page layout tweaks stay in `viewer.css`/`embed.css`.
- Page-/section-specific styles (`viewer.css`, `embed.css`, `admin.css`) get linked via the `head` slot of their respective layout, not from `app.css`. Keeps page payloads small.
- Use modern CSS freely: nesting, `:has()`, container queries, `light-dark()`. All Baseline.

## Testing

Tests live in `__tests__/` directories co-located with the modules they test. Follow the patterns in the existing tests — notably the `setupTestEnv`/`teardownTestEnv` helpers in `src/test-utils.ts` for per-test filesystem isolation.

Preferences:
- Prefer real filesystem + real `:memory:` SQLite over mocks (tests are fast and catch integration bugs).
- Routes: integration-style tests using `app.request(path, init)`.
- ffmpeg-dependent tests: gate on `Bun.which("ffmpeg") !== null` via `test.skipIf`.
- Test-only helpers go on the module they test, prefixed with `_` (e.g. `_setDbForTests`, `_inFlightPromise`).

## Style

- Path imports use `"path"` / `"fs/promises"` (not `"node:..."`) — Bun accepts both; keep consistent with existing files.
- `noUncheckedIndexedAccess` is on. Array/record access gives `T | undefined` — destructure with defaults or guard explicitly.

## Gotchas

- **Module-level `await`** in `index.ts` calls `initDb()` at import. The `createApp()` factory in `src/app.ts` is the side-effect-free entry — import that from tests, not `index.ts`.
- **`DATA_DIR = "data"`** is relative. Tests depend on this. When deployment comes it'll likely become env-configurable; until then, don't hard-code absolute paths.
- **Segment filename allowlist** in `routes/api/videos.ts` (`/^(init\.mp4|seg_\d+\.m4s)$/`) is the real path-traversal defense. Don't weaken it without understanding why it exists. Similar allowlists exist in `routes/videos/media.ts` for raw and stream routes.
- **Derivatives are fire-and-forget.** `scheduleDerivatives(id)` returns immediately; the `/complete` response never waits on ffmpeg. Tests use `_inFlightPromise(id)` to await completion.
- **Default queries hide trashed videos.** `getVideo` / `getVideoBySlug` / `resolveSlug` / `listVideos` all accept `{ includeTrashed: true }` to opt in. Admin-side code needs the opt-in; public routes should never use it.
