# Task 3: Admin Interface

A web-based admin interface at `/admin` for managing videos, tags, settings, and API keys. Single-user (Danny only), publicly accessible over HTTPS, session-authenticated.

## Auth

### Admin Login

A login page at `/admin/login` with a username/password form. Single user — no registration, no password reset flow. Credentials are configured via environment variable or CLI command (TBD during implementation).

Sessions are cookie-based with a ~2 week expiry. Logging out clears the session. All `/admin/*` routes (except `/admin/login`) redirect to the login page if unauthenticated.

### Admin API Auth

The `/admin/api/*` endpoints accept two auth methods:

1. **Session cookie** — for the admin web UI's fetch requests.
2. **Admin bearer token** — for future scripting and automation (backup tools, AI-powered metadata enrichment, syncing videos to external systems, etc).

Admin tokens are a **separate system** from the macOS app's `lck_` recording API keys. The recording API (`/api/videos/*`) is for recording clients — creating videos, streaming segments, completing recordings. The admin API is for administration — managing existing videos, tags, settings. These are different concerns with different access patterns and different security boundaries.

## Navigation & Layout

The admin has five pages:

| Page | Path | Purpose |
|------|------|---------|
| Dashboard | `/admin` | Video list with search, filter, pagination |
| Video | `/admin/videos/:id` | View, edit, and manage a single video |
| Settings | `/admin/settings` | General, Tags, API Keys |
| Trash Bin | `/admin/trash` | Trashed videos only |
| Login | `/admin/login` | Unauthenticated login form |

Upload is triggered from the dashboard (button) and either opens a page or modal (TBD during implementation).

The admin layout has a persistent nav (sidebar or top-bar — design TBD) with links to Dashboard, Settings, and Trash Bin. The upload action is accessible from the dashboard.

## Dashboard (Video List)

The main page. Shows all non-trashed videos.

### Views

Two views toggled by the user, with **grid as the default**:

- **Grid** — card layout with thumbnail, title/slug, duration, visibility badge, date etc.
- **Table** — row layout with the same information in columns.

Both views show identical data — the toggle may be achievable with CSS alone (container queries) if the markup is shared.

### Search

Server-side full-text search over title, description, and slug. Must perform well at hundreds to low-thousands of videos. Does not need to handle very long text fields (like future transcriptions).

### Filters & Sorting

Filterable by:
- Visibility (public / unlisted / private)
- Status (recording / healing / complete / failed)
- Tags
- Date range
- Duration range

Sortable by date (default: newest first), duration, title.

The filtering system should be designed so that adding new filterable fields in the future is straightforward as the video schema evolves.

### Pagination

Cursor-based pagination. Infinite scroll or "Load More" button — not numbered pages.

## Video Page

The page for viewing and managing a single video.

### Layout

- **Page header**: Title and slug displayed prominently, editable in-place (click to edit, save/cancel). Clear visibility indicator (badge or similar) that's easy to change.
- **Player**: Below the header. Uses Vidstack (CDN). Fully independent from the viewer-facing player — no shared CSS, no shared code paths. Must work for private videos (served via session-gated admin media routes).
- **Metadata area**: Description (editable in-place where appropriate), tags, duration, dimensions, status, dates, source type. Some fields editable, some read-only.
- **Tabbed section below**: Heavier content in tabs — event log, file browser, and potentially more in future.

### Editable Fields

- **Title** — in-place edit. Optional (can be null).
- **Slug** — in-place edit. Validated (same rules as existing slug validation). Changing a slug adds the old slug to the redirects table and logs an event. No UI for managing redirects.
- **Description** — in-place edit. Optional.
- **Visibility** — easy to change (dropdown or segmented control). Requires confirmation on change. Options: public, unlisted, private.
- **Tags** — add/remove from existing tags.

### File Browser (tab)

Flat listing of all server-side files for this video (`data/<id>/`), with subfolder expansion and file sizes. Text files viewable inline. This is a diagnostic/inspection tool — no file editing or deletion.

Future consideration: when files move to R2/object storage, this should also show object metadata from external storage.

### Event Log (tab)

Chronological timeline of events from the `video_events` table. Shows event type, timestamp, and relevant data. Read-only, oldest first.

Events are already written for: `created`, `completed`, `healed`, `title_changed`, `description_changed`, `visibility_changed`, `slug_changed`, `trashed`. As new admin features are built, they should write events for their mutations.

Pre-existing server operations (derivative generation, healing) should also write events — this is a prerequisite to surface in the task but is implementation work separate from the log viewer itself.

## Video Actions

Actions available on the video page. (Adding these to dashboard cards as context menus is a separate deliverable done later.)

| Action | Behaviour | Availability |
|--------|-----------|--------------|
| Open | Navigate to this video's admin page | Always (this is what clicking a card does) |
| Open Public URL | Opens `/:slug` in a new tab | Public and unlisted only |
| Copy Public URL | Copies the public URL to clipboard | Public and unlisted only |
| Download | Download source.mp4 (or choose derivative if multiple exist) | Always |
| Change Visibility | Change between public/unlisted/private with confirmation | Always |
| Duplicate | See below | Always |
| Trash | Soft-delete with confirmation | Always |

### Duplicate

Creates a complete copy of a video:

- New UUID, new slug (original slug + `-1`, incrementing if taken).
- Title appended with ` (1)` (incrementing if needed).
- All files copied to a new `data/<new-id>/` directory.
- Tags preserved (new records in the join table).
- Visibility, description, and other metadata preserved.
- Does **not** inherit the original's event log — it's a new video with its own history.
- Does **not** create any slug redirects — the duplicate has its own unique slug.
- Event on the original: "Duplicated → `<new-id>`"
- First event on the duplicate: "Duplicated from `<new-id>`"

## Upload

Upload an existing MP4 file to create a new video. Intended for historical videos (Loom exports, YouTube downloads, etc).

- Accepted format: MP4 only.
- Optional metadata at upload time: title, slug, description, visibility, tags. All optional — if blank, treated identically to a video created by the macOS app (random hex slug, unlisted, no title).
- Uploaded videos have `source: "uploaded"` in the database.
- The standard derivative pipeline runs (ffmpeg → MP4 transcode + thumbnail). No HLS segments are created.
- The resulting video's file structure is identical to a recorded video's, minus the HLS segment files (`init.mp4`, `seg_*.m4s`, `stream.m3u8`).

## Settings

Three panes/sections:

### General

May be empty initially. A place for global configuration that's more convenient to change via web UI than via env vars or SSH. Candidates TBD as the system evolves — this is explicitly a "put things here as they arise" section.

### Tags

CRUD interface for managing tags. Each tag has:

- **Name** — text label.
- **Colour** — chosen from a constrained palette (~10 predefined colours for visual differentiation, like GitHub labels).

Editing a tag's name or colour takes effect everywhere immediately (no confirmation needed — it's just a label). Deleting a tag shows a confirmation. Cleanup of the join table on deletion TBD during implementation.

### API Keys

Web UI for managing API keys (replaces the need to SSH in and run CLI commands):

- **List** — shows all keys with name, created date, last used date, revoked status.
- **Create** — generate a new key, show the token once (same as the CLI flow).
- **Revoke** — mark a key as revoked.

This manages the macOS recording API keys (`lck_` tokens for `/api/videos/*`). Admin API tokens (the separate system) may also be managed here in future.

## Trash Bin

A dedicated page at `/admin/trash` showing only trashed videos. Same card/table display as the dashboard.

- Trashed videos are invisible everywhere else in the admin (dashboard, search, filters).
- Trashed videos hold their slugs and redirects (not released until permanent deletion).
- Untrash action: restores the video with its original visibility, slug, and all data intact.
- Permanent deletion / "Empty Trash" is out of scope for now.

## Dashboard Card Actions

Once the dashboard, video page, and all actions are built, the final deliverable is adding a context menu or dropdown to each dashboard card/row with quick-access to video actions (Open Public URL, Copy URL, Change Visibility, Download, Duplicate, Trash). This is deliberately last because it depends on everything else being in place.

## Cross-cutting Requirements

### CSS & Responsiveness

Desktop is the primary target. However, CSS should be written with good modern practices (container queries, CSS grid, custom properties, `@layer`) such that the interface is inherently somewhat usable on smaller viewports. The goal is "good CSS that's responsive by definition" rather than explicitly building for mobile.

### Events & Audit Trail

All admin mutations must write to the `video_events` table. The event log is the "if anything goes weird, I can see what happened" safety net. This includes: metadata changes, visibility changes, slug changes, trashing, untrashing, duplication, upload. Pre-existing server operations (derivative generation, healing) should also write events if they don't already.

### Inline Feedback

Actions that succeed update the UI in-place. No toast notification system needed initially. Confirmations are required for: visibility changes, trashing, and tag deletion.

---

# Implementation Plan

## Phase 0 — Database Audit

Before building any admin features, audit the current schema (`src/db/schema.ts`) and data model for integrity, future-proofing, and efficiency. This is the first occasion where we rely heavily on the database, so it's worth thinking carefully about design before piling features on top.

Areas to review:

- **SQLite vs Postgres** — evaluate whether SQLite remains the right choice given the admin's heavier read/query patterns (filtering, full-text search, pagination), or whether migrating to Postgres is worth the operational cost.
- **Primary keys** — videos use UUIDs (matching the on-disk directory name). Confirm this is the right approach for all tables. Consider whether any tables would benefit from different key strategies.
- **Timestamps** — review which tables have `created_at` / `updated_at` and whether any are missing columns that would help with debugging or migration in future.
- **Tags schema** — add `color` column. Decide on storage format (constrained palette name vs hex string).
- **Event log schema** — `video_events.data` is JSON text. Consider whether this is sufficient for the query patterns the admin will need (filtering by event type, date range), or whether certain fields should be promoted to columns.
- **Index coverage** — review existing indexes against the query patterns the admin will introduce (filtered listing, search, tag joins, event lookups by video + date).
- **Foreign key discipline** — confirm all cross-table references have appropriate FK constraints and cascade rules.
- **General hygiene** — look for anything that would make future migrations painful (implicit defaults, missing NOT NULL constraints, columns that should exist but don't).
