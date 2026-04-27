# Task 3 — Basic View Analytics

**Goal**: Know whether anyone has watched a given video, how many times, and roughly when. Keep it simple.

## Decision: Simple Analytics (client-side)

We already use [Simple Analytics](https://www.simpleanalytics.com/) on `danny.is` and other subdomains. Adding the SA script tag to the video and embed pages is the simplest path — one `<script>` tag, zero backend work, and it answers the core question.

**Why SA works well here:**
- Already in use, no new account or billing
- Each slug is a distinct page path, so SA automatically gives per-video view counts and timeline
- Works behind any future CDN/Cloudflare Workers layer (fires from the viewer's browser)
- Handles bot filtering, deduplication, referrer tracking — things we don't want to build
- Privacy-friendly, no cookies

**What it doesn't cover:**
- View counts inside the admin panel (would need SA API or an internal counter)
- Direct hits to non-HTML endpoints (`.mp4`, `.json`, `.md`)
- Video engagement (play/pause/completion) — not needed now

## Future: Internal view tracking via `sendBeacon`

If we later want view counts in the admin panel or tracking of non-HTML endpoints, a `sendBeacon()` call from the viewer page to a lightweight server endpoint is the right approach. Notes for when/if we get there:

- **Do NOT use the `videoEvents` table.** High-frequency view events would drown out meaningful lifecycle events (recording started, derivatives completed, etc.), make those harder to find, and potentially slow queries. Use a separate `videoViews` table (or similar).
- **Exceptions:** A few view-related events *could* go in `videoEvents` — e.g. "first view" or "first embed view" as one-off lifecycle milestones.
- Server-side request logging (in middleware) could also track direct hits to `.json`, `.md`, `.mp4` endpoints — though these wouldn't be captured if a CDN serves them from cache.

## Phases

### Phase 1 — Add Simple Analytics script ✅
SA script added to `VideoPage.tsx` and `EmbedPage.tsx` head sections. Uses the standard `scripts.simpleanalyticscdn.com/latest.js` script (same as `danny.is`). `v.danny.is` registered in the SA dashboard.

### Phase 2 (future, if needed) — Internal view counter
Add a `sendBeacon` endpoint and a `videoViews` table. Show view counts in the admin panel.
