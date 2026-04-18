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

All `/api/videos/*` routes require an API key sent as `Authorization: Bearer <token>`. `/api/health`, `/:slug/*`, `/static/*`, `/admin` are open.

- **Format**: `lck_<32 random bytes, base64url>`. The `lck_` prefix is a leak-detection aid (grep/secret scanners).
- **Storage**: `api_keys` table stores only SHA-256 of the token. Plaintext is shown once on creation and never recoverable. SHA-256 is correct here (not bcrypt/argon2) — API keys are high-entropy, so password-hashing functions would just slow down every request verification for no gain. See `src/lib/api-keys.ts` for the rationale on why we don't need `timingSafeEqual`.
- **Middleware**: `requireApiKey()` in `src/lib/auth.ts`. Returns 401 + `WWW-Authenticate: Bearer realm="loom-clone"`. Updates `lastUsedAt` fire-and-forget. Exposes `apiKeyId` on the Hono context (typed via `AuthVariables`) for future route-level auditing.
- **CLI**:
  - `bun run keys:create <name>` — prints the token once, stores the hash
  - `bun run keys:list` — id, status, last_used, name
  - `bun run keys:revoke <id>` — idempotent
- **Env**: `HOST` (default `127.0.0.1`) and `PORT` (default `3000`) in `.env`. Bun auto-loads. See `.env.example`.
- **Transport**: plaintext bearer over HTTP is acceptable on localhost only. task-x3 (Hetzner) must enforce HTTPS before `HOST` gets widened.

## API response envelope

All `/api/*` error responses use a uniform shape: `{ error: "<human message>", code: "<MACHINE_CODE>" }`. Success responses return the resource directly (or `{ ok: true }` for action endpoints with no return value). Error codes are defined in `src/lib/errors.ts`; use the `apiError(c, status, message, code)` helper to build error responses — never construct them by hand.

Current codes: `MISSING_AUTH_HEADER`, `MALFORMED_AUTH_HEADER`, `EMPTY_BEARER_TOKEN`, `INVALID_API_KEY` (401), `VIDEO_NOT_FOUND` (404), `INVALID_SEGMENT_FILENAME` (400), `VIDEO_ALREADY_COMPLETE` (409).

## Route modules

`src/routes/` is split into four modules, each with its own auth profile. Mount order in `app.ts` matches the list below; the wildcard `videos` module is mounted last as documentation of intent (Hono's trie router prefers specific routes regardless).

```
routes/
  api/      bearer auth on /videos/* (mount-point), /health open
    index.ts        mounts /health + /videos, ConflictError→409 handler
    videos.ts       GET list, GET/:id, POST create, PATCH, PUT segment, POST complete, DELETE
  admin/    web/session auth at the mount (placeholder until task-x5)
    index.tsx       /admin stub
  site/     open — root, well-known files
    index.ts        aggregator
    well-known.tsx  /, /robots.txt, /favicon.ico, /sitemap.xml
  videos/   /:slug viewer surface — mounted last as catch-all
    index.ts        aggregator + /:file dispatch (.json, .md, .mp4, plain slug)
    page.tsx        /:slug HTML page + /v/:slug→/:slug 301 redirect
    embed.tsx       /:slug/embed chromeless player
    media.ts        /:slug/raw/:file, /:slug/stream/:file, /:slug/poster.jpg
    metadata.ts     /:slug.json, /:slug.md handler functions
```

- **Auth at the mount**: bearer middleware is applied in `app.ts` to `/api/videos/*` only, keeping the api router itself auth-agnostic and easy to test.
- **Co-located tests**: each module has its own `__tests__/` next to its handlers. App-level integration tests live at `src/__tests__/app.test.ts`.

## Views & Static Assets

Hono JSX (`hono/jsx`) for server-rendered HTML, vanilla CSS with `@layer` + custom properties for styling. No build step; Bun handles `.tsx` natively, browsers fetch CSS as-is.

**Layout**:

```
src/views/
  layouts/   RootLayout, ViewerLayout, AdminLayout — shared <html>/<head>/body shells
  viewer/    public-facing pages (VideoPage today; embed/etc. later)
  admin/     admin UI components (stub today, fleshed out in task-x5)
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
- Page-/section-specific styles (`viewer.css`, `admin.css`) get linked via the `head` slot of their respective layout, not from `app.css`. Keeps page payloads small.
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
