# Server Routes & API

Complete reference for every route the Hono server exposes. For how segments flow end-to-end during a recording, see `streaming-and-healing.md`. For the auth system, see `auth.md`.

## Route modules

The server is split into four route modules, each with its own auth profile:

| Module   | Mount      | Auth                                          | Purpose                                          |
| -------- | ---------- | --------------------------------------------- | ------------------------------------------------ |
| `api`    | `/api`     | Bearer on `/api/videos/*`; `/api/health` open | JSON API for macOS app + programmatic clients    |
| `admin`  | `/admin`   | Session cookie or `lca_` bearer token         | Admin panel (HTML pages + HTMX partials)         |
| `site`   | `/`        | Open                                          | Root landing, well-known files, oEmbed discovery |
| `videos` | `/` (last) | Open                                          | Viewer-facing `/:slug` surface, catch-all        |

Modules are mounted in the order above in `app.ts`. The `videos` module is deliberately last since its `/:slug` catch-all would swallow anything more specific if it went first. In practice Hono's trie router matches by specificity regardless of mount order, but the ordering documents intent.

`/static/*` is served via `serveStatic` middleware directly in `app.ts` (not a route module). It serves `server/public/` — CSS, fonts, future client assets.

## Response envelope

**Success**: the resource directly (e.g. `{ id, slug, ... }`), or `{ ok: true }` for action endpoints with no meaningful return value.

**Error**: always `{ error: "<human message>", code: "<MACHINE_CODE>" }`. Error codes are defined in `src/lib/errors.ts`; use the `apiError(c, status, message, code)` helper to build error responses.

Error codes:

| Code                       | Status | When                                       |
| -------------------------- | ------ | ------------------------------------------ |
| `MISSING_AUTH_HEADER`      | 401    | No `Authorization` header                  |
| `MALFORMED_AUTH_HEADER`    | 401    | Not `Bearer <token>` format                |
| `EMPTY_BEARER_TOKEN`       | 401    | `Bearer` present but token is empty        |
| `INVALID_API_KEY`          | 401    | Token unknown or revoked                   |
| `VIDEO_NOT_FOUND`          | 404    | Unknown or trashed video                   |
| `INVALID_SEGMENT_FILENAME` | 400    | Filename doesn't match the allowlist       |
| `VIDEO_ALREADY_COMPLETE`   | 409    | DELETE attempted on a completed video      |
| `VALIDATION_ERROR`         | 400    | Request body fails zod schema validation   |
| `SLUG_CONFLICT`            | 409    | Slug already in use by another video/redirect |
| `CONFLICT`                 | 409    | Store-level conflict (generic)             |

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
  "width": 1920,
  "height": 1080,
  "aspectRatio": 1.7778,
  "fileBytes": 17000000,
  "cameraName": "FaceTime HD Camera",
  "microphoneName": "MacBook Pro Microphone",
  "recordingHealth": "null | gpu_wobble | terminal_failure",
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

Edit title, description, visibility, or slug. Returns the updated video (same shape as GET). Zod-validated.

**Request body**:
```json
{
  "title": "string | null",
  "description": "string | null",
  "visibility": "public | unlisted | private",
  "slug": "string"
}
```

All fields are optional. Only provided fields are updated; omitted fields are left unchanged. Slug changes create a redirect from the old slug so existing URLs continue to work.

**Errors**: `400` `VALIDATION_ERROR` (invalid body or slug format) | `404` `VIDEO_NOT_FOUND` | `409` `SLUG_CONFLICT` (slug already taken)

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
  "title": null,
  "visibility": "unlisted",
  "missing": ["seg_002.m4s", "seg_003.m4s"]
}
```

`url` is the absolute URL for the clipboard. `path` is the path-only form. `title` and `visibility` reflect the video's current metadata (used by the macOS app's post-recording editor). `missing` is empty when the server has all segments.

**Error** `404`: `VIDEO_NOT_FOUND`

### `PUT /api/videos/:id/transcript`

Upload a transcript (SRT or VTT). Idempotent — re-uploading replaces the file and re-indexes.

**Body**: raw SRT or VTT text. 5 MB limit.

**Content-Type**: `application/x-subrip` for SRT, `text/vtt` for VTT. Auto-detected from body prefix if header is ambiguous.

**Response** `200`: `{ "ok": true }`

**Errors**: `400` `VALIDATION_ERROR` (empty body) | `404` `VIDEO_NOT_FOUND`

**Side effects**: writes `data/<id>/derivatives/captions.srt` (or `.vtt`), parses to plain text, upserts into `video_transcripts` table + FTS index, logs `transcript_uploaded` event.

### `DELETE /api/videos/:id`

Cancel/delete a recording. Only works for non-complete videos.

**Response** `200`: `{ "ok": true }`

**Errors**: `404` `VIDEO_NOT_FOUND` | `409` `VIDEO_ALREADY_COMPLETE`

## Viewer routes (`/:slug`)

All viewer routes are open (no auth). Renamed slugs 301-redirect to the canonical slug via the `slug_redirects` table. Trashed videos return 404.

### `/:slug`

HTML video page. Prefers the MP4 derivative (`/:slug/raw/source.mp4`) when present; falls back to HLS (`/:slug/stream/stream.m3u8`). Poster set from `/:slug/poster.jpg` when available. Captions included via `<track>` element when `captions.srt` exists. Uses Vidstack player (CDN-hosted via jsDelivr).

Includes below the player: title (if set), formatted duration + date, description, and attribution link.

**SEO/meta**: canonical link, `og:title`, `og:description`, `og:image`, `og:video` (embed URL), `og:type=video.other`, Twitter Card (`player` type), and oEmbed discovery `<link>`. Unlisted videos get `<meta name="robots" content="noindex">` and `X-Robots-Tag: noindex` header.

### `/:slug/embed`

Chromeless player for iframe embeds. Same MP4-vs-HLS selection, no page chrome. Full-viewport dark background. Used by the oEmbed `html` field and OG/Twitter player tags.

### `/:slug/raw/:file`

MP4 video variants with HTTP Range support. Serves from `data/<id>/derivatives/<file>`.

**Filename allowlist**: `source.mp4`, `<N>p.mp4` (e.g. `720p.mp4`, `1080p.mp4`).

### `/:slug/stream/:file`

HLS playlist and segments with HTTP Range support. Serves from `data/<id>/<file>`.

**Filename allowlist**: `stream.m3u8`, `init.mp4`, `seg_NNN.m4s`.

The playlist uses relative segment URLs, so the player resolves `seg_001.m4s` relative to the playlist URL (`/:slug/stream/seg_001.m4s`) without any rewriting.

### `/:slug/poster.jpg`

Video thumbnail. Serves `data/<id>/derivatives/thumbnail.jpg`. Returns 404 until the derivative has been generated.

### `/:slug/storyboard.jpg`

Sprite sheet for scrubber hover previews. Serves `data/<id>/derivatives/storyboard.jpg`. Only generated for videos ≥ 60s. Returns 404 for shorter videos.

### `/:slug/storyboard.vtt`

WebVTT file mapping time ranges to regions in the sprite sheet via `#xywh=` spatial fragments. Vidstack uses this via the `thumbnails` attribute on `<media-video-layout>`.

### `/:slug/captions.srt`

SRT transcript/subtitles. Serves `data/<id>/derivatives/captions.srt`. Returns 404 until a transcript has been uploaded. `Content-Type: application/x-subrip`. Cached for 1 hour.

### `/:slug/captions.vtt`

VTT variant of the transcript, if the original upload was VTT format. Same behaviour as the SRT route. `Content-Type: text/vtt`.

### `/:slug.mp4`

Convenience redirect. **302** to `/:slug/raw/source.mp4`. 302 (not 301) because the canonical "default raw" may change as new resolution variants are added.

### `/:slug.json`

JSON metadata for programmatic/LLM consumption. All URLs are absolute.

```json
{
  "id": "uuid", "slug": "...", "status": "...", "visibility": "...",
  "title": "...", "description": "...", "durationSeconds": 42.5,
  "durationFormatted": "42s", "source": "recorded",
  "transcript": "Plain text transcript or null",
  "createdAt": "ISO", "updatedAt": "ISO", "completedAt": "ISO",
  "url": "https://example.com/my-slug",
  "urls": { "page", "raw", "hls", "poster", "embed", "json", "md", "mp4" }
}
```

### `/:slug.md`

Markdown metadata. Includes heading (title or slug), description, formatted duration + date, watch link, and a "Links" section with bulleted URLs (page, MP4 download, embed, JSON). Includes a "Transcript" section with the full plain text when a transcript exists. All URLs absolute.

## Back-compat redirects

`/v/:slug` and `/v/:slug/*` permanently 301-redirect to `/:slug` (and `/:slug/*`). These routes must not be removed — existing shared URLs, bookmarks, and older macOS app versions reference the `/v/` path.

## Site routes

| Path           | Response                                                                             |
| -------------- | ------------------------------------------------------------------------------------ |
| `/`            | Minimal HTML landing page                                                            |
| `/robots.txt`  | Disallows `/admin` and `/api`                                                        |
| `/favicon.ico` | 204 No Content (placeholder)                                                         |
| `/sitemap.xml` | Video sitemap (public + complete + non-trashed only, with `<video:video>` extension) |

### `GET /oembed`

oEmbed discovery endpoint. Open, no auth. Services (Notion, WordPress, Slack) call this to get an iframe embed code for a video URL. The discovery `<link>` tag on `/:slug` pages points here.

**Query params**:
- `url` (required) — the video page URL (path-only or absolute)
- `format` — only `json` is supported (default)
- `maxwidth`, `maxheight` — clamp iframe dimensions (default 1280x720, maintains 16:9)

**Response** `200`:
```json
{
  "version": "1.0",
  "type": "video",
  "title": "...",
  "author_name": "Danny Smith",
  "provider_name": "loom-clone",
  "provider_url": "https://example.com",
  "html": "<iframe src=\".../embed\" ...></iframe>",
  "width": 640, "height": 360,
  "thumbnail_url": "https://example.com/.../poster.jpg",
  "thumbnail_width": 640, "thumbnail_height": 360
}
```

**Errors**: `400` (missing url param) | `404` (unknown video)

## Admin routes

Auth: session cookie (`lc_session`, signed, 2-week expiry) or `Authorization: Bearer lca_...` admin token. All routes except `GET/POST /admin/login` require auth. CSRF protection on all mutations.

When `ADMIN_PASSWORD` env var is not set, auth is bypassed (dev mode).

### Pages (full HTML, hx-boost navigation)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/admin` | Dashboard — video list with search, filters, sort, pagination |
| GET | `/admin/login` | Login page |
| POST | `/admin/login` | Authenticate (sets session cookie, redirects to `/admin`) |
| POST | `/admin/logout` | Clear session, redirect to login |
| GET | `/admin/videos/:id` | Video detail — player, metadata, tabs (events, files, transcript) |
| GET | `/admin/upload` | Upload form |
| POST | `/admin/upload` | Upload MP4, create video, redirect to detail page |
| GET | `/admin/settings` | Settings — General pane |
| GET | `/admin/settings/tags` | Settings — Tags pane |
| GET | `/admin/settings/keys` | Settings — API Keys pane |
| GET | `/admin/trash` | Trash bin — trashed videos with restore |

### HTMX partials (HTML fragments for in-page updates)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/admin/partials/video-list` | Filtered/sorted video list (search, pagination) |
| GET | `/admin/videos/:id/partials/title` | Title display partial |
| GET | `/admin/videos/:id/partials/title/edit` | Title edit form |
| PATCH | `/admin/videos/:id/title` | Save title |
| GET | `/admin/videos/:id/partials/slug` | Slug display partial |
| GET | `/admin/videos/:id/partials/slug/edit` | Slug edit form |
| PATCH | `/admin/videos/:id/slug` | Save slug (creates redirect) |
| GET | `/admin/videos/:id/partials/description` | Description display partial |
| GET | `/admin/videos/:id/partials/description/edit` | Description edit form |
| PATCH | `/admin/videos/:id/description` | Save description |
| PATCH | `/admin/videos/:id/visibility` | Change visibility |
| POST | `/admin/videos/:id/tags` | Add tag to video |
| DELETE | `/admin/videos/:id/tags/:tagId` | Remove tag from video |

### Thumbnail picker

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/admin/videos/:id/partials/thumbnails` | Thumbnail picker partial |
| POST | `/admin/videos/:id/thumbnail/promote` | Promote a candidate to active thumbnail |
| POST | `/admin/videos/:id/thumbnail/upload` | Upload custom JPEG, auto-promotes |

### Video actions

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/admin/videos/:id/trash` | Soft-delete, redirect to dashboard |
| POST | `/admin/videos/:id/untrash` | Restore, redirect to video detail |
| POST | `/admin/videos/:id/duplicate` | Full copy (files + DB), redirect to duplicate |

### Admin media (session-gated, serves by video ID regardless of visibility)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/admin/videos/:id/media/raw/:file` | MP4 derivatives (source.mp4, Np.mp4) |
| GET | `/admin/videos/:id/media/stream/:file` | HLS files (stream.m3u8, init.mp4, seg_*.m4s) |
| GET | `/admin/videos/:id/media/poster.jpg` | Thumbnail |
| GET | `/admin/videos/:id/media/thumbnail-candidates/:file` | Thumbnail candidate images |

### Settings mutations

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/admin/settings/tags` | Create tag |
| GET | `/admin/settings/tags/:id/edit` | Tag edit form partial |
| GET | `/admin/settings/tags/:id/display` | Tag display partial |
| PATCH | `/admin/settings/tags/:id` | Update tag name/color |
| DELETE | `/admin/settings/tags/:id` | Delete tag |
| POST | `/admin/settings/keys` | Create API key (shows token once) |
| POST | `/admin/settings/keys/:id/revoke` | Revoke API key |

## Content types

| Extension | Content-Type                    | Used by                    |
| --------- | ------------------------------- | -------------------------- |
| `.m3u8`   | `application/vnd.apple.mpegurl` | HLS playlist               |
| `.m4s`    | `video/iso.segment`             | HLS media segments         |
| `.mp4`    | `video/mp4`                     | init segment, derivatives  |
| `.jpg`    | `image/jpeg`                    | poster/thumbnail           |
| `.json`   | `application/json`              | API responses, /:slug.json |
| `.vtt`    | `text/vtt`                      | storyboard.vtt, captions.vtt |
| `.srt`    | `application/x-subrip`          | captions.srt               |
| `.md`     | `text/markdown`                 | /:slug.md                  |

## Range support

All media routes (`/:slug/raw/*`, `/:slug/stream/*`, `/:slug/poster.jpg`) support HTTP Range requests for video seeking:

- `Accept-Ranges: bytes` is always emitted.
- Single-range `Range: bytes=N-M` requests return `206 Partial Content` with `Content-Range`.
- Invalid or unsatisfiable ranges return `416 Range Not Satisfiable`.
- Multi-range requests are not supported (single-range covers browser seeking).

The Range-aware file serving logic lives in `src/lib/file-serve.ts`.

## Environment variables

| Variable         | Default                  | Purpose                                                     |
| ---------------- | ------------------------ | ----------------------------------------------------------- |
| `HOST`           | `127.0.0.1`              | Server bind address                                         |
| `PORT`           | `3000`                   | Server port                                                 |
| `PUBLIC_URL`     | `http://${HOST}:${PORT}` | Base URL for absolute URLs in API responses                 |
| `ADMIN_PASSWORD` | *(unset)*                | Admin login password. When unset, admin auth is bypassed.   |
| `ADMIN_USERNAME` | `admin`                  | Admin login username.                                       |
| `SESSION_SECRET` | *(unset)*                | HMAC key for session cookies. Required with `ADMIN_PASSWORD`.|

See `.env.example` for documentation and defaults.

## Where the code lives

| Concern                                   | File                             |
| ----------------------------------------- | -------------------------------- |
| App factory + module mounting             | `src/app.ts`                     |
| API module (health + videos)              | `src/routes/api/index.ts`        |
| Video CRUD routes                         | `src/routes/api/videos.ts`       |
| Admin module (routes, auth, CSRF)         | `src/routes/admin/index.tsx`     |
| Site (root, well-known)                   | `src/routes/site/well-known.tsx` |
| oEmbed endpoint                           | `src/routes/site/oembed.ts`      |
| Viewer HTML page                          | `src/routes/videos/page.tsx`     |
| Embed page                                | `src/routes/videos/embed.tsx`    |
| Viewer slug resolution + derivatives      | `src/routes/videos/resolve.ts`   |
| Media serving (raw, stream, poster, .mp4) | `src/routes/videos/media.ts`     |
| Metadata (.json, .md)                     | `src/routes/videos/metadata.ts`  |
| Videos module aggregator + /v/ redirects  | `src/routes/videos/index.ts`     |
| Error codes + helper                      | `src/lib/errors.ts`              |
| Range-aware file serving                  | `src/lib/file-serve.ts`          |
| URL builders                              | `src/lib/url.ts`                 |
| API key middleware                        | `src/lib/auth.ts`                |
| Admin auth (sessions, middleware)         | `src/lib/admin-auth.ts`          |
| Admin token CRUD                          | `src/lib/admin-tokens.ts`        |
| Slug validation + store                   | `src/lib/store.ts`               |
| Thumbnail candidates + admin picker       | `src/lib/thumbnails.ts`          |
| Storyboard sprite sheet + VTT            | `src/lib/storyboard.ts`          |
| Display formatting (duration, date)       | `src/lib/format.ts`              |
