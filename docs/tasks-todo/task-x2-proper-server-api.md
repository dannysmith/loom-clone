# Task: Proper Server API

Goal: Turn the prorotype Hono app into a proper backend server API which accepts videos from the macOS app and can be deployed to Hertzner. We are not trying to be feature complete here, just have a good, well set up, secure system, which can be run locally and deployed. 

## Phase 1 - Developer Tooling and Cleanup [DONE]

Let's get the hono server properly set up with development tools for linting, formatting, checking, testing etc. We can also take this opportunity to do a little bit of clean up and refactoring and re architecture to get us ready for what we know we're gonna be doing. 

## Phase 2 - Test Setup & Tests [DONE]

Let's get an automated testing framework set up in here and add tests for anything which we already have, which we should definitely have unit tests or any other types of tests for. 

## Phase 3 - SQLite + Drizzle ORM and Data Models etc [DONE]

Okay, up to now we have just been using files on the server to manage recordings and everything. We should now transition to a proper data model using SQLite and Drizzle ORM. This may also be an opportunity for us to potentially look at some validation both in the API layer and the data layer. And also potentially look at some sensible refactorings or abstractions to make this stuff easier to work with in the code base.

### Data Model

Six tables. Schema decisions locked in during planning: ISO-text timestamps (matches existing code), slugs globally unique forever (including across trashed videos — trash is reversible), slug-change conflicts fail loudly, `status` and `visibility` are separate dimensions, `trashedAt` is a timestamp (not a visibility value), `durationSeconds` cached on the videos table at completion.

**`videos`** — the core record
- `id` (text, PK) — UUID
- `slug` (text, unique not null) — current public slug
- `status` (text) — `recording` | `healing` | `complete` | `failed` (processing lifecycle)
- `visibility` (text, default `unlisted`) — `public` | `unlisted` | `private`
- `title`, `description` (text, nullable) — user-edited
- `durationSeconds` (real, nullable) — cached from segments at completion
- `width`, `height` (integer, nullable) — metadata; columns added now, population deferred
- `source` (text, default `recorded`) — `recorded` | `uploaded`
- `createdAt`, `updatedAt`, `completedAt`, `trashedAt` (text ISO, nullable where appropriate)

**`video_segments`** — replaces `segments.json`
- Composite PK `(videoId, filename)`, `durationSeconds`, `uploadedAt`, FK cascade delete

**`slug_redirects`** — permanent-URL requirement
- `oldSlug` (PK), `videoId` (FK cascade), `createdAt`
- On slug change: insert old slug here, update `videos.slug`. Lookup: try `videos.slug`, fall back to redirect → 301

**`tags`** — `id` (int PK), `name` (unique), `createdAt`

**`video_tags`** — m2m: composite PK `(videoId, tagId)`, both FK cascade

**`video_events`** — audit log
- `id`, `videoId` FK cascade, `type` (open string), `data` (JSON text), `createdAt`
- Types include: `created`, `healed`, `completed`, `slug_changed`, `title_changed`, `description_changed`, `tag_added`, `tag_removed`, `trashed`, `visibility_changed`, `derivative_generated`, `derivative_failed`
- Deliberately *not* logged: per-segment uploads. 150 segments per recording is noise, not an audit trail.

**What moves, what stays**
- `segments.json` → DB (durations in `video_segments`). Heal flow still uses filesystem listing for segment *presence*.
- `video.json` → gone; DB is authoritative.
- `recording.json` → stays on disk. Snapshot/backup artifact, large, not operational data.
- Segments, `init.mp4`, derivatives → stay on disk.

**Deferred**: `api_keys` (Phase 5), view counts (later phase). No placeholder tables.

### Sub-phases

#### 3.1 Setup

- Install `drizzle-orm` and `drizzle-kit`. Use `bun:sqlite` (built-in, no native module) via `drizzle-orm/bun-sqlite`.
- Create `src/db/client.ts` (instantiates the db) and `src/db/schema.ts` (tables).
- **In `client.ts`, set `PRAGMA foreign_keys = ON`** on every connection. SQLite ignores `ON DELETE CASCADE` otherwise.
- DB file at `data/app.db` — sits alongside per-video directories, inherits the test-isolation sandbox for free.
- Add `drizzle.config.ts`.
- Add scripts: `db:generate` (schema diff → migration SQL) and `db:migrate` (apply).

#### 3.2 Schema

- Write `src/db/schema.ts` with all six tables above.
- Indexes: `videos(slug)` unique, `videos(trashedAt)`, `videos(createdAt DESC)`, `slug_redirects(videoId)`, `video_tags(tagId)`, `video_events(videoId, createdAt)`.
- Generate the initial migration SQL and commit it.

#### 3.3 Store rewrite

- Rewrite `src/lib/store.ts` as DB-backed functions. Keep `createVideo`, `getVideo`, `getVideoBySlug`, `addSegment`, `getSegmentDurations`, `setVideoStatus`, `deleteVideo` roughly compatible so route churn is minimal.
- Drop the in-memory Maps, `loadAllVideos()`, and `_resetForTests()`.
- Update `src/test-utils.ts` to create a fresh sqlite DB per test (in-memory `:memory:`, migrations applied via `drizzle-orm/bun-sqlite/migrator`). Keep the chdir pattern for filesystem ops.
- Add an `events.ts` helper (or put it in the store) with `logEvent(videoId, type, data?)`.
- **`updatedAt` maintained application-side**: every mutating function sets `updatedAt = new Date().toISOString()`. No SQLite trigger.
- **`completedAt` set-once**: populated on the first transition to `status='complete'`. Re-completing after healing does not overwrite it.

#### 3.4 Data-model additions

- **Slug lookup with redirects**: `resolveSlug(slug)` returns `{ video, redirect: boolean }`. Playback route uses this to 301.
- **Slug change**: `updateSlug(videoId, newSlug)` — validates, inserts old slug into `slug_redirects`, updates `videos.slug`. Rejects if `newSlug` is already in `videos.slug` or `slug_redirects.oldSlug` (any other record). Conflict surfaces as **409 Conflict** at the API boundary, not 400.
- **Visibility + metadata edits**: `updateVideo(videoId, patch)` with a narrow patch type (title/description/visibility).
- **Tags**: `createTag`, `renameTag`, `deleteTag`, `addTagToVideo`, `removeTagFromVideo`, `listTags`.
- **Soft delete**: `trashVideo(videoId)` sets `trashedAt`. All list/get queries filter out trashed by default with an `includeTrashed` opt-in. No `restoreVideo` — if a manual un-trash is ever needed, update the DB by hand.

#### 3.5 Route updates

- `POST /api/videos` — unchanged API; writes row with `visibility=unlisted`, logs `created`.
- `PUT /:id/segments/:filename` — rows into `video_segments` instead of sidecar. No event log per segment. Reject uploads to trashed videos (404, same shape as unknown id).
- `POST /:id/complete` — set status, populate `completedAt` (once) and `durationSeconds`, log `completed` or `healed`.
- `DELETE /:id` — keep as hard delete for now (cascades via FK). A later admin-panel change will swap this to soft-trash.
- `GET /v/:slug` — use `resolveSlug`; if redirect, return `c.redirect()` 301.

Existing `data/` is expendable — not production, nuke it before running the new schema. No migration script.

#### 3.6 Validation — DEFERRED

Skipped for this phase. Current routes have almost no user input worth validating (malformed IDs already 404 via the store lookup; the segment filename allowlist is a one-line regex; the `/complete` timeline body is intentionally loose). A global error handler mapping `ConflictError → 409` would be dead code because no current route exposes the store functions that throw it.

Defer to whenever the first admin/edit route is built (Phase 6 or task-x5). At that point: install `zod` + `@hono/zod-validator` + optionally `drizzle-zod`, add schemas against real user input shapes, register the error handler. ~20 minutes once there's a consumer.

One standalone correctness fix was pulled out of this phase and applied: `x-segment-duration` parsing now guards against `NaN`/non-positive values and falls back to the default.

#### 3.7 Tests

- Rewrite tests that exercised the in-memory store to work against the DB. The per-test `:memory:` db keeps them fast. **Done in 3.3.**
- New tests: slug history + redirect lookup, slug-change conflict, tag CRUD and assignment, trash + filtering, event logging on each state change, FK cascade (deleting a video removes its segments/tags/events/redirects). **Mostly done in 3.3-3.5**; remaining gap is an explicit test for the `slug_redirects` cascade.
- Validation rejection tests — skipped with 3.6.
- Keep the real-filesystem-and-ffmpeg integration tests as-is. **Done.**

#### 3.8 Cleanup

- Remove `video.json` and `segments.json` writes from the code. Remove the migration reader from `loadAllVideos()` (it's gone anyway).
- Add a "Database" section to `server/CLAUDE.md` (location, scripts, test isolation).
- Update `docs/developer/streaming-and-healing.md` — the file inventory table loses `video.json` and `segments.json`, gains a pointer to the DB.

## Phase 4 - Styling System [DONE]

Set up the templating + CSS foundation that both the viewer page (today) and the admin panel (Phase 6 / task-x5) will sit on top of. Today the only HTML is the inline string in `playback.ts`; we want a proper structure before admin work multiplies the surface area.

**Decisions locked in during planning:**
- **Templating**: Hono JSX (`hono/jsx`). Built-in, type-safe, zero new deps. Components port cleanly to Cloudflare Workers if/when the viewer layer moves there (task-x6).
- **CSS**: vanilla CSS with `@layer` + custom properties. No framework, no build step. Bun serves static files directly.
- **CSS organisation**: a single `app.css` that declares layer order once and `@import`s smaller files into named layers. One `<link>` in the layout, modular files in dev. Round-trip cost is irrelevant at single-user scale.
- **Asset location**: `server/public/` for static files (CSS, future fonts/images), served by `serveStatic` from `hono/bun` at `/static/*`. `src/` stays code-only.
- **Brand starter**: system font stack (swap later via `--font-sans`), neutrals + one accent in OKLCH, 4px-base spacing, ~5-step type scale. Everything as `--vars` in one tokens file.
- **Admin interactivity**: deferred to Phase 6. Phase 4 ships HTML scaffolding only.

### Sub-phases

#### 4.1 JSX setup

- Configure `tsconfig.json`: `"jsx": "react-jsx"`, `"jsxImportSource": "hono/jsx"`.
- Smoke-test by rendering a trivial component via `c.html(<Foo/>)` from a throwaway route, verify no runtime/type errors.

#### 4.2 Static asset pipeline

- Mount `serveStatic({ root: "./public" })` from `hono/bun` at `/static/*` in `createApp()`.
- Create `server/public/styles/` with empty stubs for the CSS files in 4.3.
- Add a `public/` subsection to `server/CLAUDE.md`.

#### 4.3 CSS foundation

- `app.css` — declares `@layer reset, tokens, base, components, utilities;` and `@import`s the rest into the right layers.
- `reset.css` — minimal modern reset (box-sizing, margin zeroing, body/html, focus-visible).
- `tokens.css` — CSS custom properties: colours (OKLCH), type scale, spacing scale, radii, transition timing.
- `base.css` — element-level styles (body type, headings, links, form baseline).
- `components.css` — empty for now; populated as components arrive.

#### 4.4 Layouts

- `src/views/layouts/RootLayout.tsx` — `<html>`/`<head>`/meta/title shell linking `app.css`, `children` slot.
- `src/views/layouts/ViewerLayout.tsx` — content-centred shell for `/v/:slug`, wraps `RootLayout`.
- `src/views/layouts/AdminLayout.tsx` — sidebar+main shell stub for future admin, wraps `RootLayout`.

#### 4.5 Migrate viewer page

- Move the HTML in `playback.ts` into `src/views/viewer/VideoPage.tsx`.
- Drop the inline `<style>` — viewer styling lives in `base.css` plus a small page-specific `viewer.css` if needed.
- Vidstack stays on the CDN for now (revisit in Phase 7).

#### 4.6 Admin shell stub

- Add `GET /admin` route rendering an empty `AdminLayout` with a "Phase 6 lives here" placeholder.
- Proves the system end-to-end without committing to admin features.

#### 4.7 Tests

- Render test for `VideoPage` (asserts title, video source, poster behaviour).
- Static-asset route returns 200 + correct content-type for `/static/styles/app.css`.
- `/admin` returns 200.

#### 4.8 Docs

- New "Views & Styling" section in `server/CLAUDE.md` (where layouts/components live, CSS layer order, how tokens work).
- Cross-cutting note in `AGENTS.md` if anything beyond the server is affected.

### Out of scope (deliberately)

- A full component library (no `Button`/`Card` until something needs them).
- htmx vs forms decision — deferred to Phase 6.
- SEO / OG / oEmbed — Phase 7.
- Vidstack self-hosting / theming overhaul — Phase 7.

## Phase 5 - Auth for menubar app [DONE]

Gate the `/api/videos/*` routes behind API-key auth and make the macOS app send authenticated requests. Single-user tool; the right primitive is a long-lived bearer token, not sessions or JWTs.

**Decisions locked in during planning:**
- **Credential**: random 32-byte API key, transmitted as `Authorization: Bearer <token>`. Format: `lck_<base64url>` (prefix makes leaked tokens identifiable in logs / scans).
- **Server stores SHA-256 hashes only**, never plaintext. SHA-256 (not bcrypt/argon2) — API keys are high-entropy; password-hashing functions are the wrong tool here.
- **Multiple keys allowed** (one per device + revocation graveyard). Schema: `api_keys(id, name, hashed_token, created_at, last_used_at, revoked_at)`.
- **Bootstrap via CLI**: `bun run keys:create <name>` prints the token once, then stores only the hash. No chicken-and-egg with an admin UI.
- **Middleware scope**: `/api/videos/*` only. `/api/health`, `/v/*`, `/data/*`, `/static/*`, `/admin` stay open.
- **macOS storage**: Keychain, never UserDefaults. Thin wrapper (`APIKeyStore`) + a centralised `APIClient` that owns base URL + auth header injection. The three existing call sites (`UploadActor`, `HealAgent`, `RecordingCoordinator`) route through it.
- **macOS settings UI**: SwiftUI `Settings` scene (standard Cmd+, window), not a popover sheet. More Mac-native, same effort.
- **Server bind**: switch to `127.0.0.1` for local dev. Cheap insurance against plaintext bearer tokens leaking over LAN.
- **Transport**: plaintext over HTTP is acceptable for localhost dev only. task-x3 (Hetzner deploy) **must** enforce HTTPS — bearer tokens over HTTP on the open internet are trivially interceptable.

### Sub-phases

#### 5.1 Schema + key lib + CLI

- Add `api_keys` table to `src/db/schema.ts` (`id` UUID PK, `name` text, `hashedToken` text unique, `createdAt`/`lastUsedAt`/`revokedAt` ISO text). Index on `hashedToken`.
- Generate + commit migration.
- `src/lib/api-keys.ts`: `createApiKey(name)` returns `{ id, plaintext }` (plaintext returned once, never stored), `verifyApiKey(token)` returns the key row or null, `listApiKeys()`, `revokeApiKey(id)`, `touchLastUsed(id)`.
- `scripts/keys.ts` — tiny CLI dispatching on argv: `create <name>`, `list`, `revoke <id>`. Wire into `package.json` as `keys:create` / `keys:list` / `keys:revoke`.
- Token generation uses `crypto.getRandomValues` (Bun has it natively). Prefix `lck_` + `base64url(32 random bytes)`.

#### 5.2 Auth middleware

- `src/lib/auth.ts` — `requireApiKey()` Hono middleware factory. Reads `Authorization: Bearer <token>`, hashes, looks up, checks `revokedAt IS NULL`. On success, fires `touchLastUsed(id)` (fire-and-forget; don't block the response). On any failure, return 401 with `WWW-Authenticate: Bearer realm="loom-clone"`.
- Mount on `/api/videos` sub-app only. Leave `/api/health` untouched.
- Lookup is `WHERE hashed_token = ?` against an indexed column — no constant-time comparison needed. With 256-bit token entropy the practical timing leak is negligible; if we ever add auth rate-limiting this is the place to revisit.

#### 5.3 Server tests

- Middleware unit tests: missing header → 401, malformed bearer → 401, unknown token → 401, revoked key → 401, valid key → passes through + `lastUsedAt` updated.
- Integration: each `/api/videos*` route returns 401 without a key and the usual 2xx/4xx shape with a key.
- `/api/health` still 200 without a key.
- Add a `createTestApiKey()` helper to `test-utils.ts` so existing integration tests keep working with minimal churn.

#### 5.4 Server bind + env

- `src/index.ts`: read `PORT` (default 3000) and `HOST` (default `127.0.0.1`) from `Bun.env`.
- `.env.example` with those + a comment about `DATABASE_URL` being a future concern.
- Add `.env*` to `server/.gitignore` except `.env.example`.

#### 5.5 macOS Keychain wrapper

- `app/LoomClone/Helpers/APIKeyStore.swift` — `kSecClassGenericPassword`, service ID = bundle id + `.apikey`. Three entry points: `read() -> String?`, `write(_:) throws`, `delete() throws`.
- No async needed — Keychain reads are effectively instant.

#### 5.6 macOS APIClient centralisation

- New `app/LoomClone/Pipeline/APIClient.swift` — actor or `struct` owning base URL (`http://127.0.0.1:3000` for now, env-driven later) and an `authorizedRequest(url:method:)` builder that reads the key from `APIKeyStore` and attaches `Authorization: Bearer <token>`.
- Refactor `UploadActor`, `HealAgent`, `RecordingCoordinator` to construct requests through it. Keep each call site's error handling specific — but surface 401s as a distinct "API key invalid or revoked" state instead of the generic failure path.
- Health check (`/api/health`) stays unauthenticated and keeps its own direct path; auth failure there would just be noise.

#### 5.7 macOS Settings UI

- `SettingsScene` in `App/` with one `TextField` (masked) + Save/Clear. Writes to Keychain via `APIKeyStore`.
- Popover "no API key configured" empty state when `APIKeyStore.read() == nil` — replaces the Record button with a "Open Settings" button.
- Record button remains gated on `/api/health` reachability AND a stored key.

#### 5.8 Docs

- New `server/CLAUDE.md` auth section: token format, where hashes live, CLI commands, constant-time comparison, env vars.
- Brief `docs/developer/auth.md` — single-page tour of the system end to end (schema, hashing, key lifecycle, macOS storage, rotation).
- `AGENTS.md` project-tree update for new files.

### Out of scope (deliberately)

- Rate limiting — different concern. Single user, defer to a later phase if we ever hit a real need.
- Per-key scopes/permissions — YAGNI for single user.
- Admin-panel web auth — Phase 6 concern, different mechanism (sessions, probably). Do not conflate.
- HTTPS enforcement — task-x3 (deploy).
- CORS — irrelevant until delivery moves cross-origin (task-x6).
- Key rotation automation — manual `revoke` + `create` is fine at this scale.

## Phase 6 - API restructure + route surface

This phase rationalises the URL surface so it's predictable, future-proof, and easy to extend. Three concrete things happen:

1. The Hono app is reorganised into four route modules (`api` / `admin` / `site` / `videos`), each with its own auth profile.
2. Viewer-facing URLs move from `/v/:slug` to `/:slug` with all video resources (HTML page, embed, raw MP4, HLS stream, thumbnail, JSON, Markdown) namespaced under the slug.
3. The `/api/*` surface for the macOS app is tightened (response envelope, DELETE rules) and rounded out (list/get/patch endpoints).

Phase 7 builds on the new viewer routes (real HTML quality, SEO, OG, embed UX, JSON/MD content). Phase 6 is the structural rearrangement that makes Phase 7 cheap.

Admin panel functionality (CRUD UI, session auth, `/admin/api/*` surface) is **out of scope** here — that's task-x5. Phase 6 only establishes the admin module mount so the structure is ready for it.

### Decisions locked in during planning

- **Four route modules**, mounted in `app.ts`:
  - `api` — bearer auth at the mount, `health` excepted. Public/external contract for the macOS app and any future programmatic clients.
  - `admin` — web/session auth at the mount, `login` excepted. Wide internal surface (CRUD, bulk, settings). Built out in task-x5.
  - `site` — root, well-known files (`/robots.txt`, `/favicon.ico`, `/sitemap.xml`). Open.
  - `videos` — the `/:slug{...}/*` wildcard catch-all. Mounted last as documentation of intent.
- **Viewer URLs at root.** `/:slug` replaces `/v/:slug`. `/v/:slug` stays mounted as a permanent 301 to the new path forever — never to be removed.
- **Slug constraints become load-bearing.** Regex `^[a-z0-9](-?[a-z0-9])*$` (no dots, no slashes, no leading/trailing/double dashes). Reserved-word list (`admin`, `api`, `static`, `health`, `login`, `embed`, `raw`, `stream`, `data`, plus root well-known names) checked at create/rename time. Surfaces as **409 Conflict** at the API boundary.
- **Drop `/data/*`.** All per-video media moves under `/:slug/...` paths. The UUID stops being a public identifier; `recording.json` stops being world-readable.
- **HLS lives at `/:slug/stream/*`**, not `/data/*`. Per-segment slug→id lookup is cheap (indexed unique slug column); the playlist uses relative segment URLs so no rewriting is needed.
- **Raw video lives at `/:slug/raw/<filename>`** where `<filename>` mirrors the on-disk derivative name (`source.mp4`, future `720p.mp4`, `1080p.mp4`). Path-based, cacheable, mirrors the eventual R2 object key.
- **`/:slug.mp4` is a 302 redirect** to whatever the canonical raw is today (currently `source.mp4`). 302 not 301 because the canonical default may change as new derivatives arrive.
- **API and admin APIs are separated.** `/api/*` is the small, stable, bearer-authed contract for the macOS app and external clients. `/admin/api/*` is the wide, session-authed internal surface for the admin panel. Both sit on top of the same `lib/store.ts`.
- **Response envelope**: success returns the resource (or `{ ok: true }` for action endpoints with no return value); errors always return `{ error: "<message>", code: "<MACHINE_CODE>" }`. Lock the shape in now; populate codes as endpoints are touched.
- **`PUBLIC_URL` env var.** Server returns full URLs (clipboard URL, etc.) so the macOS app stops reconstructing them.
- **Skip URL versioning.** No `/api/v1/*` prefix. Single-controlled-client tool — additive evolution + a documented "we don't break field shapes" rule is enough until proven otherwise.

### Final route map

```
/                           → small landing or 302 → /admin
/robots.txt, /favicon.ico   → served at root via `site` module
/sitemap.xml                → stub (filled in Phase 7)
/static/*                   → app CSS/JS/fonts (unchanged)

/admin                      → web-authed admin app (stub today; task-x5)
/admin/login                → exception, unauthed
/admin/api/*                → internal admin JSON API (task-x5)

/api/health                 → unauthed
/api/videos                 → GET (list), POST (create)
/api/videos/:id             → GET, PATCH, DELETE (409 if complete)
/api/videos/:id/segments/:filename   → PUT (idempotent)
/api/videos/:id/complete    → POST (idempotent, doubles as heal-sync)

/v/:slug                    → permanent 301 → /:slug
/:slug                      → HTML video page
/:slug/embed                → chromeless player
/:slug/raw/<file>           → MP4 / future variants, with HTTP Range
/:slug/stream/<file>        → HLS playlist + segments, with HTTP Range
/:slug/poster.jpg           → thumbnail
/:slug.mp4                  → 302 → /:slug/raw/source.mp4 (or canonical)
/:slug.json                 → JSON metadata (stub here, fleshed out in Phase 7)
/:slug.md                   → Markdown metadata (stub here, fleshed out in Phase 7)
```

### Current routes

Baseline inventory.

#### macOS app / JSON API

| Verb | Path | Auth | Response type | Status codes |
|---|---|---|---|---|
| `POST` | `/api/videos` | Bearer | `application/json` — `{ id, slug }` | 200, 401 |
| `PUT` | `/api/videos/:id/segments/:filename` | Bearer | `application/json` — `{ ok: true }` | 200, 400 (bad filename), 404 (unknown/trashed video), 401 |
| `POST` | `/api/videos/:id/complete` | Bearer | `application/json` — `{ url, slug, missing }` | 200, 404 (unknown video), 401 |
| `DELETE` | `/api/videos/:id` | Bearer | `application/json` — `{ ok: true }` | 200, 404 (unknown video), 401 |
| `GET` | `/api/health` | — (deliberately open) | `application/json` — `{ ok: true }` | 200 |

- `/api/health` is **deliberately unauthed** — the macOS app pings it before it has a token; 401s here would confuse "server down" with "bad credentials".
- `PUT .../segments/:filename` enforces a strict allowlist: `init.mp4` or `seg_NNN.m4s`. Anything else → 400. Custom header `x-segment-duration` carries the segment length (NaN-guarded; falls back to the default).
- `POST .../complete` accepts an `application/json` body with `{ timeline: {...} }` — the server diffs expected vs on-disk to populate `missing`. Idempotent (safe to call repeatedly as heal progresses). The response's `url` is the path only (e.g. `/v/abc123`); the client prepends the base URL.
- 401 responses always include `WWW-Authenticate: Bearer realm="loom-clone"` and a JSON body `{ error: "<message>" }` with one of: `Missing Authorization header`, `Malformed Authorization header`, `Empty bearer token`, `Invalid or revoked API key`.

#### Viewer-facing (public web)

| Verb | Path | Auth | Response type | Status codes |
|---|---|---|---|---|
| `GET` | `/v/:slug` | — | `text/html` | 200, 301 (slug renamed → redirect to canonical), 404 (unknown/trashed) |

- 301 redirect location = `/v/<current-slug>`, sourced from the `slug_redirects` table. Trashed videos return 404 on both their current slug and any old redirect slug.

#### Static asset routes

| Verb | Path | Auth | Response type | Status codes |
|---|---|---|---|---|
| `GET` | `/static/*` | — | per-file (`text/css`, etc.) | 200, 404 |
| `GET` | `/data/*` | — | varies (see below) | 200, 206 (partial), 404, 416 (unsatisfiable range) |

- `/static/*` serves `server/public/` (CSS, future fonts/images) via `serveStatic` from `hono/bun`.
- `/data/*` serves per-video media with **HTTP Range support** (video seeking). Content-Types: `application/vnd.apple.mpegurl` (`.m3u8`), `video/iso.segment` (`.m4s`), `video/mp4`, `image/jpeg`, `image/png`, `application/json`, `application/octet-stream` fallback. Always emits `Accept-Ranges: bytes`; 206 on Range requests.

#### Admin (stub)

| Verb | Path | Auth | Response type | Status codes |
|---|---|---|---|---|
| `GET` | `/admin` | — (will change — Phase 6 / task-x5) | `text/html` | 200 |

- Empty `AdminLayout` placeholder today. Phase 6 (task-x5) fleshes this out and adds session-based auth — deliberately **not** the same mechanism as the API bearer tokens.

### Coverage note

- No route currently returns 409 (Conflict) — the store's `ConflictError` is thrown on slug collisions but none of today's routes expose that path. Phase 6 admin edit routes will be the first to need the mapping.
- No route currently returns 400 for body validation — the one existing 400 is the segment-filename allowlist in `PUT .../segments/:filename`. If/when `zod` lands (deferred per 3.6), request-body 400s join the inventory.
- No route emits CORS headers. Irrelevant until delivery goes cross-origin (task-x6).
- No 5xx is currently intentional — all paths either return a specific 4xx or let Hono's default handler surface a 500. That's probably fine until task-x5/admin needs better error UX.

### Sub-phases

#### 6.1 Slug constraints + reserved words

- Add slug regex (`^[a-z0-9](-?[a-z0-9])*$`) and `RESERVED_SLUGS` const to `src/lib/store.ts`.
- `createVideo` (slug auto-generation must produce conformant slugs and avoid reserved words) and any future `updateSlug` validate against both. Conflicts surface as **409 Conflict** at the route layer (existing `ConflictError` mapping — first route to expose it lands in 6.13).
- Tests: regex acceptance/rejection table, reserved-word rejection, conflict on rename.

#### 6.2 Route module reorganisation

- Restructure `src/routes/` into four modules: `api/`, `admin/`, `site/`, `videos/`. Each owns its own sub-router.
- Auth middleware applied at the mount point in `app.ts` for `api` (bearer, existing `requireApiKey()`) and `admin` (placeholder pass-through until task-x5).
- Move existing handlers without behaviour change: `videos.ts` → `api/videos.ts`, `playback.tsx` → `videos/page.tsx`, `static.ts` → `site/data.ts` for one phase (drops in 6.5), `admin.tsx` → `admin/index.tsx`.
- `videos/` module mounted last in `app.ts`.
- Co-located `__tests__/` move with their handlers.

#### 6.3 Site module — root and well-known files

- `GET /` — minimal landing (one line + link to admin) OR 302 to `/admin`. Pick one in implementation; both are fine.
- `GET /robots.txt` — `User-agent: *\nDisallow: /admin\n`.
- `GET /favicon.ico` — placeholder until brand work.
- `GET /sitemap.xml` — empty stub; populated in Phase 7.
- All served from `site/` module, no auth.

#### 6.4 Slug-namespaced viewer routes

Additive: existing `/v/:slug` keeps working through 6.6.

- `/:slug` — HTML video page. Port from `playback.tsx`. Goes through `resolveSlug` → 301 if redirect.
- `/:slug/embed` — chromeless `<media-player>` only (full UX is Phase 7).
- `/:slug/raw/:file` — serves `derivatives/<file>` from disk with HTTP Range. Filename allowlist (`source.mp4`, future `*.mp4`) prevents traversal and arbitrary derivative reads.
- `/:slug/stream/:file` — serves `init.mp4`, `seg_NNN.m4s`, `stream.m3u8` from disk with HTTP Range. Same allowlist regex as the segment-upload route, plus `stream.m3u8`.
- `/:slug/poster.jpg` — serves `derivatives/thumbnail.jpg`. 404 until derivative lands.
- `/:slug.mp4` — 302 to `/:slug/raw/source.mp4` (or whichever raw is canonical at request time).
- `/:slug.json` — minimal `{ id, slug, title, description, durationSeconds, urls: { page, raw, hls, poster } }`. Phase 7 expands.
- `/:slug.md` — minimal Markdown stub: `# <title or slug>\n\n[Watch](url)\n`. Phase 7 expands.
- All routes go through the slug-with-redirect resolver. Range support reuses `parseRange` from current `static.ts`.

#### 6.5 Update viewer HTML to use slug-namespaced media URLs

- `VideoPage` `src` becomes `/:slug/raw/source.mp4` or `/:slug/stream/stream.m3u8` (same `hasMp4` check as today).
- `poster` becomes `/:slug/poster.jpg` when present.
- Drop the `/data/*` handler entirely. No client should reference `/data/` after this.

#### 6.6 Backward-compat redirects

- `/v/:slug` and `/v/:slug/*` → 301 → `/:slug` (and `/:slug/*`). Permanent. Document as "do not remove".
- macOS app's older `complete` responses and any cached client URLs use `/v/...`; the redirect catches them. The next phases fix the source.

#### 6.7 API: response envelope + error codes

- Success: resource or `{ ok: true }`. No new wrapper.
- Errors: always `{ error: "<message>", code: "<MACHINE_CODE>" }`. Add codes for current 4xx paths: `VIDEO_NOT_FOUND`, `INVALID_SEGMENT_FILENAME`, `VIDEO_ALREADY_COMPLETE` (new in 6.8), plus the existing 401 codes (`MISSING_AUTH_HEADER`, `MALFORMED_AUTH_HEADER`, `EMPTY_BEARER_TOKEN`, `INVALID_API_KEY`).
- Document the envelope in `server/CLAUDE.md`.
- Tests for shape on each error path.

#### 6.8 API: tighten DELETE

- `DELETE /api/videos/:id` returns **409 Conflict** with `code: "VIDEO_ALREADY_COMPLETE"` if status is `complete`.
- Allowed for `recording`, `healing`, `failed`. Hard delete behaviour preserved for those.
- Tests covering each status.

#### 6.9 API: beef up /api/health

- Return `{ ok: true, version: "<from package.json>", time: "<ISO>" }`.
- macOS app reachability check unchanged in shape — it already only looks at HTTP 200.

#### 6.10 API: PUBLIC_URL + full URL in complete

- Add `PUBLIC_URL` to `.env.example` (default constructed from `${HOST}:${PORT}` if unset).
- `POST /api/videos/:id/complete` response becomes `{ path, url, slug, missing }` where `path` is `/:slug` and `url` is the absolute URL.
- macOS app side: stop reconstructing the URL client-side — use `url` directly.

#### 6.11 API: GET /api/videos (list)

- Cursor-based pagination: `?limit=20&cursor=<id>`. Default limit 20, max 100.
- Returns `{ items: [...], nextCursor: string | null }`.
- Default excludes trashed; `?includeTrashed=1` opt-in (admin will use it; macOS app won't).
- Sort: `createdAt DESC`.
- Items are the same shape as `GET /api/videos/:id`.
- Tests: pagination boundaries, trashed exclusion, ordering.

#### 6.12 API: GET /api/videos/:id

- Returns `{ id, slug, status, visibility, title, description, durationSeconds, width, height, source, createdAt, updatedAt, completedAt, url, urls: { page, raw, hls, poster } }`.
- 404 + `VIDEO_NOT_FOUND` for unknown / trashed (do not leak existence of trashed videos).
- Tests.

#### 6.13 API: PATCH /api/videos/:id

- Patch type: `{ title?, description?, visibility? }`. No slug change here — that's an admin act (deferred to task-x5).
- Logs `title_changed` / `description_changed` / `visibility_changed` events as appropriate.
- Returns the updated resource (same shape as GET).
- This is the first route worth installing `zod` + `@hono/zod-validator` for (deferred from 3.6). Do it here — narrow patch shape, real user input. Wire the global `ConflictError → 409` mapping at the same time.
- Tests including validation rejection.

#### 6.14 macOS app: consume new contract

- `APIClient`: stop reconstructing video URLs; use `url` from the complete response.
- `RecordingCoordinator`: surface 409 (`VIDEO_ALREADY_COMPLETE`) distinctly from 404 if DELETE is ever attempted on a completed video (defensive; UI shouldn't allow it).
- No new UI features in this phase — just consume the new shape cleanly.

#### 6.15 Docs

- `server/CLAUDE.md`: new sections for module layout, slug constraints, response envelope + error codes, `PUBLIC_URL`, `/api/*` reference table.
- `docs/developer/streaming-and-healing.md`: `/data/*` references replaced with `/:slug/stream/*` and `/:slug/raw/*`. URL examples updated to the rootless slug.
- `AGENTS.md`: project-tree update for the new `routes/` layout.

### Out of scope (deliberately)

- **URL versioning** (`/api/v1/*`). Single controlled client; additive evolution suffices until forced otherwise.
- **`Idempotency-Key` header on `POST /api/videos`.** Add when the bug shows up, not before.
- **Client metadata at create-time** (`device`, `appVersion`, etc.). Cheap to add later when there's a real use case (debugging, analytics).
- **Resumable single-file upload** (`PUT /api/videos/:id/source` with `Content-Range`) for the future `source: "uploaded"` flow. Build with the feature, not before.
- **Tag CRUD, trash/restore, bulk operations** on `/api/*`. These belong on `/admin/api/*` in task-x5. Resist the urge to put them on the public surface.
- **Admin panel functionality.** Module mount + auth shape only. Real CRUD UI, session auth, `/admin/api/*` endpoints all happen in task-x5.
- **Real viewer-page quality** (HTML, OG tags, SEO, embed UX, full JSON/MD content). Phase 7. This phase only ensures the routes exist with reasonable stubs.


## Phase 7 - Improve viewer-facing video page

NOTE: We may eventually replicate these endpoints using CloudFlare Workers, but In the spirit of iterative development, I would like to start by serving them from our Honno app.

### `/:slug`

The HTML page which renders the video player

- Serve a performant & accessible HTML page with the correct SEO, metadata, OG tags/images etc.
- Suitably render the title and other video metadata, and a little link to my website etc.
- Minimal but on-brand CSS styling
- Player is as good and properly configured as it can be

### `/:slug/embed`

Serves the HTML Video player with no padding or other chrome. Intended for use in iframes.

### `/:slug.mp4`

Serves the `source.mp4` directly with appropriate headers.

### `/:slug.json`

Serves a JSON representation of the video data including the URLs above. Intended for programmatic and LLM consumption.

### `/:slug.md`

Serves a Markdown representation of the video data including the URLs above. This will be a very sparse markdown file for videos which do not have a title, description, transcription etc. But that's fine. We're including it here so that further down the line when we are generating titles, descriptions, transcriptions, this endpoint & template is already here. 

## Phase 8 - Full Review of Serverside App

And finally, let's conduct a full comprehensive review of all of the server side code. Let's clean up anything that needs cleaning, do any re-architecting, analyze and review it for code quality, architectural quality, and best practices, as well as any obvious issues with performance etc.
