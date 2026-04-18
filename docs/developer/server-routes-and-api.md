# Server Routes & API

Complete reference for every route the Hono server exposes. For how segments flow end-to-end during a recording, see `streaming-and-healing.md`. For the auth system, see `auth.md`.

## Route modules

The server is split into four route modules, each with its own auth profile:

| Module | Mount | Auth | Purpose |
|--------|-------|------|---------|
| `api` | `/api` | Bearer on `/api/videos/*`; `/api/health` open | JSON API for macOS app + programmatic clients |
| `admin` | `/admin` | Session-based (stub — task-x5) | Admin panel |
| `site` | `/` | Open | Root landing, well-known files |
| `videos` | `/` (last) | Open | Viewer-facing `/:slug` surface, catch-all |

Modules are mounted in the order above in `app.ts`. The `videos` module is deliberately last since its `/:slug` catch-all would swallow anything more specific if it went first. In practice Hono's trie router matches by specificity regardless of mount order, but the ordering documents intent.

`/static/*` is served via `serveStatic` middleware directly in `app.ts` (not a route module). It serves `server/public/` — CSS, fonts, future client assets.

## Response envelope

**Success**: the resource directly (e.g. `{ id, slug, ... }`), or `{ ok: true }` for action endpoints with no meaningful return value.

**Error**: always `{ error: "<human message>", code: "<MACHINE_CODE>" }`. Error codes are defined in `src/lib/errors.ts`; use the `apiError(c, status, message, code)` helper to build error responses.

Error codes:

| Code | Status | When |
|------|--------|------|
| `MISSING_AUTH_HEADER` | 401 | No `Authorization` header |
| `MALFORMED_AUTH_HEADER` | 401 | Not `Bearer <token>` format |
| `EMPTY_BEARER_TOKEN` | 401 | `Bearer` present but token is empty |
| `INVALID_API_KEY` | 401 | Token unknown or revoked |
| `VIDEO_NOT_FOUND` | 404 | Unknown or trashed video |
| `INVALID_SEGMENT_FILENAME` | 400 | Filename doesn't match the allowlist |
| `VIDEO_ALREADY_COMPLETE` | 409 | DELETE attempted on a completed video |
| `VALIDATION_ERROR` | 400 | Request body fails zod schema validation |
| `CONFLICT` | 409 | Store-level conflict (e.g. slug collision) |

All 401 responses include `WWW-Authenticate: Bearer realm="loom-clone"`.

## Slug constraints

Slugs are the public identifier for videos. They appear in every viewer-facing URL and must satisfy:

- **Regex**: `^[a-z0-9](-?[a-z0-9])*$` — lowercase alphanumeric with single dashes, no dots, no slashes, no leading/trailing/double dashes.
- **Max length**: 64 characters.
- **Reserved words**: `admin`, `api`, `static`, `data`, `v`, `robots`, `favicon`, `sitemap`, `humans`, `manifest`, `apple-touch-icon`, `health`, `login`, `logout`, `auth`, `signup`, `embed`, `raw`, `stream`, `poster`, `feed`, `rss`, `search`. Attempting to create or rename to a reserved slug returns 409.
- **Globally unique**: a slug cannot match any current video's slug OR any entry in the `slug_redirects` table. This ensures old URLs never silently resolve to the wrong video.

Validation happens at write time in `lib/store.ts` via `validateSlugFormat()`. Auto-generated slugs (8-char hex from `createVideo()`) always satisfy these constraints.

## API routes (`/api/*`)

All `/api/videos/*` routes require a bearer token. `/api/health` is deliberately open.

### `GET /api/health`

Server reachability check. Used by the macOS app to gate the Record button.

**Auth**: none.

**Response** `200`:
```json
{ "ok": true, "version": "0.0.1", "time": "2026-04-17T12:00:00.000Z" }
```

### `GET /api/videos`

List all videos, newest first. Cursor-paginated.

**Query params**:
- `limit` — items per page (default 20, max 100)
- `cursor` — id of the last video from the previous page
- `includeTrashed` — `1` to include trashed videos (default: excluded)

**Response** `200`:
```json
{
  "items": [{ /* video shape — see GET /api/videos/:id */ }],
  "nextCursor": "uuid-of-last-item | null"
}
```

### `POST /api/videos`

Create a new video record. Called when the user hits Record.

**Response** `200`:
```json
{ "id": "uuid", "slug": "a1b2c3d4" }
```

### `GET /api/videos/:id`

Single video by id.

**Response** `200`:
```json
{
  "id": "uuid",
  "slug": "a1b2c3d4",
  "status": "recording | healing | complete | failed",
  "visibility": "public | unlisted | private",
  "title": "string | null",
  "description": "string | null",
  "durationSeconds": 42.5,
  "width": null,
  "height": null,
  "source": "recorded | uploaded",
  "createdAt": "ISO",
  "updatedAt": "ISO",
  "completedAt": "ISO | null",
  "url": "https://loom.example.com/a1b2c3d4",
  "urls": {
    "page": "/a1b2c3d4",
    "raw": "/a1b2c3d4/raw/source.mp4",
    "hls": "/a1b2c3d4/stream/stream.m3u8",
    "poster": "/a1b2c3d4/poster.jpg"
  }
}
```

**Error** `404`: `VIDEO_NOT_FOUND`

### `PATCH /api/videos/:id`

Edit title, description, or visibility. Returns the updated video (same shape as GET). Zod-validated.

**Request body**:
```json
{
  "title": "string | null",
  "description": "string | null",
  "visibility": "public | unlisted | private"
}
```

All fields are optional. Only provided fields are updated; omitted fields are left unchanged.

**Error** `400`: `VALIDATION_ERROR` (invalid body) | `404`: `VIDEO_NOT_FOUND`

### `PUT /api/videos/:id/segments/:filename`

Upload a segment during recording. Idempotent — re-uploading the same filename overwrites cleanly.

**Filename allowlist**: `init.mp4` or `seg_NNN.m4s`. Anything else returns 400.

**Headers**: `x-segment-duration` — duration in seconds (e.g. `4.0`). Falls back to 4s default if missing or unparseable.

**Body**: raw bytes.

**Response** `200`: `{ "ok": true }`

**Errors**: `400` `INVALID_SEGMENT_FILENAME` | `404` `VIDEO_NOT_FOUND`

### `POST /api/videos/:id/complete`

Finalise a recording. Idempotent — safe to call repeatedly as heal progresses.

**Request body** (optional): `{ "timeline": { ... } }` — the client's recording timeline. Used to diff expected vs on-disk segments and populate `missing`.

**Response** `200`:
```json
{
  "path": "/a1b2c3d4",
  "url": "https://loom.example.com/a1b2c3d4",
  "slug": "a1b2c3d4",
  "missing": ["seg_002.m4s", "seg_003.m4s"]
}
```

`url` is the absolute URL for the clipboard. `path` is the path-only form. `missing` is empty when the server has all segments.

**Error** `404`: `VIDEO_NOT_FOUND`

### `DELETE /api/videos/:id`

Cancel/delete a recording. Only works for non-complete videos.

**Response** `200`: `{ "ok": true }`

**Errors**: `404` `VIDEO_NOT_FOUND` | `409` `VIDEO_ALREADY_COMPLETE`

## Viewer routes (`/:slug`)

All viewer routes are open (no auth). Renamed slugs 301-redirect to the canonical slug via the `slug_redirects` table. Trashed videos return 404.

### `/:slug`

HTML video page. Prefers the MP4 derivative (`/:slug/raw/source.mp4`) when present; falls back to HLS (`/:slug/stream/stream.m3u8`). Poster set from `/:slug/poster.jpg` when available. Uses Vidstack player (CDN-hosted for now).

### `/:slug/embed`

Chromeless player for iframe embeds. Same MP4-vs-HLS selection, no page chrome.

### `/:slug/raw/:file`

MP4 video variants with HTTP Range support. Serves from `data/<id>/derivatives/<file>`.

**Filename allowlist**: `source.mp4`, `<N>p.mp4` (e.g. `720p.mp4`, `1080p.mp4`). Today only `source.mp4` exists; resolution variants are a future derivative.

### `/:slug/stream/:file`

HLS playlist and segments with HTTP Range support. Serves from `data/<id>/<file>`.

**Filename allowlist**: `stream.m3u8`, `init.mp4`, `seg_NNN.m4s`.

The playlist uses relative segment URLs, so the player resolves `seg_001.m4s` relative to the playlist URL (`/:slug/stream/seg_001.m4s`) without any rewriting.

### `/:slug/poster.jpg`

Video thumbnail. Serves `data/<id>/derivatives/thumbnail.jpg`. Returns 404 until the derivative has been generated.

### `/:slug.mp4`

Convenience redirect. **302** to `/:slug/raw/source.mp4`. 302 (not 301) because the canonical "default raw" may change as new resolution variants are added.

### `/:slug.json`

JSON metadata for programmatic/LLM consumption. Includes `id`, `slug`, `title`, `description`, `durationSeconds`, and a `urls` bundle.

### `/:slug.md`

Markdown metadata. Includes heading (title or slug), description if set, and a watch link. Intended for embedding in documentation, Notion, etc.

## Back-compat redirects

`/v/:slug` and `/v/:slug/*` permanently 301-redirect to `/:slug` (and `/:slug/*`). These routes must not be removed — existing shared URLs, bookmarks, and older macOS app versions reference the `/v/` path.

## Site routes

| Path | Response |
|------|----------|
| `/` | Minimal HTML landing page |
| `/robots.txt` | Disallows `/admin` and `/api` |
| `/favicon.ico` | 204 No Content (placeholder) |
| `/sitemap.xml` | Empty stub (Phase 7 populates from DB) |

## Admin routes

| Path | Response |
|------|----------|
| `/admin` | HTML stub (`AdminLayout` placeholder). Real admin UI is task-x5 |

## Content types

| Extension | Content-Type | Used by |
|-----------|-------------|---------|
| `.m3u8` | `application/vnd.apple.mpegurl` | HLS playlist |
| `.m4s` | `video/iso.segment` | HLS media segments |
| `.mp4` | `video/mp4` | init segment, derivatives |
| `.jpg` | `image/jpeg` | poster/thumbnail |
| `.json` | `application/json` | API responses, /:slug.json |
| `.md` | `text/markdown` | /:slug.md |

## Range support

All media routes (`/:slug/raw/*`, `/:slug/stream/*`, `/:slug/poster.jpg`) support HTTP Range requests for video seeking:

- `Accept-Ranges: bytes` is always emitted.
- Single-range `Range: bytes=N-M` requests return `206 Partial Content` with `Content-Range`.
- Invalid or unsatisfiable ranges return `416 Range Not Satisfiable`.
- Multi-range requests are not supported (single-range covers browser seeking).

The Range-aware file serving logic lives in `src/lib/file-serve.ts`.

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `HOST` | `127.0.0.1` | Server bind address |
| `PORT` | `3000` | Server port |
| `PUBLIC_URL` | `http://${HOST}:${PORT}` | Base URL for absolute URLs in API responses |

See `.env.example` for documentation and defaults.

## Where the code lives

| Concern | File |
|---------|------|
| App factory + module mounting | `src/app.ts` |
| API module (health + videos) | `src/routes/api/index.ts` |
| Video CRUD routes | `src/routes/api/videos.ts` |
| Admin stub | `src/routes/admin/index.tsx` |
| Site (root, well-known) | `src/routes/site/well-known.tsx` |
| Viewer HTML page | `src/routes/videos/page.tsx` |
| Embed page | `src/routes/videos/embed.tsx` |
| Media serving (raw, stream, poster, .mp4) | `src/routes/videos/media.ts` |
| Metadata (.json, .md) | `src/routes/videos/metadata.ts` |
| Videos module aggregator | `src/routes/videos/index.ts` |
| Error codes + helper | `src/lib/errors.ts` |
| Range-aware file serving | `src/lib/file-serve.ts` |
| URL builders | `src/lib/url.ts` |
| Auth middleware | `src/lib/auth.ts` |
| Slug validation + store | `src/lib/store.ts` |
