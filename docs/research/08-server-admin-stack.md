# Server & Admin Stack

*Research date: 2026-03-30*

This document evaluates server stack options for the video management server and admin interface. The prior decision to use Mux (see `04-video-hosting-build-vs-buy.md`) means the server is a **thin metadata and admin layer**, not a video processing engine. The server's responsibilities are: receive upload notifications and Mux webhooks, manage video metadata (title, slug, tags, visibility), serve the admin UI, serve/generate public video pages with proper OG tags, handle URL routing and slug redirects, and coordinate the recording flow between the desktop app and Mux.

For self-hosted fallback (R2 + FFmpeg), the server gains additional responsibilities: receive HLS segments from the desktop app, manage playlists, run FFmpeg for multi-bitrate encoding, and manage the encoding job queue. The stack choice should work for both scenarios.

---

## What the Server Actually Does

Before evaluating stacks, it helps to be concrete about the server's scope. With Mux handling video, the server is small:

**API for the desktop app:**
- `POST /api/videos` -- Create a video record, get a Mux live stream key, return the shareable URL
- `PUT /api/videos/:id/segments/:n` -- Receive HLS segments (self-hosted path only)
- `POST /api/videos/:id/complete` -- Signal recording is complete, finalise playlist
- `POST /api/videos/:id/upload` -- Accept a full MP4 upload (imports, fallback)
- `PATCH /api/videos/:id` -- Update metadata from the desktop app (title, etc.)

**API for the admin UI:**
- `GET /api/videos` -- List videos with search, filter, sort, pagination
- `GET /api/videos/:id` -- Get video details
- `PATCH /api/videos/:id` -- Update metadata (title, slug, description, tags, visibility)
- `DELETE /api/videos/:id` -- Delete video (from DB, Mux, and R2 backup)
- `POST /api/videos/import` -- Upload an MP4 for import

**Public-facing pages:**
- `GET /:slug` -- Video page (HTML with OG tags, mux-player embed, oEmbed discovery)
- `GET /embed/:slug` -- Embed-only player (no page chrome)
- `GET /oembed` -- oEmbed JSON endpoint
- Slug redirect handling (old slug -> 301 -> current slug)

**Background work:**
- Process Mux webhooks (live stream ended -> VOD asset ready, asset ready -> update DB)
- Generate/update thumbnails
- Optional: trigger transcription, generate AI title suggestions

**Auth:**
- Desktop app: API key in header (single user, one key)
- Admin UI: Session-based login (single user, password or passkey)
- Public pages: No auth

This is a modest scope. The database schema is ~5 tables. The API is ~15 endpoints. The background work is webhook-driven, not a persistent job queue. This is not a complex application.

---

## Stack Options Evaluated

### Option 1: Go + SQLite + Templ (Go templates)

**The stack:** Go standard library `net/http` (or Echo/Chi for routing), SQLite via `modernc.org/sqlite` (pure Go, no CGO), html/template or Templ for server-rendered pages, separate React SPA for the admin UI (or HTMX for a simpler approach).

**Why Go fits:**
- Single binary deployment. `go build` produces one file. Copy it to the server, run it. No runtime, no dependencies, no node_modules.
- Excellent standard library for HTTP servers, JSON handling, and file operations. The `net/http` package alone covers most of what we need.
- Low memory footprint. A Go server handling our traffic profile uses 10-30 MB of RAM.
- Goroutines make concurrent operations (webhook processing, background tasks) natural without a separate job queue system.
- Strong ecosystem for S3 operations (AWS SDK for Go), Mux API calls, and SQLite.
- Compiles fast, tests run fast, deploys fast.

**Admin UI approach:** This is Go's weakness. Go does not have a Django Admin equivalent. Options:
1. Build a separate React/Vite SPA that talks to the Go API. More work but maximum flexibility.
2. Use HTMX with server-rendered Go templates for a simpler, server-driven admin. Less JavaScript, faster to build for simple CRUD, but less polished.
3. Use a Go admin panel library like `go-admin` or `qor`. These exist but are significantly less mature than Django Admin.

**Database:** `modernc.org/sqlite` is a pure-Go SQLite implementation (no CGO required). It is slower than CGO-based `mattn/go-sqlite3` for write-heavy workloads, but for our single-user read-heavy pattern, the difference is negligible. SQLite FTS5 is available for full-text search of titles, descriptions, and transcripts.

**Self-hosted fallback:** Go can shell out to FFmpeg for transcoding. Goroutines provide a natural job queue: spawn a goroutine per encoding job, use channels for coordination. For our single-user volume (~75 videos/month), this is sufficient without a dedicated queue system like Redis.

**Deployment:** Single binary + SQLite file + Litestream for backup. Copy binary to VPS, run with systemd. Updates: build new binary, scp to server, restart service. Docker optional but not required.

**Tradeoffs:**
- Admin UI requires more upfront work than Django/Rails
- Go's type system is verbose for simple CRUD operations
- No ORM equivalent to Drizzle or Django ORM (use `sqlc` for type-safe SQL, or `sqlx` for slightly more flexibility)
- Template rendering for video pages is straightforward but less ergonomic than JSX

---

### Option 2: Hono + Drizzle + SQLite + React (Bun runtime)

**The stack:** Hono web framework on Bun runtime, Drizzle ORM with `better-sqlite3` (or `bun:sqlite`), React for the admin UI (served as a SPA or via Vite), server-rendered HTML for public video pages.

**Why Hono fits:**
- Ultrafast, lightweight TypeScript web framework (~14kB). Clean Express-like API without Express's baggage.
- First-class TypeScript support with end-to-end type safety. The RPC mode with Zod validation means the admin frontend and server share types automatically.
- Runs on Bun (fast, low overhead, built-in SQLite support) or Node.js. Bun's native SQLite bindings (`bun:sqlite`) are fast and zero-dependency.
- Middleware ecosystem covers auth, CORS, JWT, logging, compression out of the box.
- Hono is not a framework that imposes structure -- it is a routing layer. This suits our thin server: we are building a small API, not a large application.

**Why TypeScript fits:**
- The admin UI is React. Sharing types between the API and the frontend eliminates a class of bugs.
- The desktop app's API client can use the same type definitions (via a shared package or generated types).
- Drizzle ORM provides type-safe database queries with minimal abstraction. Its SQLite support is mature.
- The Mux Node.js SDK is official and well-maintained. The Mux player web component (`mux-player`) is a React component.
- Vidstack (our chosen video player) has first-class React support.

**Admin UI approach:** Build a React SPA with Vite. Hono serves the API; Vite builds the frontend. In development, Vite's dev server proxies API requests to Hono. In production, Hono serves the built static files. This is a well-established pattern. The admin UI is simple CRUD: video list with search/filter, video detail form, upload form. A good component library (Radix, Shadcn) makes this fast to build.

**Database:** Drizzle ORM + `bun:sqlite` or `better-sqlite3`. Drizzle's SQLite support includes migrations, type-safe queries, and relation handling. SQLite FTS5 is accessible via raw SQL when needed (Drizzle supports `sql` template literals for raw queries).

**Self-hosted fallback:** Shell out to FFmpeg via `child_process` / `Bun.spawn`. Use a simple in-process job queue (e.g., `bullmq` with SQLite adapter, or a simple custom queue backed by a SQLite table). TypeScript's async/await makes orchestrating background tasks natural.

**Deployment:** Bundle with `bun build` into a single executable (Bun's single-file executable compilation), or run `bun run server.ts` on the VPS. Docker is a natural fit. Litestream for SQLite backup.

**Tradeoffs:**
- Bun is newer and less battle-tested than Node.js (though it is stable for our use case)
- No built-in admin panel generator -- we build the React UI ourselves
- Single-threaded by default (Bun supports workers, but the single thread is fine for our traffic)
- Slightly more moving parts than Go (runtime + framework + ORM + bundler) vs Go's single binary

---

### Option 3: Django + SQLite + Django Admin

**The stack:** Python/Django with Django REST Framework for the API, Django Admin for the admin interface, SQLite database, Celery (optional) for background tasks.

**Why Django fits:**
- Django Admin is the killer feature for this use case. Define your models, register them with the admin, and you have a functional admin interface with list views, search, filtering, inline editing, and file uploads -- for free. For a single-user video management tool, Django Admin might be "good enough" as the entire admin UI.
- Django REST Framework provides a clean, well-documented API layer with serializers, viewsets, and authentication out of the box.
- Django's ORM is mature and productive for the kind of CRUD operations we need.
- MediaCMS (studied in `10-open-source-video-platforms.md`) uses Django + Celery + FFmpeg for exactly this kind of application, validating the pattern.
- Large ecosystem of packages for common needs (django-storages for S3, django-cors-headers, etc.).

**Admin UI approach:** Django Admin, possibly enhanced with `django-unfold` or `django-jazzmin` for a more modern look. For our five tables (videos, slugs, tags, video_tags, settings), Django Admin provides:
- Video list with search by title/description, filter by visibility/tags, sortable columns
- Video detail form with editable fields, tag management
- File upload for MP4 imports
- All with essentially zero frontend code

If Django Admin proves too limiting, we can still build a React SPA on top of the Django REST Framework API later.

**Database:** Django has mature SQLite support and recently (Django 5.1+) improved it significantly with `TransactionTestCase` improvements and better WAL mode handling. SQLite FTS5 can be accessed via raw SQL or the `django.contrib.postgres.search` patterns adapted for SQLite via third-party packages.

**Self-hosted fallback:** Django + Celery is the canonical pattern for background processing in Python. MediaCMS demonstrates this exact stack for video transcoding with FFmpeg. Celery with Redis as the broker handles job queuing, retries, and monitoring.

**Deployment:** More moving parts than Go or Bun: Python runtime, pip dependencies, gunicorn/uvicorn ASGI server, (optionally) Celery worker + Redis. Docker simplifies this but there's more to manage. Not a single-binary deployment.

**Tradeoffs:**
- Django Admin is a massive time-saver but locks you into Django's patterns
- Python is slower than Go or Bun for I/O-heavy workloads (not a real concern at our scale)
- More deployment complexity than a single binary
- Django's "batteries included" philosophy brings code we don't need (auth system, sessions middleware, etc.) -- though this is easily trimmed
- The Mux Python SDK exists but is less prominently maintained than the Node.js SDK
- No type sharing between the server and a future React frontend (if we outgrow Django Admin)

---

### Option 4: Next.js (App Router) + Drizzle + SQLite

**The stack:** Next.js with App Router, server actions, Drizzle ORM, SQLite, React for both admin UI and server-rendered public pages.

**Why Next.js fits:**
- Single framework handles both the API and the admin UI and the public video pages. No separate frontend build.
- Server Components render the public video pages with full SEO and OG tag support.
- Server Actions provide type-safe mutations for the admin UI without building a separate API layer.
- Cap uses Next.js for their server (see `03-cap-codebase-analysis.md`), validating that it works for video management.
- Mux has first-class Next.js integration: `@mux/mux-player-react` and `@mux/mux-node` SDK.
- Vidstack has first-class React/Next.js support.

**Why it might not fit:**
- Next.js is a frontend framework being used as a backend. It works, but it comes with opinions about routing, caching, and deployment that may conflict with our needs.
- Deployment is optimised for Vercel. Self-hosting Next.js on a VPS requires `next start` with a Node.js runtime, which is heavier than necessary for a thin API server.
- The App Router's caching behavior is complex and occasionally surprising. For a server that needs precise control over HTTP caching (HLS playlists during recording), this adds friction.
- Server Actions are designed for form mutations, not general-purpose API endpoints. The desktop app needs a proper REST API, which means we're building API Route handlers alongside Server Actions -- two patterns for the same thing.
- Cap's codebase analysis flagged this as problematic: their server layer is a thin Next.js wrapper over S3 with accumulated complexity. We would be following the same path.

**Deployment:** `next build` + `next start` on a VPS with Node.js. Or Docker. Heavier footprint than Go or Hono-on-Bun.

**Tradeoffs:**
- Full-stack TypeScript is nice, but Next.js brings significant framework overhead for what is essentially a small API + a few pages
- Vercel-optimised deployment model is a poor fit for a single-VPS deployment with SQLite
- The framework's complexity-to-value ratio is unfavorable for our thin server
- Better suited for applications where the frontend IS the application (SaaS dashboards, etc.)

---

## Database: SQLite vs PostgreSQL

For a single-user application, SQLite is the clear winner.

**Why SQLite:**
- Zero operational overhead. No separate database server to run, configure, monitor, back up, or upgrade.
- The database is a single file. Back it up by copying the file, or use Litestream for continuous replication to S3/R2.
- WAL (Write-Ahead Logging) mode handles our read-write pattern well: one writer (the server), occasional reads (admin UI, video page rendering). No contention.
- Performance is excellent for our scale. A few hundred videos, a few thousand rows total. SQLite handles millions of rows comfortably.
- FTS5 provides full-text search for video titles, descriptions, and transcripts. It uses BM25 ranking, phrase queries, prefix queries, and boolean operators. For our scale (~1,000 videos after a year), FTS5 search over titles and descriptions is instant.
- Drizzle ORM, Django ORM, and Go's `sqlc` all have mature SQLite support.
- Deployment is radically simpler: the database travels with the application binary.

**Why NOT PostgreSQL for this project:**
- Requires running and maintaining a separate database server (or paying for a managed instance like Neon/Supabase).
- No benefit at our scale. We are not doing complex joins across millions of rows, geospatial queries, or JSONB full-text search over massive datasets.
- Adds a network hop for every query (unless using an embedded solution, at which point we're back to SQLite).

**Full-text search considerations:**
- SQLite FTS5 handles our needs: search across video titles, descriptions, and transcripts using BM25 relevance ranking. The FTS5 `highlight()` and `snippet()` functions provide search result formatting.
- The schema: an FTS5 virtual table that mirrors the `videos` table's searchable columns, kept in sync via triggers. This is a well-established SQLite pattern.
- If we ever need more advanced search (fuzzy matching, faceted search, vector similarity for semantic search), we could add a lightweight search layer like Typesense later. But FTS5 covers the 99% case for our scale.

**Backup strategy:** Litestream continuously replicates the SQLite database to S3/R2. It runs as a sidecar process, streams WAL changes in near-real-time, and can restore to any point in time. The entire backup infrastructure is one binary and one configuration file.

---

## Admin Interface Approach

The admin UI needs are modest: list videos, edit metadata, copy URLs, delete videos, upload MP4s. This is classic CRUD with a search/filter layer.

**Django Admin** gets you 80% of the way with near-zero frontend code. For a single user who cares about function over form, it might be "done." The tradeoff is being locked into Django for the server.

**Custom React SPA** takes more time to build but gives full control and looks exactly how you want. With a component library (Shadcn/UI, Radix), building a video list with search/filter/sort, a video detail form with inline editing, and a file upload dialog is a few days of work, not weeks. The benefit: if we use Hono or Go for the API, the admin is decoupled and can evolve independently.

**HTMX + server-rendered templates** is a middle ground: server-driven interactivity with minimal JavaScript. Good for simple CRUD but starts to strain for more complex interactions (inline editing, drag-and-drop tag management, real-time upload progress). Fine for v1, might need replacing.

**Recommendation for our stack:** Build a simple React admin SPA. The admin is small enough that a framework-provided admin (Django Admin) saves days, not months. The flexibility of choosing the best server framework independent of the admin framework is worth the extra days.

---

## Evaluation Matrix

| Criterion | Go + SQLite | Hono + Drizzle + SQLite | Django + SQLite | Next.js + Drizzle |
|---|---|---|---|---|
| **Deployment simplicity** | Excellent (single binary) | Good (Bun binary or Docker) | Moderate (Python + deps + ASGI) | Moderate (Node.js + framework) |
| **Admin UI speed-to-build** | Slow (build from scratch) | Moderate (React SPA) | Fast (Django Admin) | Moderate (React in Next.js) |
| **API development speed** | Moderate (verbose but clear) | Fast (TypeScript, Zod, type sharing) | Fast (DRF viewsets) | Fast (but two paradigms) |
| **Type safety** | Good (Go types) | Excellent (end-to-end TS) | Poor (Python typing is optional) | Excellent (end-to-end TS) |
| **Mux SDK quality** | Good (official Go SDK) | Excellent (official Node SDK, mux-player React) | Adequate (official Python SDK) | Excellent (same as Hono) |
| **Vidstack integration** | N/A (serves HTML, player is client-side) | Excellent (React component) | N/A (serves HTML, player is client-side) | Excellent (React component) |
| **Memory / resource usage** | Excellent (~10-30 MB) | Good (~50-80 MB) | Moderate (~100-200 MB) | Moderate (~150-300 MB) |
| **Self-hosted FFmpeg fallback** | Good (goroutines for jobs) | Good (child_process + queue) | Good (Celery, proven pattern) | Awkward (not designed for background jobs) |
| **Operational simplicity** | Excellent | Good | Moderate | Moderate |
| **AI-assisted maintainability** | Excellent (Go is well-supported) | Excellent (TypeScript is well-supported) | Good (Python is well-supported) | Good (but Next.js quirks) |
| **Long-term maintainability** | Excellent (stable, minimal deps) | Good (Hono is stable, Bun is maturing) | Good (Django is very stable) | Moderate (Next.js changes frequently) |

---

## Recommendation: Hono + Drizzle + SQLite + React Admin (on Bun)

**Primary choice: TypeScript with Hono, Drizzle ORM, SQLite, and a separate React admin SPA.**

The reasoning:

**1. End-to-end TypeScript is the biggest productivity multiplier for a single maintainer.** The server, the admin UI, and potentially the desktop app's API client share types. When we add a field to the video schema in Drizzle, the TypeScript compiler tells us every API endpoint and UI component that needs updating. With Go, we maintain types in two languages. With Django, we have no type sharing at all.

**2. Mux integration is best in TypeScript.** The official `@mux/mux-node` SDK, `@mux/mux-player-react` component, and webhook type definitions are first-class. The Mux team builds in TypeScript and Node.js first.

**3. Hono is the right weight for this server.** It is not a framework that imposes opinions about routing, caching, or deployment (unlike Next.js). It is a clean, fast routing layer with middleware. Our server is ~15 endpoints -- Hono handles this with zero overhead.

**4. Drizzle + SQLite is a natural fit.** Drizzle's SQLite support is mature. Type-safe queries, migrations, and relation handling. The `bun:sqlite` binding is fast and zero-dependency. The database travels with the application.

**5. React admin SPA is the right tradeoff.** Django Admin would save days but locks us into Python. A React SPA with Shadcn/UI components, built against the Hono API, gives us a polished admin that matches the rest of the TypeScript codebase. The Vidstack player component works directly in the admin for video previews.

**6. Bun is a practical choice for this project.** Single-file executable compilation (`bun build --compile`), fast startup, native SQLite bindings, and built-in test runner. The risk of Bun immaturity is low for a single-user server with modest requirements.

**Why not Go (the close second)?** Go is excellent and would be the choice if we valued deployment simplicity above all else. The single binary + SQLite deployment story is hard to beat. But the lack of type sharing with the React admin, the verbose CRUD code, and the weaker Mux SDK integration tip the balance toward TypeScript. If the admin were Django-Admin-simple (no React), Go would win. But since we need a React admin regardless, TypeScript makes more sense.

**Why not Django?** Django Admin is genuinely tempting for the admin UI -- it would be functional in hours. But it locks us into Python for the server, and the deployment story (Python + pip + gunicorn + Celery + Redis) is heavier than it needs to be. The Mux Python SDK is a second-class citizen. And if we ever outgrow Django Admin and need a React frontend, we have zero type sharing and need to build the API layer differently anyway.

**Why not Next.js?** Next.js solves the wrong problem. It is optimised for Vercel-deployed, server-component-driven applications with complex caching requirements. Our server is a thin API + a few server-rendered HTML pages. Next.js adds framework complexity (App Router caching, Server Actions vs Route Handlers, middleware edge runtime vs Node runtime) without proportionate benefit. Cap uses Next.js and the result is a fragile, over-engineered server layer. We should learn from that.

---

## Architecture Sketch

### With Mux (primary)

```
Desktop App (Swift)
    |
    |-- POST /api/videos (create record, get Mux stream key)
    |-- RTMP push --> Mux Live Stream --> HLS playback (instant)
    |-- POST /api/videos/:id/complete (recording done)
    |-- Local copy --> upload to R2 (backup)
    |
    v
Server (Hono on Bun)
    |
    |-- API routes (/api/videos/*)
    |-- Mux webhook handler (/webhooks/mux)
    |-- Video page renderer (/:slug) -- server-rendered HTML
    |-- Embed page renderer (/embed/:slug)
    |-- oEmbed endpoint (/oembed)
    |-- Static file serving (admin SPA)
    |
    |-- SQLite (video metadata, slugs, tags)
    |-- Mux API client (create streams, manage assets)
    |-- R2 client (backup storage, thumbnails)
    |
    v
Admin SPA (React + Vite)
    |
    |-- Video library (list, search, filter, sort)
    |-- Video detail (edit metadata, preview player)
    |-- Import (upload MP4, tus resumable upload)
    |-- Settings
```

### With Self-Hosted Fallback (R2 + FFmpeg)

```
Desktop App (Swift)
    |
    |-- POST /api/videos (create record, get upload session)
    |-- PUT /api/videos/:id/segments/:n (upload fMP4 segments)
    |-- POST /api/videos/:id/complete (finalise playlist)
    |
    v
Server (Hono on Bun)
    |
    |-- All routes from above, plus:
    |-- Segment receiver (write to R2, update m3u8 playlist)
    |-- FFmpeg job runner (background encoding to multi-bitrate HLS)
    |-- Job status tracking (SQLite-backed queue)
    |
    |-- R2 (segments, playlists, renditions, thumbnails)
    |-- Cloudflare CDN (serves R2 content)
```

---

## Database Schema

```sql
-- Videos
CREATE TABLE videos (
  id TEXT PRIMARY KEY,           -- nanoid or uuid
  title TEXT,
  description TEXT,
  current_slug TEXT NOT NULL UNIQUE,
  visibility TEXT NOT NULL DEFAULT 'unlisted'
    CHECK (visibility IN ('public', 'unlisted', 'private')),
  status TEXT NOT NULL DEFAULT 'recording'
    CHECK (status IN ('recording', 'processing', 'ready', 'error')),

  -- Mux integration
  mux_asset_id TEXT,
  mux_playback_id TEXT,
  mux_stream_key TEXT,           -- live stream key (cleared after recording)
  mux_live_stream_id TEXT,

  -- Video metadata
  duration_seconds REAL,
  width INTEGER,
  height INTEGER,
  thumbnail_url TEXT,

  -- Backup / self-hosted
  r2_path TEXT,                  -- path to backup in R2
  hls_playlist_url TEXT,         -- for self-hosted: path to m3u8

  -- Timestamps
  recorded_at TEXT,              -- when recording started
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Slug redirects (old slug -> video ID)
CREATE TABLE slug_redirects (
  old_slug TEXT PRIMARY KEY,
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Tags
CREATE TABLE tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE video_tags (
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (video_id, tag_id)
);

-- Full-text search index
CREATE VIRTUAL TABLE videos_fts USING fts5(
  title,
  description,
  content='videos',
  content_rowid='rowid'
);

-- Keep FTS in sync via triggers
CREATE TRIGGER videos_ai AFTER INSERT ON videos BEGIN
  INSERT INTO videos_fts(rowid, title, description)
  VALUES (new.rowid, new.title, new.description);
END;

CREATE TRIGGER videos_ad AFTER DELETE ON videos BEGIN
  INSERT INTO videos_fts(videos_fts, rowid, title, description)
  VALUES ('delete', old.rowid, old.title, old.description);
END;

CREATE TRIGGER videos_au AFTER UPDATE ON videos BEGIN
  INSERT INTO videos_fts(videos_fts, rowid, title, description)
  VALUES ('delete', old.rowid, old.title, old.description);
  INSERT INTO videos_fts(rowid, title, description)
  VALUES (new.rowid, new.title, new.description);
END;

-- Transcripts (optional, added when transcription is implemented)
CREATE TABLE transcripts (
  video_id TEXT PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE,
  content TEXT NOT NULL,         -- full transcript text
  vtt_url TEXT,                  -- path to VTT subtitle file
  language TEXT DEFAULT 'en',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Encoding jobs (self-hosted fallback only)
CREATE TABLE encoding_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'complete', 'failed')),
  profile TEXT NOT NULL,         -- '1080p', '720p', '480p'
  error_message TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

This is ~5 tables (7 with optional transcript and encoding jobs). Drizzle ORM makes this schema type-safe with minimal boilerplate.

---

## API Design

### Auth

**Desktop app:** Bearer token in the `Authorization` header. A single API key stored in the desktop app's keychain and in the server's config. Simple, secure enough for single-user. The key is generated once during initial setup.

```
Authorization: Bearer <api-key>
```

**Admin UI:** Session cookie after login. Single user logs in with a password (or passkey for better security). The session is stored server-side (in SQLite) with a secure, httpOnly cookie. No OAuth, no third-party auth -- just a password check.

**Public pages:** No auth. Anyone with the URL can view public and unlisted videos. Private videos return 404.

### Endpoints

```
# Desktop app
POST   /api/videos                    # Create video, start Mux live stream
POST   /api/videos/:id/complete       # Signal recording complete
PATCH  /api/videos/:id                # Update metadata
POST   /api/videos/upload             # Import MP4 (tus-compatible)

# Admin UI
GET    /api/videos                    # List (query, visibility, tag, sort, page)
GET    /api/videos/:id                # Detail
PATCH  /api/videos/:id                # Update
DELETE /api/videos/:id                # Delete
GET    /api/tags                      # List all tags
POST   /api/tags                      # Create tag
GET    /api/stats                     # Dashboard stats (video count, storage used)

# Public
GET    /:slug                         # Video page (HTML)
GET    /embed/:slug                   # Embed player (HTML)
GET    /oembed                        # oEmbed JSON (?url=...)

# Webhooks
POST   /webhooks/mux                  # Mux event webhooks

# Self-hosted fallback (additional)
PUT    /api/videos/:id/segments/:n    # Upload HLS segment
GET    /api/videos/:id/playlist       # Serve dynamic m3u8 during recording

# Auth
POST   /api/auth/login                # Login (returns session cookie)
POST   /api/auth/logout               # Logout
GET    /api/auth/me                   # Current session check
```

### Video Page Rendering

The public video page is server-rendered HTML (not a React page). Hono renders it using its JSX support or a template engine. The page includes:

- OG meta tags (`og:title`, `og:description`, `og:image`, `og:video`, `og:type`)
- Twitter Card tags (`twitter:card`, `twitter:player`, etc.)
- oEmbed discovery link (`<link rel="alternate" type="application/json+oembed" ...>`)
- `<mux-player>` web component for Mux-backed videos, or Vidstack player for self-hosted
- Minimal CSS for the page layout
- The video title, description, and transcript (if available)

This is a static-ish HTML page that changes only when metadata is updated. It can be aggressively cached at the CDN level.

---

## Webhook Processing

Mux sends webhooks for events like `video.live_stream.idle` (stream ended), `video.asset.ready` (VOD asset available), and `video.asset.static_renditions.ready`. The server:

1. Verifies the webhook signature (Mux provides a signing secret)
2. Parses the event type and payload
3. Updates the relevant video record in SQLite
4. For `video.asset.ready`: stores the Mux asset ID, playback ID, duration, and resolution
5. For `video.asset.static_renditions.ready`: updates thumbnail URL

This is synchronous request handling -- no job queue needed. The webhook handler reads the payload, updates a row in SQLite, and returns 200. If the update fails, Mux retries the webhook automatically.

For the self-hosted fallback, the "webhook" equivalent is the server's own internal event system: when an encoding job completes, update the video record and HLS playlist.

---

## Deployment

### Recommended: Single VPS

**Server:** Hetzner CX22 (2 vCPU, 4 GB RAM, 40 GB disk, ~$5/mo) or similar. Runs:
- Bun (or Node.js) process for the Hono server
- Litestream sidecar for SQLite replication to R2
- (Self-hosted fallback) FFmpeg for encoding jobs

**Process management:** systemd unit file. `bun run server.ts` as a service. Auto-restart on crash. Log to journald.

**TLS:** Caddy as a reverse proxy handles automatic HTTPS via Let's Encrypt. Caddy proxies `v.danny.is` to the Hono server on localhost.

**Updates:** Build locally (or in CI), `scp` the built files to the server, restart the service. Or use a simple deploy script. Docker is available but not required for this stack.

**Monitoring:** Simple health check endpoint (`GET /health`). Uptime monitoring via an external service (UptimeRobot, Healthchecks.io). Error logging to stdout (journald captures it).

**Backup:**
- SQLite database: Litestream replicates to R2 continuously
- Application code: in Git, rebuilt from source
- Video files: in Mux (primary) and R2 (backup)

### Alternative: Docker on VPS

For those who prefer containerized deployment:

```dockerfile
FROM oven/bun:latest
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build
EXPOSE 3000
CMD ["bun", "run", "dist/server.js"]
```

Docker Compose for the server + Litestream + Caddy. More structured than bare metal, useful if you want reproducible deployments.

---

## Project Structure

```
server/
  src/
    index.ts                 # Hono app entry point
    routes/
      api.ts                 # Desktop app + admin API routes
      public.ts              # Video pages, embed, oEmbed
      webhooks.ts            # Mux webhook handler
      auth.ts                # Login/logout/session
    db/
      schema.ts              # Drizzle schema definitions
      migrations/            # Drizzle migration files
      index.ts               # Database connection
    services/
      mux.ts                 # Mux API client wrapper
      storage.ts             # R2/S3 operations
      videos.ts              # Video business logic
      slugs.ts               # Slug generation and redirect management
    templates/
      video-page.tsx         # Video page HTML template (Hono JSX)
      embed-page.tsx         # Embed page HTML template
    middleware/
      auth.ts                # API key + session auth middleware
      error.ts               # Error handling
  admin/                     # React SPA (Vite)
    src/
      App.tsx
      pages/
        VideoList.tsx
        VideoDetail.tsx
        Import.tsx
        Settings.tsx
      components/
        VideoPlayer.tsx      # Vidstack/mux-player wrapper
        VideoForm.tsx
        UploadDialog.tsx
      api/
        client.ts            # Type-safe API client (Hono RPC)
  drizzle.config.ts
  package.json
  Dockerfile
```

---

## Integration Points

### Desktop App (Swift) -> Server

The desktop app needs to:
1. Call `POST /api/videos` to create a video record and get a Mux stream key. Authenticated with the API key.
2. Push RTMP to Mux directly (not through our server).
3. Call `POST /api/videos/:id/complete` when recording stops.
4. Optionally call `PATCH /api/videos/:id` to set title/slug from the app.
5. Upload the local backup to R2 (using pre-signed URLs from the server, or directly via the R2 API).

The Swift app uses `URLSession` for HTTP calls. The API key is stored in the macOS Keychain. Type definitions for the API request/response shapes would be maintained manually in Swift (or generated from an OpenAPI spec that Hono can produce).

### Server -> Mux

The server uses the `@mux/mux-node` SDK to:
1. Create a live stream (returns stream key and playback ID)
2. Query asset status
3. Delete assets when videos are deleted
4. Get signed playback tokens (if using signed URLs)

All Mux API calls are made server-side. The desktop app never talks to Mux's API directly (only pushes RTMP).

### Server -> R2

The server uses the AWS S3 SDK (`@aws-sdk/client-s3`) to:
1. Generate pre-signed upload URLs for the desktop app's backup uploads
2. Store thumbnails
3. (Self-hosted fallback) Store HLS segments and playlists
4. Delete objects when videos are deleted

### Server -> Viewer

The server renders HTML pages for `/:slug` and `/embed/:slug`. These pages:
1. Include `<mux-player>` web component (loaded from CDN) pointed at the Mux playback ID
2. Include OG tags, Twitter Cards, and oEmbed discovery for link previews
3. Are cacheable (long TTL for completed videos, short TTL during recording)

---

## Self-Hosted Fallback: Additional Components

If we move away from Mux to self-hosted (R2 + FFmpeg), the server gains:

**Segment receiver:** An endpoint (`PUT /api/videos/:id/segments/:n`) that accepts fMP4 segments from the desktop app, writes them to R2, and updates the HLS playlist in R2. This runs during recording and must be fast and reliable.

**Playlist manager:** Logic to construct and update HLS EVENT playlists as segments arrive, then finalise them with `#EXT-X-ENDLIST` when recording completes. (Detailed in `02-streaming-upload-architecture.md`.)

**FFmpeg job runner:** A background process that takes completed recordings and generates multi-bitrate HLS renditions. At our volume (~75 videos/month, ~3 minutes each), a simple SQLite-backed job queue is sufficient:
1. Insert a job row into `encoding_jobs` when a recording completes
2. A polling loop picks up pending jobs, spawns FFmpeg via `Bun.spawn` / `child_process`
3. On completion, update the job status and the video's HLS playlist URL
4. On failure, mark the job as failed and alert (log, or send a notification)

No Redis, no Celery, no BullMQ. A SQLite table and a polling loop handle 75 jobs/month comfortably.

**Thumbnail generator:** FFmpeg extracts a frame at a configurable timestamp (default: 25% through the video) and uploads it to R2.

The self-hosted path adds ~500-1000 lines of code to the server. It is a meaningful increase in scope but not a fundamentally different application. The Hono + Drizzle + SQLite stack handles both scenarios without architectural changes.

---

## Summary

| Decision | Choice | Rationale |
|---|---|---|
| **Language** | TypeScript | Type sharing with admin UI and Mux SDK, AI-assisted maintainability |
| **Runtime** | Bun | Fast, native SQLite, single-file compilation |
| **Web framework** | Hono | Lightweight, fast, clean API, right size for the server |
| **ORM** | Drizzle | Type-safe SQLite queries, migrations, minimal abstraction |
| **Database** | SQLite + FTS5 | Single-file, zero ops, full-text search built in, Litestream for backup |
| **Admin UI** | React SPA (Vite + Shadcn) | Decoupled from server, type-safe via Hono RPC, Vidstack integration |
| **Video pages** | Server-rendered HTML (Hono JSX) | Fast, cacheable, proper OG tags, no client framework needed |
| **Auth** | API key (desktop) + session cookie (admin) | Simplest secure approach for single-user |
| **Background jobs** | In-process (webhooks are synchronous; FFmpeg jobs via polling loop) | No Redis/Celery needed at our scale |
| **Deployment** | VPS + systemd + Caddy + Litestream | Simple, cheap, reliable |
| **Backup** | Litestream -> R2 (database), Mux + R2 (videos) | Continuous, cheap, point-in-time recovery |

---

## Sources

- Hono documentation: https://hono.dev/docs/
- Drizzle ORM documentation: https://orm.drizzle.team/docs/overview
- SQLite FTS5 documentation: https://www.sqlite.org/fts5.html
- Litestream documentation: https://litestream.io/
- Mux Node.js SDK: https://github.com/muxinc/mux-node-sdk
- Mux Video API documentation: https://docs.mux.com/
- Cap codebase analysis: `docs/research/03-cap-codebase-analysis.md`
- Video hosting build vs buy: `docs/research/04-video-hosting-build-vs-buy.md`
- Streaming upload architecture: `docs/research/02-streaming-upload-architecture.md`
- Open source video platforms survey: `docs/research/10-open-source-video-platforms.md`
- PocketBase (Go + SQLite reference): https://pocketbase.io/
- Django Admin documentation: https://docs.djangoproject.com/en/5.2/ref/contrib/admin/
