# Task 3: Admin Interface

A web-based admin interface at `/admin` for managing videos, tags, settings, and API keys. Single-user (Danny only), publicly accessible over HTTPS, session-authenticated.

> **Implementation context**: The product requirements below and the Technical Approach / Implementation Plan at the bottom of this document were developed through detailed discussion and research into current (2026) best practices for Hono + HTMX applications. The technical decisions (HTMX, no client-side framework, no custom elements, vanilla JS sprinkles, signed cookie sessions, plain `hx-boost` navigation) are deliberate — implement as specified. Before starting any phase, read this full document, `server/CLAUDE.md`, and the existing code in `src/lib/store.ts`, `src/routes/admin/`, `src/views/admin/`, and `src/db/schema.ts`.

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

# Technical Approach

Decisions made after researching current (2026) best practices for Hono + HTMX applications.

## Frontend Stack

**HTMX** (~14KB, CDN) for all interactivity. No client-side framework (no React, Preact, Alpine.js, etc). No build step.

The server renders all HTML via Hono JSX. HTMX makes it interactive by fetching HTML fragments and swapping them into the page. A single small vanilla JS file (`admin.js`, ~20-40 lines) handles the few purely client-side interactions: clipboard copy, `<dialog>` opening for confirmations, and file upload progress.

No custom elements / Web Components initially. Every interactive pattern the admin needs is covered by established HTMX patterns or native HTML features:

| Interaction | Approach |
|-------------|----------|
| In-place editing | HTMX click-to-edit partials (zero JS) |
| Search | `hx-trigger="input changed delay:500ms"` |
| Filters & sorting | HTMX form submission, server returns updated list |
| Tabs | Server-driven HATEOAS (server sets active state) |
| Pagination (load more) | Self-replacing button pattern |
| Confirmations | Server-rendered `<dialog>`, auto-opened via JS |
| Dropdowns/menus | Native `popover` attribute (Baseline 2024) |
| Grid/table toggle | `data-view` attribute + CSS |
| File upload | htmx multipart + `htmx:xhr:progress` event |

## Navigation Pattern

Page navigation uses `hx-boost="true"` on the admin body. The server always returns a complete HTML page wrapped in `AdminLayout`. Default `hx-boost` behaviour fetches the full page, extracts the `<body>`, and replaces the current body — so the nav, active states, and content all update on each navigation.

This avoids all history/caching bugs associated with conditional fragment-vs-full-page responses (no `Vary: HX-Request` header juggling). Every URL is a full page that works on direct navigation, browser back/forward, and refresh. Not using `hx-select` to narrow the swap — the nav needs to update on each navigation for active page highlighting, and the bandwidth difference is irrelevant for a single-user admin.

In-page interactions (inline edits, search, filter, tab content, actions) use dedicated fragment routes that return only the relevant HTML partial.

## View Structure

```
src/views/admin/
  pages/         # Full page components (wrapped in AdminLayout)
  partials/      # Fragment components for HTMX swaps (no layout)
  components/    # Shared JSX building blocks used by both
```

Pages always call `AdminLayout`. Partials never include layout chrome. Components are reusable JSX functions used by both (e.g. `VideoCard` appears in full pages and in fragment responses).

## Route Surfaces

A single HTML surface at `/admin/*`. No separate JSON API built initially — deferred until there's a real scripting/automation use case. The route structure is CRUD-logical (RESTful verbs and paths) to facilitate adding a JSON API later.

## Auth

- **Sessions**: signed cookie (~2 week expiry, `SameSite=Lax; Secure; HttpOnly`). No server-side session table.
- **CSRF**: Hono's built-in CSRF middleware (checks `Origin` header on mutations).
- **Admin tokens**: separate system from the macOS app's `lck_` recording API keys. Different table, different prefix (`lca_`), same hash-and-store mechanism. Admin auth middleware accepts either valid session cookie or valid admin bearer token.

## CSS

Extend the existing `@layer` system. Admin styles live in `admin.css` (already linked via `AdminLayout`). Component classes added to the `components` layer as patterns emerge. Same design tokens, same modern CSS approach (nesting, container queries, `:has()`, `light-dark()`).

## TypeScript

`typed-htmx` (dev dependency) for type-safe `hx-*` attributes in Hono JSX. Declaration via `global.d.ts` using the `declare global { namespace Hono }` pattern (required for Hono v4.4+).

---

# Implementation Plan

## Phase 0 — Database Audit ✅

Before building any admin features, audit the current schema (`src/db/schema.ts`) and data model for integrity, future-proofing, and efficiency. This is the first occasion where we rely heavily on the database, so it's worth thinking carefully about design before piling features on top.

Areas to review:

- **Confirm SQLite** — SQLite is almost certainly the right choice for this workload (single user, hundreds to low-thousands of videos, no concurrent write pressure, FTS5 covers the search case). Briefly confirm this reasoning holds against the admin's query patterns and document the decision, rather than running a full evaluation.
- **Primary keys** — videos use UUIDs (matching the on-disk directory name). Confirm this is the right approach for all tables. Consider whether any tables would benefit from different key strategies.
- **Timestamps** — review which tables have `created_at` / `updated_at` and whether any are missing columns that would help with debugging or migration in future.
- **Tags schema** — add `color` column. Decide on storage format (constrained palette name vs hex string).
- **Event log schema** — `video_events.data` is JSON text. Consider whether this is sufficient for the query patterns the admin will need (filtering by event type, date range), or whether certain fields should be promoted to columns.
- **Index coverage** — review existing indexes against the query patterns the admin will introduce (filtered listing, search, tag joins, event lookups by video + date).
- **Foreign key discipline** — confirm all cross-table references have appropriate FK constraints and cascade rules.
- **General hygiene** — look for anything that would make future migrations painful (implicit defaults, missing NOT NULL constraints, columns that should exist but don't).

### Audit Findings

- **SQLite confirmed.** Single user, low-thousands of videos, no concurrent write pressure. WAL mode already enabled. FTS5 (built into SQLite/Bun) covers the full-text search case — use FTS5, not LIKE. The admin's heavier read patterns (filtered listing, tag joins, cursor pagination) are well within SQLite's comfort zone at this scale. No reason to consider Postgres.
- **Primary keys — no changes needed.** UUIDs for videos/apiKeys (match filesystem `data/<id>/` directories), autoincrement integers for tags/events (lookup tables and append-only log), composite natural keys for videoSegments/videoTags/slugRedirects. All appropriate for their use cases.
- **Timestamps — complete coverage, no gaps.** Every table has `createdAt`. Videos additionally has `updatedAt`, `completedAt`, `trashedAt`. ApiKeys has `lastUsedAt`, `revokedAt`. Segments has `uploadedAt`. Tags has only `createdAt` — no `updatedAt`, but tag renames are low-stakes label changes and the video_events table captures per-video tag associations with timestamps, so the audit trail is adequate.
- **Tags schema — `color` column added.** Stored as palette name strings (`"gray"`, `"red"`, `"blue"`, etc.), NOT NULL, defaulting to `"gray"`. Palette names over hex because: readable in queries, CSS maps them to OKLCH values via custom properties, and changing the visual color doesn't require updating rows. Palette: gray, red, orange, yellow, green, teal, blue, indigo, purple, pink (10 colours). Validation is application-side (same pattern as status/visibility enums). Migration `0002` applied. Store functions updated: `createTag` accepts optional color, `updateTag` added for name+color patches, `getVideoTags` returns color.
- **Event log schema — sufficient as-is.** Events are only queried per-video (the `(video_id, created_at)` composite index covers this). No cross-video event queries needed for the admin. JSON `data` column is fine — nothing needs promoting to columns. The `EventType` union is open (DB column is an open string); new types (`untrashed`, `duplicated`, `uploaded`, etc.) get added when the code that writes them is built in later phases.
- **Index coverage — adequate for admin patterns.** Dashboard filtering at hundreds-to-low-thousands of videos will use WHERE clauses on a table scan, which is fast at this scale. Existing indexes cover the important paths: slug unique lookup, `created_at` for sort/pagination, `trashed_at` for exclusion, tag joins in both directions via composite PK + `tag_id` index, event lookup by `(video_id, created_at)`. No new indexes needed now. FTS5 virtual table for search is Phase 3 implementation work, not a schema concern.
- **Foreign key discipline — clean.** All cross-table references have FK constraints with `ON DELETE CASCADE`. `PRAGMA foreign_keys = ON` set per-connection in `createDb()`. ApiKeys has no FKs, which is correct (independent entities).
- **General hygiene — no issues found.** NOT NULL constraints appropriate everywhere. Defaults sensible (status→recording, visibility→unlisted, source→recorded). Nullable columns are the ones that should be nullable (title, description, dimensions, completedAt, trashedAt). ISO-8601 text timestamps consistent across all tables. No implicit defaults, no missing constraints, nothing that would make future migrations painful.

## Phase 1 — Foundation

Set up the HTMX tooling, admin view structure, layout shell, and CSS foundations. After this phase the admin has a working skeleton with navigation between placeholder pages.

- Install `typed-htmx` (dev dep), add `global.d.ts` type augmentation for `hx-*` attributes in Hono JSX.
- Add HTMX `<script>` tag (CDN) to `AdminLayout`.
- Set up `hx-boost="true"` on the admin body for SPA-like navigation (no `hx-select` — full body swap so nav active states update).
- Create the view directory structure: `views/admin/pages/`, `views/admin/partials/`, `views/admin/components/`.
- Flesh out `AdminLayout` with proper nav (links to Dashboard, Settings, Trash Bin).
- Create placeholder pages for each admin route (`/admin`, `/admin/videos/:id`, `/admin/settings`, `/admin/trash`, `/admin/login`).
- Create `public/js/admin.js` (empty scaffold, loaded in AdminLayout).
- Establish admin CSS foundations in `admin.css`: layout grid, nav styling, basic component classes (buttons, badges, form elements).
- Restructure the admin route module to support the new pages.

**Done when:** navigating between all admin pages works via `hx-boost`, the layout/nav is visible, and HTMX is loaded and functional.

## Phase 2 — Auth

Implement the login/session system and admin token mechanism. After this phase, all `/admin/*` routes (except login) are protected.

- Admin password: decide on env var vs CLI approach, implement hashing and verification.
- Login page with username/password form.
- Session mechanism: signed cookie with ~2 week expiry (`SameSite=Lax; Secure; HttpOnly`).
- Auth middleware on `/admin/*` that redirects to `/admin/login` if unauthenticated.
- Logout (clears session cookie).
- Hono CSRF middleware on `/admin/*` mutation routes.
- Admin token table (`admin_tokens`, `lca_` prefix) with create/list/revoke store functions.
- Admin auth middleware accepts either valid session cookie OR valid `lca_` bearer token.

**Done when:** unauthenticated requests to any admin page redirect to login, logging in sets a session cookie, all subsequent navigation works, and bearer token auth works for programmatic access.

## Phase 3 — Dashboard

The video list page with both view modes, search, filtering, sorting, and pagination. This is the first feature that exercises the full HTMX fragment pattern.

- Store layer: extend `listVideosPaginated` (or add a new function) to support filtering by visibility, status, tags, date range, and duration range. Add sorting options.
- Full-text search over title, description, and slug (SQLite FTS5 or LIKE — decide based on Phase 0 findings).
- `VideoCard` component (shared JSX, used in grid and table views).
- Grid/table view toggle via `data-view` attribute + CSS.
- Search input with `hx-trigger="input changed delay:500ms"`, returning the video list partial.
- Filter controls (dropdowns, date pickers) that trigger list refresh via HTMX.
- Sort controls.
- "Load More" pagination (cursor-based, self-replacing button pattern).
- URL state: `hx-replace-url` so search/filter state is bookmarkable and survives refresh.

**Done when:** the dashboard shows all non-trashed videos in both grid and table views, search/filter/sort work with URL persistence, and pagination loads more results.

## Phase 4 — Settings

The settings page with three panes: General, Tags, and API Keys.

- Settings page shell with pane navigation (tabs or sidebar).
- **General pane**: empty or showing read-only system info initially.
- **Tags pane**: CRUD for tags with name and colour (constrained palette). Inline editing of name/colour. Delete with confirmation. Any schema changes needed from Phase 0 (e.g. adding `color` column) should already be applied.
- **API Keys pane**: list all keys (name, created, last used, revoked status), create new key (show token once), revoke. This is a web UI for the existing `api-keys.ts` store functions.

**Done when:** tags can be created/edited/deleted, API keys can be managed via the web UI, and all mutations write events.

## Phase 5 — Video Page (Display)

The video detail page with all display elements. Read-only at this stage — editing comes in Phase 6.

- Page layout: header area (title, slug, visibility badge), player, metadata area (description, tags, duration, dimensions, status, dates, source), tabbed section below.
- Admin media routes: session-gated endpoints that serve video files by video ID regardless of visibility (`/admin/videos/:id/media/:file`). Needed for the player to work on private videos.
- Video player: Vidstack via CDN, admin-specific CSS (no shared styles with the viewer player).
- Event log tab: chronological timeline from `video_events`. Check that existing server operations (derivative generation, healing, completion) are writing events — fill gaps as needed.
- File browser tab: read `data/<id>/` directory tree, display with subfolder expansion and file sizes. Text file preview.

**Done when:** clicking a video card on the dashboard opens its admin page, the player works (including for private videos), metadata is displayed, and both tabs show real data.

## Phase 6 — Video Editing & Metadata

Make the video page interactive. This is where the HTMX click-to-edit partial pattern gets exercised for real — worth isolating so the edit/save/cancel UX can be iterated on without also juggling file duplication logic.

- **In-place editing**: title, slug, description — HTMX click-to-edit partials (GET edit form → swap → PATCH save → swap back to display).
- **Visibility change**: dropdown/segmented control with confirmation dialog.
- **Tag assignment**: add/remove tags on the video, server-driven (each action is an HTMX POST returning updated tag list).

**Done when:** all editable fields save via in-place editing with clean save/cancel UX, visibility changes work with confirmation, and tags can be added/removed.

## Phase 7 — Video Actions & Trash Bin

Implement the remaining video actions and the Trash Bin page.

- **Trash**: confirmation dialog, soft-delete, redirect to dashboard.
- **Duplicate**: copy video row + files, new UUID/slug/title, preserve tags, write events on both original and duplicate, redirect to the new video's admin page.
- **Download**: link to source.mp4 (or derivative chooser if multiple exist).
- **Open Public URL / Copy Public URL**: link + clipboard JS. Only shown for public/unlisted.
- **Trash Bin page** (`/admin/trash`): same card/table display as dashboard, but showing only trashed videos. Untrash action (restores video, redirects to its admin page).

**Done when:** all video actions work, trashing moves videos to the Trash Bin, and untrashing restores them.

## Phase 8 — Upload

Upload an MP4 file to create a new video.

- Upload UI: accessible from the dashboard (button → page or modal). File input (MP4 only), optional metadata fields (title, slug, description, visibility, tags).
- Upload route: accepts multipart form data, creates video record (`source: "uploaded"`), saves the file to `data/<id>/`.
- Progress indication: `htmx:xhr:progress` event updating a `<progress>` element.
- Trigger the existing derivative pipeline (ffmpeg → MP4 transcode + thumbnail). No HLS segments.
- Write `uploaded` event.

**Done when:** a video can be uploaded via the admin, appears on the dashboard, has derivatives generated, and is playable on its video page.

## Phase 9 — Dashboard Card Actions

The final feature deliverable. Add a context menu / dropdown to each video card on the dashboard with quick-access to video actions.

- Context menu or dropdown on cards/rows (using native `popover` attribute).
- Available actions: Open Public URL, Copy Public URL, Change Visibility, Download, Duplicate, Trash.
- Actions call the same endpoints built in Phases 6 and 7.

**Done when:** video actions are accessible from both the video page and the dashboard card menu.

## Phase 10 — Review & Polish

Verify the implementation against all requirements in this document. Not a feature phase — a quality pass.

- Walk through every H2 section under "Task 3: Admin Interface" and confirm all requirements are met.
- Verify events are written for all admin mutations (metadata changes, visibility, slug, trash, untrash, duplicate, upload, tag changes).
- CSS review: check that the admin is usable on smaller viewports, components are consistent, dark/light mode works.
- Test edge cases: empty states (no videos, no tags, no events), long titles/descriptions, many tags, pagination boundaries.
- Update `docs/developer/server-routes-and-api.md` with the new admin routes.
