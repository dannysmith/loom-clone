# Task: Proper Server API

Goal: Turn the prorotype Hono app into a proper backend server API which accepts videos from the macOS app and can be deployed to Hertzner. We are not trying to be feature complete here, just have a good, well set up, secure system, which can be run locally and deployed. 

## Phase 1 - Developer Tooling and Cleanup [DONE]

Let's get the hono server properly set up with development tools for linting, formatting, checking, testing etc. We can also take this opportunity to do a little bit of clean up and refactoring and re architecture to get us ready for what we know we're gonna be doing. 

## Phase 2 - Test Setup & Tests [DONE]

Let's get an automated testing framework set up in here and add tests for anything which we already have, which we should definitely have unit tests or any other types of tests for. 

## Phase 3 - SQLite + Drizzle ORM and Data Models etc

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
- Types include: `created`, `healed`, `completed`, `slug_changed`, `title_changed`, `description_changed`, `tag_added`, `tag_removed`, `trashed`, `restored`, `visibility_changed`, `derivative_generated`, `derivative_failed`
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
- **Soft delete**: `trashVideo(videoId)`, `restoreVideo(videoId)` set/clear `trashedAt`. All list/get queries filter out trashed by default with an `includeTrashed` opt-in.

#### 3.5 Route updates

- `POST /api/videos` — unchanged API; writes row with `visibility=unlisted`, logs `created`.
- `PUT /:id/segments/:filename` — rows into `video_segments` instead of sidecar. No event log per segment. Reject uploads to trashed videos (404, same shape as unknown id).
- `POST /:id/complete` — set status, populate `completedAt` (once) and `durationSeconds`, log `completed` or `healed`.
- `DELETE /:id` — keep as hard delete for now (cascades via FK). A later admin-panel change will swap this to soft-trash.
- `GET /v/:slug` — use `resolveSlug`; if redirect, return `c.redirect()` 301.

Existing `data/` is expendable — not production, nuke it before running the new schema. No migration script.

#### 3.6 Validation

- Add `zod` at the API boundary. Validate path params, query params, body on every mutating route.
- Use `drizzle-zod` to derive insert/update schemas where it fits; hand-written for anything else.
- Validation failures return 400 with structured error bodies.

#### 3.7 Tests

- Rewrite tests that exercised the in-memory store to work against the DB. The per-test `:memory:` db keeps them fast.
- New tests: slug history + redirect lookup, slug-change conflict (409), tag CRUD and assignment, trash/restore + filtering, event logging on each state change, validation rejections, FK cascade (deleting a video removes its segments/tags/events/redirects).
- Keep the real-filesystem-and-ffmpeg integration tests as-is.

#### 3.8 Cleanup

- Remove `video.json` and `segments.json` writes from the code. Remove the migration reader from `loadAllVideos()` (it's gone anyway).
- Add a "Database" section to `server/CLAUDE.md` (location, scripts, test isolation).
- Update `docs/developer/streaming-and-healing.md` — the file inventory table loses `video.json` and `segments.json`, gains a pointer to the DB.

## Phase 4 - Styling System

We need to decide on our approach to templating and CSS and set up a suitable structure for templating and serving HTML pages, as well as a sensible CSS reset/base/global CSS vars etc. Although at the moment the only HTML we need to style is the user-facing video page, we will eventually have an Admin side to this Hono app too, which will need a proper system of reusable components and the like. Let's at least get ready for that and make our life easier.

## Phase 5 - Auth for menubar app

We need to set up a Auth system for the API endpoints and change the macOs menubar app so it sends authenticated requests. I'd suggest that a simple API key and Bearer tokens is probably the best way to go here, considering it's only me who's gonna be using this. But we obviously want to consider security best practice here as well. 

## Phase 6 - Add all expected endpoints

This is the point to map out all of our current API endpoints and also think about the other API endpoints we know we are going to need going forward. This should include:

- API endpoints for use by the macOS app (all of which will be authenticated eventually)
- User-facing "Web" endpoints (see below)
- A web endpoint for the admin panel (eventually will be authed via web login)

Where we have the data and information to populate and actually do these endpoints, we can do them now (if they're simple). where we don't, we should just create stub endpoints, which we will then build out later. The admin pages is a good example of this.

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
