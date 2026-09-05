# Server Routes & API

Complete reference for every route the Hono server exposes. For how segments flow end-to-end during a recording, see [Streaming & Healing](streaming-and-healing.md). For the auth system, see [Auth](auth.md).

## Route modules

The server is split into four route modules, each with its own auth profile:

| Module   | Mount      | Auth                                          | Purpose                                          |
| -------- | ---------- | --------------------------------------------- | ------------------------------------------------ |
| `api`    | `/api`     | Bearer on `/api/videos/*`; `/api/health` open | JSON API for macOS app + programmatic clients    |
| `admin`  | `/admin`   | Session cookie or `lca_` bearer token         | Admin panel (HTML pages + HTMX partials)         |
| `site`   | `/`        | Open                                          | Root redirect, well-known files, feeds (RSS/JSON/llms.txt), oEmbed |
| `videos` | `/` (last) | Open                                          | Viewer-facing `/:slug` surface, catch-all        |

Modules are mounted in the order above in `app.ts`, and the ordering matters: Hono does not prefer more specific routes across sub-router mounts, so `videos` must stay mounted last — mounted first, its `/:slug` catch-all swallows `/feed.xml`, `/robots.txt`, `/sitemap.xml`, etc. A test in `src/__tests__/app.test.ts` pins this.

`/static/*` is served via `serveStatic` middleware directly in `app.ts` (not a route module). It serves `server/public/` — CSS, fonts, future client assets.

## Response envelope

**Success**: the resource directly (e.g. `{ id, slug, ... }`), or `{ ok: true }` for action endpoints with no meaningful return value.

**Error**: always `{ error: "<human message>", code: "<MACHINE_CODE>" }`. Error codes are defined in `src/lib/errors.ts` (except `CONFLICT`, which is emitted inline by the api module's `onError` handler in `routes/api/index.ts`); use the `apiError(c, status, message, code)` helper to build error responses.

Error codes:

| Code                       | Status | When                                       |
| -------------------------- | ------ | ------------------------------------------ |
| `MISSING_AUTH_HEADER`      | 401    | No `Authorization` header                  |
| `MALFORMED_AUTH_HEADER`    | 401    | Not `Bearer <token>` format                |
| `EMPTY_BEARER_TOKEN`       | 401    | `Bearer` present but token is empty        |
| `INVALID_API_KEY`          | 401    | Token unknown or revoked                   |
| `VIDEO_NOT_FOUND`          | 404    | Unknown or trashed video                   |
| `INVALID_SEGMENT_FILENAME` | 400    | Filename doesn't match the allowlist       |
| `VIDEO_NOT_DELETABLE`      | 409    | DELETE attempted on a ready / processing / reprocessing video |
| `VALIDATION_ERROR`         | 400    | Request body fails zod schema validation   |
| `SLUG_CONFLICT`            | 409    | Slug already in use by another video/redirect |
| `CONFLICT`                 | 409    | Store-level conflict (generic)             |

All 401 responses include `WWW-Authenticate: Bearer realm="loom-clone"`.

## Slug constraints

Slugs are the public identifier for videos. They appear in every viewer-facing URL and must satisfy:

- **Regex**: `^[a-z0-9](-?[a-z0-9])*$` — lowercase alphanumeric with single dashes, no dots, no slashes, no leading/trailing/double dashes.
- **Max length**: 200 characters.
- **Reserved words**: `admin`, `api`, `static`, `data`, `v`, `robots`, `favicon`, `sitemap`, `humans`, `manifest`, `apple-touch-icon`, `health`, `login`, `logout`, `auth`, `signup`, `embed`, `raw`, `stream`, `poster`, `feed`, `rss`, `search`. Attempting to create or rename to a reserved slug returns 409.
- **Globally unique**: a slug cannot match any current video's slug OR any entry in the `slug_redirects` table. Exception: a video can reclaim its own previous slug (the redirect pointing back to itself is removed). This ensures old URLs never silently resolve to the wrong video.

Validation happens at write time in `lib/store.ts` via `validateSlugFormat()`. Auto-generated slugs (3-word adjective-noun-verb from `human-id`, e.g. `calm-dogs-dream`) always satisfy these constraints.

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
  "status": "recording | healing | processing | ready | reprocessing | processing_failed | incomplete | deleting",
  "visibility": "public | unlisted | private",
  "title": "string | null",
  "description": "string | null",
  "durationSeconds": 42.5,
  "width": 1920,
  "height": 1080,
  "source": "recorded | uploaded",
  "createdAt": "ISO",
  "updatedAt": "ISO",
  "completedAt": "ISO | null",
  "url": "https://loom.example.com/a1b2c3d4",
  "urls": {
    "page": "/a1b2c3d4",
    "raw": "/a1b2c3d4/raw/video.mp4",
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

When `missing` is empty the video moves to `status: "processing"` and the post-processing pipeline is scheduled (it reaches `ready` once `source.mp4` + metadata validate — MP4 serving waits for the presentation master, which lands shortly after); otherwise it moves to `"healing"`. Both branches are idempotent: a video already in `processing`/`ready`/`reprocessing` is never demoted (in particular, a replayed `/complete` after the 10-day HLS cleanup — where every segment reads as missing — leaves a `ready` video alone). There is no `"complete"` status.

**Errors**: `400` `VALIDATION_ERROR` (unparseable `application/json` body) | `404` `VIDEO_NOT_FOUND`

### `PUT /api/videos/:id/transcript`

Upload a transcript (SRT or VTT). Idempotent — re-uploading replaces the file and re-indexes.

**Body**: raw SRT or VTT text. 5 MB limit.

**Content-Type**: `application/x-subrip` for SRT, `text/vtt` for VTT. Auto-detected from body prefix if header is ambiguous.

**Response** `200`: `{ "ok": true }`

**Errors**: `400` `VALIDATION_ERROR` (empty body) | `404` `VIDEO_NOT_FOUND`

**Side effects**: writes `data/<id>/derivatives/captions.original.srt` (or `.vtt`) — the transcript verbatim, never modified — parses to plain text, upserts into `video_transcripts` + FTS, logs `transcript_uploaded`, and schedules a `captions` run. The *served* `captions.srt` is produced by that step, not written here: on an edited video the transcript describes the uncut timeline, so writing it straight through would silently desync a viewer's subtitles. An upload in the other format supersedes the stored original rather than sitting alongside it.

### `PUT /api/videos/:id/words`

Upload word-level timestamps (JSON array from WhisperKit), used by the admin editor for word-level cutting. Idempotent — re-uploading replaces.

**Body**: raw JSON array. 10 MB limit.

**Content-Type**: `application/json` required — anything else returns `400` `VALIDATION_ERROR` ("Content-Type must be application/json"). Malformed JSON → `400` `VALIDATION_ERROR` ("Malformed JSON body"); a non-array or empty array → `400` `VALIDATION_ERROR` ("Expected non-empty JSON array").

**Response** `200`: `{ "ok": true }`

**Errors**: `400` `VALIDATION_ERROR` | `404` `VIDEO_NOT_FOUND`

**Side effects**: atomic write (tmp → rename) of `data/<id>/derivatives/words.json`, records external step `words`, logs `words_uploaded` event with `{ wordCount }`.

### `PUT /api/videos/:id/suggest-title`

Accept an AI-suggested title. Only applies if the video's title is still null (user hasn't manually set one). Idempotent — re-calling after a user edit is a silent no-op.

**Body**: `{ "title": "<string, 1-200 chars>" }`

**Content-Type**: `application/json`

**Response** `200`: `{ "applied": true }` if the title was set, `{ "applied": false }` if the video already had a user-set title.

**Errors**: `400` `VALIDATION_ERROR` (empty/missing title, over 200 chars) | `404` `VIDEO_NOT_FOUND`

**Side effects**: when applied, updates the video title (logs `title_changed` event via `updateVideo`). Always logs a `title_suggested` event with `{ title, applied }` data regardless of whether the title was applied.

### `PUT /api/videos/:id/suggest-description`

Accept an AI-suggested description. Only applies if the video's description is still null (user hasn't manually set one). Idempotent — re-calling after a user edit is a silent no-op.

**Body**: `{ "description": "<string, 1-2000 chars>" }`

**Content-Type**: `application/json`

**Response** `200`: `{ "applied": true }` if the description was set, `{ "applied": false }` if the video already had a user-set description.

**Errors**: `400` `VALIDATION_ERROR` (empty/missing description, over 2000 chars) | `404` `VIDEO_NOT_FOUND`

**Side effects**: when applied, updates the video description (logs `description_changed` event via `updateVideo`). Always logs a `description_suggested` event with `{ description, applied }` data regardless of whether the description was applied.

### `PUT /api/videos/:id/chapters/:chapterId/suggest-title`

Accept an AI-suggested title for a single chapter marker. Mirrors `/suggest-title` but targets one chapter inside `chapters.json`. Used by the Mac app after on-device transcription completes, once per chapter that was created during recording.

**Body**: `{ "title": "<string, 1-200 chars>" }`

**Content-Type**: `application/json`

**Response** `200`:
- `{ "applied": true }` — chapter found, title was null, title was set
- `{ "applied": false, "reason": "user_set" }` — chapter already has a title
- `{ "applied": false, "reason": "not_found" }` — chapter id does not exist in `chapters.json` (e.g. deleted via admin)
- `{ "applied": false, "reason": "no_chapters" }` — `chapters.json` does not exist for this video

**Errors**: `400` `VALIDATION_ERROR` (empty title, over 200 chars) | `404` `VIDEO_NOT_FOUND`

**Side effects**: when applied, rewrites `data/<id>/chapters.json` with the new title (sorted by `t` as usual). Always logs a `chapter_title_suggested` event with `{ chapterId, title, applied, reason? }` regardless of outcome.

### `DELETE /api/videos/:id`

Cancel/delete a recording. Refused for videos that are `ready`, `processing`, or `reprocessing` (a finished video, or one mid-pipeline that would be torn out from under ffmpeg).

**Response** `200`: `{ "ok": true }`

**Errors**: `404` `VIDEO_NOT_FOUND` | `409` `VIDEO_NOT_DELETABLE`

## Viewer routes (`/:slug`)

All viewer routes are open (no auth). Renamed slugs 301-redirect to the canonical slug via the `slug_redirects` table. Trashed videos return 404.

### `/:slug`

HTML video page. Prefers the presentation master (`/:slug/raw/<N>p.mp4`) when the `presentation` step is validated `ready` **and** the file is present; otherwise falls back to HLS (`/:slug/stream/stream.m3u8`) — so a broken or deleted master never gets served. Poster set from `/:slug/poster.jpg` when available. Captions included via `<track>` element when `captions.srt` exists. Uses the self-hosted Vidstack player — a committed bundle served from `/static/player/*`, with hashed filenames resolved via the Vite manifest in `src/lib/vite-manifest.ts`.

Includes below the player: title (if set), formatted duration + date, description, and attribution link.

**SEO/meta**: canonical link, `og:title`, `og:description`, `og:image`, `og:video` (embed URL), `og:type=video.other`, Twitter Card (`player` type), and oEmbed discovery `<link>`. Unlisted videos get `<meta name="robots" content="noindex">` and `X-Robots-Tag: noindex` header.

**Agent affordances**: a `<link rel="alternate" type="text/markdown" href="/:slug.md">`, a visually-hidden directive (`.agent-directive`) pointing agents at `/llms.txt` and the `.md` variant, a `Link: </llms.txt>; rel="describedby"` response header, and `Vary: Accept`. Requests with `Accept: text/markdown` (Claude Code, Cursor, OpenCode) get the `.md` body instead of HTML — these negotiated responses are returned `Cache-Control: private, no-store` so a shared cache never serves markdown to a browser. The same affordances apply to tag pages (see `/:slug.md`).

**Tag fallback**: when the slug is not a video, the catch-all falls back to the **tag** HTML page (`tag-page.tsx`). Same resolution semantics: 404 for unknown/private tags, 301 for renamed tag slugs via `tag_slug_redirects`. Non-public tags get `X-Robots-Tag: noindex`. Sent with `Vary: Accept` and `Cache-Control: <public|private>, max-age=60, stale-while-revalidate=300` (scoped to tag visibility).

### `/:slug/embed`

Chromeless player for iframe embeds. Same MP4-vs-HLS selection, no page chrome. Full-viewport dark background. Used by the oEmbed `html` field and OG/Twitter player tags.

### `/:slug/raw/:file`

MP4 video variants with HTTP Range support. Serves from `data/<id>/derivatives/<file>`.

**Filename allowlist**: `<N>p.mp4` (e.g. `720p.mp4`, `1080p.mp4`), plus `upload.mp4` for an uploaded video whose post-processing failed.

`video.mp4` and `source.mp4` are handled before the allowlist: both **302** to the presentation master, so published links survive a re-encode and links made before the restructure keep working. `source.mp4` is deliberately not servable — handing out the pristine original would mean un-processed audio and, later, no watermark. Both return **404** when the video has no master yet.

### `/:slug/stream/:file`

HLS playlist and segments with HTTP Range support. Serves from `data/<id>/<file>`.

**Filename allowlist**: `stream.m3u8`, `init.mp4`, `seg_NNN.m4s`.

The playlist uses relative segment URLs, so the player resolves `seg_001.m4s` relative to the playlist URL (`/:slug/stream/seg_001.m4s`) without any rewriting.

### `/:slug/poster.jpg`

Video thumbnail. Serves `data/<id>/derivatives/thumbnail.jpg`. Returns 404 until the derivative has been generated.

### `/:slug/storyboard.jpg`

Sprite sheet for scrubber hover previews. Serves `data/<id>/derivatives/storyboard.jpg`. Every video gets one, however short — a duration threshold used to save a little disk, but it was the only viewer-facing artifact whose existence moved when a video was edited, which is how a trim once orphaned a storyboard describing the uncut timeline.

### `/:slug/storyboard.vtt`

WebVTT file mapping time ranges to regions in the sprite sheet via `#xywh=` spatial fragments. Vidstack uses this via the `thumbnails` attribute on `<media-video-layout>`.

### `/:slug/captions.srt`

SRT transcript/subtitles. Serves `data/<id>/derivatives/captions.srt`. Returns 404 until a transcript has been uploaded. `Content-Type: application/x-subrip`. Cached for 1 hour.

### `/:slug/captions.vtt`

VTT variant of the transcript, if the original upload was VTT format. Same behaviour as the SRT route. `Content-Type: text/vtt`.

### `/:slug/chapters.vtt`

WebVTT chapters track, generated on the fly from `data/<id>/chapters.json`. Returns 404 when the file is missing or empty. `Content-Type: text/vtt`. Cached for 1 hour.

Chapter timestamps in `chapters.json` are stored in the **original recording timeline**. The route remaps them to the viewer timeline through `data/<id>/derivatives/edits.json` at request time — chapters that fall inside a cut are dropped from the rendered VTT (but stay in `chapters.json`, so un-cutting brings them back). The remapping is read-only — no on-disk state mutates per request.

Vidstack picks this up via a conditional `<track kind="chapters" srclang="en" default />` rendered into `<media-provider>` on the viewer + embed pages whenever the underlying file exists.

### `/:slug/feed.xml` (tags)

Per-tag RSS 2.0 + Media RSS feed — `:slug` here is a **tag** slug (videos don't expose `/feed.*` sub-paths). Items ordered per the tag's `videoSort`. `Content-Type: application/rss+xml`. 301 to the canonical slug for renamed tags; 404 for unknown tags or tags without a slug. Lives in `routes/videos/tag-feeds.ts`, mounted in the videos sub-router so it shares its wildcard CORS. Same `X-Robots-Tag`/`Cache-Control` rules as the tag page.

### `/:slug/feed.json` (tags)

Per-tag JSON Feed 1.1 with `info_for_llms` top-level key. Served as `application/feed+json`. Same 301/404 rules and headers as `/:slug/feed.xml`.

### `/:slug.mp4`

Convenience redirect. **302** straight to the presentation master (e.g. `/:slug/raw/1440p.mp4`) — one hop, not via `video.mp4`. Uses `activeRawFilename()` from `lib/url.ts`. 302 (not 301) because the target moves if a video is ever rebuilt at a different resolution. **404** when there's no master yet.

### `/:slug.json`

JSON metadata for programmatic/LLM consumption. All URLs are absolute. Video-only (tags have no `.json`). Sent with `Cache-Control: public|private, max-age=300, stale-while-revalidate=3600` (scoped to visibility) so a freshly edited video is never served stale for long behind the CDN.

```json
{
  "id": "uuid", "slug": "...", "status": "...", "visibility": "...",
  "title": "...", "description": "...", "durationSeconds": 42.5,
  "durationFormatted": "42s", "source": "recorded",
  "width": 1920, "height": 1080, "aspectRatio": 1.7778,
  "sources": [{ "height": 720, "width": 1280, "type": "video/mp4", "url": "..." }],
  "transcript": "Plain text transcript or null",
  "createdAt": "ISO", "updatedAt": "ISO", "completedAt": "ISO",
  "url": "https://example.com/my-slug",
  "urls": { "page", "raw", "hls", "poster", "embed", "json", "md", "mp4",
            "captions", "storyboard", "storyboardImage" }
}
```

`urls.captions` is null when no transcript exists. Every video gets a storyboard, however short.

### `/:slug.md`

Markdown metadata. Opens with a blockquote directive pointing agents at `/llms.txt`, then heading (title or slug), description, formatted duration + date, watch link, and a "Links" section with bulleted URLs (page, MP4 download, embed, JSON). Includes a "Transcript" section with the full plain text when a transcript exists. All URLs absolute. Same `Cache-Control` as `/:slug.json`.

If the slug is not a video, `.md` falls back to a **tag** markdown page: a blockquote directive, the tag name + description, video count, a "Videos" list (linked, with duration · date), and a "Links" section (tag RSS/JSON feeds + site index). This is also what `Accept: text/markdown` content negotiation returns for a tag slug.

## Back-compat redirects

`/v/:slug` and `/v/:slug/*` permanently 301-redirect to `/:slug` (and `/:slug/*`). These routes must not be removed — existing shared URLs, bookmarks, and older macOS app versions reference the `/v/` path.

## Site routes

| Path           | Response                                                                             |
| -------------- | ------------------------------------------------------------------------------------ |
| `/`            | 302 redirect to `https://danny.is`. HTML body contains feed/llms.txt hints for curl and AI agents. `Link` header for RSS autodiscovery. Requests with `Accept: text/markdown` instead get 200 with the llms.txt body (`text/markdown`, `Cache-Control: private, no-store`, `Vary: Accept`). |
| `/feed.xml`    | RSS 2.0 + Media RSS feed of all public, `ready`, non-trashed videos. Includes `<enclosure>`, `<media:content>`, `<media:thumbnail>` per item. |
| `/rss`         | 301 redirect to `/feed.xml`                                                          |
| `/feed.json`   | JSON Feed 1.1. Includes `info_for_llms` top-level key, truncated transcript excerpts (~200 words), per-video `_urls` map, media attachments. Served as `application/feed+json`. |
| `/llms.txt`    | Dynamic markdown conforming to llmstxt.org. Includes endpoint documentation, public video list with titles/durations/dates/descriptions, and links to feeds/sitemap/author website. |
| `/robots.txt`  | Served from the static file `public/robots.txt`. Content signals + disallows `/admin` and `/api` + `Sitemap:` directive. |
| `/favicon.ico` | Real icon bytes from `public/images/favicon/favicon.ico`. 200, `image/x-icon`, `Cache-Control: public, max-age=604800`. |
| `/site.webmanifest` | Web app manifest from `public/site.webmanifest`, served via a route (not `serveStatic`) so it gets `application/manifest+json`. `Cache-Control: public, max-age=604800`. |
| `/sitemap.xml` | Video sitemap (public + `ready` + non-trashed only, with `<video:video>` extension) |

`/feed.xml`, `/feed.json`, `/llms.txt`, `/sitemap.xml`, and `/robots.txt` are all sent with `Cache-Control: public, max-age=300, stale-while-revalidate=3600` (see `lib/cache-control.ts`). Without this BunnyCDN applies its 30-day default, so a newly published video could be missing from the index for weeks.

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
  "provider_name": "Danny's Videos",
  "provider_url": "https://example.com",
  "html": "<iframe src=\".../embed\" ...></iframe>",
  "width": 640, "height": 360,
  "thumbnail_url": "https://example.com/.../poster.jpg",
  "thumbnail_width": 640, "thumbnail_height": 360
}
```

**Errors**: `400` (missing url param) | `404` (unknown video)

## Admin routes

Auth: session cookie (`lc_session`, signed, 2-week expiry) or `Authorization: Bearer lca_...` admin token. All routes except `GET/POST /admin/login` require auth. CSRF protection applies to cookie-authenticated mutations only — bearer requests skip the Origin check (the token is explicitly attached, not auto-sent by the browser). Every admin response gets `Cache-Control: no-store` from middleware so authenticated HTML is never served from a shared cache.

In production, `ADMIN_PASSWORD` is required — the server refuses to start without it. Locally (`NODE_ENV` unset), an unset `ADMIN_PASSWORD` lets you iterate without logging in.

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
| GET | `/admin/trash` | Trash bin — trashed videos with restore / permanent delete |

### HTMX partials (HTML fragments for in-page updates)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/admin/partials/video-list` | Filtered/sorted video list (search, pagination) |
| GET | `/admin/videos/:id/partials/title` | Title display partial |
| GET | `/admin/videos/:id/partials/title/edit` | Title edit form |
| PATCH | `/admin/videos/:id/title` | Save title |
| GET | `/admin/videos/:id/partials/slug` | Slug display partial |
| GET | `/admin/videos/:id/partials/slug/edit` | Slug edit form |
| GET | `/admin/videos/:id/partials/slug/check?slug=` | Live slug validation (format + availability) |
| GET | `/admin/videos/:id/partials/slug/from-title` | Generate slug from video title |
| PATCH | `/admin/videos/:id/slug` | Save slug (creates redirect, reclaims own old slugs) |
| GET | `/admin/videos/:id/partials/description` | Description display partial |
| GET | `/admin/videos/:id/partials/description/edit` | Description edit form |
| PATCH | `/admin/videos/:id/description` | Save description |
| GET | `/admin/videos/:id/partials/notes` | Notes display partial |
| GET | `/admin/videos/:id/partials/notes/edit` | Notes edit form |
| PATCH | `/admin/videos/:id/notes` | Save notes (empty → null) |
| GET | `/admin/videos/:id/partials/visibility` | Visibility display partial |
| GET | `/admin/videos/:id/partials/visibility/edit` | Visibility edit form |
| PATCH | `/admin/videos/:id/visibility` | Change visibility |
| GET | `/admin/videos/:id/partials/tabs?tab=` | Re-render tab section (`events`, `files`, `transcript`, `processing`) |
| GET | `/admin/videos/:id/partials/file-preview?path=` | Highlighted preview of a file under `data/<id>/`. 400 invalid path (empty, `..`, leading `/`), 404 missing |
| POST | `/admin/videos/:id/tags` | Add tag to video |
| DELETE | `/admin/videos/:id/tags/:tagId` | Remove tag from video |

### Chapters (editor)

| Method | Path | Purpose |
|--------|------|---------|
| GET  | `/admin/videos/:id/chapters` | Returns `{ version: 1, chapters: [...] }` with times mapped to the **viewer** timeline (i.e. already remapped through `edits.json` if any) |
| PUT  | `/admin/videos/:id/chapters` | Bulk replace. Body: `{ version: 1, chapters: [{ id, title \| null, t }] }` (max 100). Server reverse-maps `t` from viewer-timeline back to the recording timeline before persisting. Preserves `createdDuringRecording` on existing rows. Logs `chapters_updated`. Purges CDN. |
| GET  | `/admin/videos/:id/media/chapters.vtt` | Admin variant of the public `/:slug/chapters.vtt`. Same on-the-fly generation, but bypasses slug resolution so trashed videos and admin previews still get markers. `no-store` cache. |

### Editor

Routes in `routes/admin/editor.ts`, mounted at `/admin/videos`. See [Admin Editor](admin-editor.md) for the full editor architecture.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/admin/videos/:id/editor` | React editor shell (Vite build) with `data-video-*` attrs. 400 if status ≠ `ready` or trashed; 409 while a processing run is in flight |
| GET | `/admin/videos/:id/editor/edl` | Load the EDL. Returns `{ version: 1, source: "source.mp4", edits: [] }` when `edits.json` is absent |
| PUT | `/admin/videos/:id/editor/edl` | Save EDL without committing. Zod-validated `{ version: 1, source, edits: [{ type: "trim"\|"cut", startTime, endTime }] }`. 400 on schema failure — plain `{ error }`, not the `{ error, code }` envelope |
| POST | `/admin/videos/:id/editor/commit` | Commit edits, schedule the edit pipeline. Returns `{ ok: true, status: "reprocessing" }`. 400 trashed / not `ready` / no `edits.json`; 409 already reprocessing or run in flight |
| GET | `/admin/videos/:id/editor/media/:file` | Editor-only derivatives. Allowlist: `editor-storyboard.(jpg\|vtt)`, `peaks.json`, `words.json`, `edits.json`, `suggested-edits.json`. Range-aware, short cache. 404 for non-allowlisted files |

### Cover generator

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/admin/videos/:id/cover` | React cover-image generator shell (Vite `cover.html` entry). 400 for trashed videos |

### Thumbnail picker

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/admin/videos/:id/partials/thumbnails` | Thumbnail picker partial |
| POST | `/admin/videos/:id/thumbnail/promote` | Promote a candidate to active thumbnail |
| POST | `/admin/videos/:id/thumbnail/upload` | Upload custom JPEG or PNG (max 5 MB, max 3840px wide), auto-promotes |
| POST | `/admin/videos/:id/thumbnail/add-candidate` | Save uploaded JPEG/PNG as a candidate **without** promoting (used by the cover generator). Same size/width limits, JSON responses: `{ ok: true, candidateId }` or `{ error }` 400 |
| DELETE | `/admin/videos/:id/thumbnail/candidates/:candidateId` | Delete a candidate. 400 invalid id, 404 not found, 409 if it's the active thumbnail or the last candidate |

### Video actions

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/admin/videos/:id/trash` | Soft-delete, redirect to dashboard |
| POST | `/admin/videos/:id/untrash` | Restore, redirect to video detail |
| POST | `/admin/videos/:id/delete-permanently` | Hard-delete trashed video (files + DB), redirect to trash |
| POST | `/admin/videos/:id/duplicate` | Full copy (files + DB), redirect to duplicate |

### Reprocessing

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/admin/videos/:id/reprocess` | Rebuild the presentation set from the preserved source, honouring whatever EDL is on disk — so reprocessing an edited video regenerates the same cut rather than discarding it. Form `rebuild=hls` re-stitches the source first, which also restores `source_pristine`. 302 → `/admin/videos/:id?tab=processing&reprocessed=<started\|queued\|skipped>`. 400 if the status can't be reprocessed, or `rebuild=hls` when the HLS segments are gone. Logs `reprocess_requested` |
| POST | `/admin/videos/:id/reprocess/:kind` | Regenerate a single artifact from whatever it declares as its input (`kind` must be in `REGENERABLE_KINDS` — everything except `source` and `presentation`, the two with dependents). Same 302. 400 on bad status, non-regenerable kind, or missing/invalid `source.mp4` |

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
| POST | `/admin/settings/keys/recording` | Create recording API key (`lck_`), form `name`; token shown once |
| POST | `/admin/settings/keys/recording/:id/revoke` | Revoke recording API key |
| POST | `/admin/settings/keys/admin` | Create admin token (`lca_`), form `name`; token shown once |
| POST | `/admin/settings/keys/admin/:id/revoke` | Revoke admin token |

### `GET /admin/self-check`

Machine-readable health report (JSON): `200` with `{ healthy: true, checkedAt, failures: [], stats }` when everything passes, `503` with the failure strings when not. `stats` carries data-volume disk usage, the loom-clone data footprint, container memory (cgroup v2; `null` outside a container), and the last-successful-backup marker. Checks: stuck `processing`/`recording`/`healing` videos, any `processing_failed`/`incomplete` videos, disk headroom, and CDN-purge config in production. A host cron curls this daily and forwards the verdict to healthchecks.io — see [Operations & Alerting](operations.md) for wiring, thresholds, and the per-alert runbook.

## Content types

| Extension | Content-Type                    | Used by                    |
| --------- | ------------------------------- | -------------------------- |
| `.m3u8`   | `application/vnd.apple.mpegurl` | HLS playlist               |
| `.m4s`    | `video/iso.segment`             | HLS media segments         |
| `.mp4`    | `video/mp4`                     | init segment, derivatives  |
| `.jpg`    | `image/jpeg`                    | poster/thumbnail           |
| `.json`   | `application/json`              | API responses, /:slug.json |
| `.json`   | `application/feed+json`         | /feed.json (JSON Feed 1.1) |
| `.xml`    | `application/rss+xml`           | /feed.xml (RSS + MRSS)     |
| `.txt`    | `text/plain`                    | /llms.txt                  |
| `.vtt`    | `text/vtt`                      | storyboard.vtt, captions.vtt |
| `.srt`    | `application/x-subrip`          | captions.srt               |
| `.md`     | `text/markdown`                 | /:slug.md                  |
| `.webmanifest` | `application/manifest+json` | /site.webmanifest        |
| `.ico`    | `image/x-icon`                  | /favicon.ico               |

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
| `BUNNY_CDN_API_KEY` | *(unset)*             | BunnyCDN API key for cache purging. When unset, purge calls no-op. |

See `.env.example` for documentation and defaults.

## File resolution

Every video serves a **presentation master** named for its source height — `1440p.mp4` for a 1440p recording — whether or not it has been edited. `source.mp4` is the pristine original: never modified, never served publicly, and the input everything else is regenerated from. See [Derivatives](streaming-and-healing.md#derivatives) for the two artifact groups this creates.

**File layout for an edited 1440p recording:**
```
derivatives/
  source.mp4             # pristine original — never modified, what the editor plays
  edits.json             # the EDL (trim/cut instructions); absent or empty = unedited
  1440p.mp4              # the presentation master: audio chain + EDL applied
  1080p.mp4              # downscaled from the master
  720p.mp4               # downscaled from the master
  words.json             # word-level timestamps from transcription
  peaks.json             # audio peaks from the source (editor waveform)
  editor-storyboard.*    # dense thumbnails from the source (editor timeline)
  storyboard.*           # viewer-facing thumbnails, from the master
  captions.original.srt  # the transcript exactly as the Mac produced it
  captions.srt           # served captions, mapped onto the presentation timeline
```

**URL resolution rule:** `activeRawFilename(video)` in `lib/url.ts` returns `{height}p.mp4`, or **null** when the video has no cached height — meaning no master can exist yet, because metadata hasn't run or it failed. Callers must handle that null rather than substituting `source.mp4`: doing so once made `/raw/source.mp4` redirect to itself in a loop.

**What we publish is `video.mp4`.** `/:slug/raw/video.mp4` is a 302 to whatever the best rendition currently is, and it's what the JSON, Markdown, feeds, `llms.txt`, sitemap, JSON-LD and download links all name. Asking for the video gets you the best rendition without knowing its height; asking for a smaller one stays explicit (`/:slug/raw/720p.mp4`). The player is the exception — it gets concrete per-rendition URLs, because it follows them on every load and shouldn't pay for a redirect.

**Why always generate a resolution-named file.** This reverses an earlier decision, which was that creating `1080p.mp4` as a copy of `source.mp4` wasted disk on the majority of videos that are never edited. Two things outweigh that. The audio chain used to be written into `source.mp4` in place, so the original audio was destroyed and an improved chain could never be applied retroactively; and "edited" was a special case threaded through the whole pipeline. Giving every video a master makes the original permanently reprocessable and collapses the special case — committing an edit and pressing reprocess became the same operation. The cost is roughly 2× disk per video.

**Editor-facing files never move when you edit:** `peaks.json` and `editor-storyboard.*` are cut from the source, because the editor always plays the original and edits against its timeline.
