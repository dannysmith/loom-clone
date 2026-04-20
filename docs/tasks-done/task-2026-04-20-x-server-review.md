# Server Code Review

Comprehensive review of the Hono + Bun server. Covers architecture, code quality, security, performance, testing, and maintainability. Conducted against `server/src/` (50 files, 200 tests, all passing).

## Executive Summary

This is a well-architected, well-documented codebase for a personal tool. The security posture is strong, the abstractions are at the right level, and the code quality is consistently high. There are no critical bugs or security vulnerabilities. The actionable items below are improvements that would matter as the tool moves beyond localhost — particularly the missing WAL mode, absent cache headers, and a handful of test gaps that leave the most-exercised code paths (Range requests, URL construction) unverified.

---

## High Priority

### 1. SQLite not in WAL mode

`src/db/client.ts` line 26 — `PRAGMA foreign_keys = ON` is set, but `journal_mode = WAL` is not.

WAL (Write-Ahead Logging) is strongly recommended for any SQLite database with concurrent readers and writers. This server does both: derivative generation writes duration/status updates while the main request loop handles reads. Without WAL, concurrent access can hit `SQLITE_BUSY` errors, especially under the healing flow where `/complete` triggers background writes.

**Fix:** One-line addition after the foreign keys pragma:
```ts
sqlite.exec("PRAGMA journal_mode = WAL");
```

### 2. `NaN` propagation in pagination limit

`src/routes/api/videos.ts` line 86:
```ts
const limit = Number(c.req.query("limit") ?? 20);
```

`Number("not-a-number")` returns `NaN`. The store's `Math.min(Math.max(opts.limit ?? 20, 1), 100)` doesn't rescue it — `Math.max(NaN, 1)` returns `NaN`, and `db.limit(NaN)` has undefined behavior. A request like `?limit=abc` would either return all rows or throw a driver error.

**Fix:** `Number(c.req.query("limit")) || 20` — the `||` coerces both `NaN` and `0` to the default.

### 3. oEmbed URL parsing throws on malformed input

`src/routes/site/oembed.ts` line 17:
```ts
const pathname = url.startsWith("http") ? new URL(url).pathname : url;
```

`new URL("httpgarbage")` throws `TypeError`. The `startsWith("http")` guard is too loose — it matches strings that look URL-ish but aren't parseable.

**Fix:** Wrap in try/catch or use `URL.canParse(url)` (available since Bun 1.0):
```ts
const pathname = URL.canParse(url) ? new URL(url).pathname : url;
```

### 4. No cache headers on media responses

`src/lib/file-serve.ts` — `serveFileWithRange` returns `Content-Type`, `Content-Length`, and `Accept-Ranges` but no `Cache-Control` or `ETag`. HLS segments and derivatives (source.mp4, thumbnail.jpg) are immutable once written — every browser request goes to disk unnecessarily.

This is tolerable on localhost but will matter the moment the server is exposed to the internet (task-x3) or fronted by Cloudflare.

**Fix:** Add `Cache-Control: public, max-age=31536000, immutable` for derivative files; shorter TTLs for HLS segments during recording (they may still be healing).

### 5. Missing `await` on transaction in `updateSlug`

`src/lib/store.ts` line 384:
```ts
db.transaction((tx) => {
  tx.insert(slugRedirects).values({ ... }).run();
  tx.update(videos).set({ ... }).where(eq(videos.id, id)).run();
});
```

The function is `async` and every other DB operation uses `await`. The missing `await` works because Drizzle's bun-sqlite driver is synchronous, but it's misleading to readers and fragile against driver changes.

**Fix:** Add `await` for consistency: `await db.transaction(...)`.

---

## Moderate Priority

### 6. `ConflictError` used for validation failures

`src/lib/store.ts` lines 74-86 — `validateSlugFormat()` throws `ConflictError` for format violations (too long, invalid characters, reserved word). These are 400-class input validation errors, not 409 conflicts. The API error handler maps all `ConflictError` to 409, meaning a client sending `PATCH { slug: "!!!" }` would get `409 Conflict` instead of `400 Bad Request`.

**Fix:** Introduce a `ValidationError` class (or reuse the existing `VALIDATION_ERROR` code) and map it to 400 in the API error handler. Reserve `ConflictError` for actual resource conflicts (slug already taken by another video).

### 7. No body size limit on segment uploads

`src/routes/api/videos.ts` line 154:
```ts
const body = await c.req.arrayBuffer();
```

Reads the entire request body into memory with no size guard. A normal segment is ~500KB-2MB. A buggy or malicious client could send gigabytes and exhaust memory. Since this is bearer-authed and single-user, the blast radius is self-DoS, but a generous limit (50MB) would be cheap insurance.

**Fix:** Check `Content-Length` header and reject early, or use Hono's `bodyLimit` middleware on the segment route.

### 8. TOCTOU race in tag creation

`src/lib/tags.ts` lines 14-19:
```ts
const existing = await getDb().select().from(tags).where(eq(tags.name, trimmed)).get();
if (existing) throw new ConflictError(`Tag "${trimmed}" already exists`);
const [tag] = await getDb().insert(tags).values({ name: trimmed }).returning();
```

Check-then-insert race: two concurrent requests creating the same tag name could both pass the existence check. The DB UNIQUE constraint would catch this as a raw SQLite error rather than a clean `ConflictError`. Same pattern in `renameTag`.

**Fix:** Use `INSERT ... ON CONFLICT DO NOTHING` and check the returned row, or catch the unique constraint violation and wrap it.

### 9. `POST /:id/complete` swallows malformed JSON silently

`src/routes/api/videos.ts` lines 186-197 — if the JSON body is malformed, the error is logged and the endpoint proceeds as if no timeline was provided, potentially marking the video `complete` with missing segments. A malformed body likely indicates a client bug and should return 400.

**Fix:** Distinguish between absent body (legitimate — old clients, curl testing) and malformed body (client bug → 400).

### 10. `Bun.which("ffmpeg")` called on every invocation

`src/lib/derivatives.ts` line 23 — `Bun.which` does a PATH scan each time `runFfmpeg` is called. For source.mp4 + thumbnail per video this is 2 scans, but as recipes grow it becomes wasteful.

**Fix:** Cache the result at module level:
```ts
let ffmpegPath: string | null | undefined; // undefined = not yet checked
```

### 11. Hardcoded OG video dimensions

`src/views/viewer/VideoPage.tsx` lines 52-53 — `og:video:width` and `og:video:height` are always 1280x720 regardless of actual video size. The schema has `width`/`height` columns ready.

**Fix:** When width/height are populated (future ffprobe step), pass them through. Low priority until that metadata is actually collected.

### 12. Viewer CSS hardcodes colors instead of tokens

`public/styles/viewer.css` uses ~10 raw OKLCH values rather than the token custom properties from `tokens.css`. The admin styles correctly reference `var(--color-*)`. If the design system hue ever changes, the viewer won't follow.

**Fix:** Replace raw values with token references, or at least define viewer-specific tokens in `tokens.css` so there's a single source of truth.

---

## Test Gaps (Priority Order)

### Critical: `parseRange` has no unit tests

`src/lib/file-serve.ts` — the Range-request parser handles suffix ranges, open-ended ranges, malformed headers, and boundary conditions. It's exercised by exactly one integration test (`bytes=2-5`). Missing coverage:
- Suffix ranges (`bytes=-500`)
- Open-ended ranges (`bytes=500-`)
- Malformed headers (should return null → 416)
- Out-of-bounds ranges
- Edge case: `start > end`
- Edge case: zero-size file

This is the code that makes video seeking work. A regression here silently breaks playback in browsers.

### High: `url.ts` has no tests

`getPublicBaseUrl()` and `absoluteUrl()` construct every URL the server emits — API responses, OG tags, sitemap, oEmbed, clipboard URLs. A trailing-slash bug or env-variable handling regression would corrupt all URLs with no test catching it.

### High: `format.ts` has no tests

`formatDuration` and `formatDate` are pure functions with branching logic (null, zero, sub-minute, minutes+seconds, exact minutes). Used in `.md` metadata and viewer pages. Trivial to test, currently unverified.

### Moderate: API `onError` handler (ConflictError → 409) is untested

The slug conflict error mapping in `src/routes/api/index.ts` is never exercised through the HTTP layer. If the handler were removed, store-level ConflictErrors would bubble as 500s with no test failing.

### Moderate: `POST /:id/complete` graceful degradation for malformed JSON is untested

The try/catch path that logs and continues when JSON is unparseable has no test.

---

## Minor Nits

| Location | Issue |
|----------|-------|
| `store.ts:235` | `addSegment` does an extra SELECT per segment upload to check video existence; FK constraint already enforces this |
| `format.ts:5-8` | `formatDuration(0.3)` → "0s" (rounds to zero); `Math.max(1, ...)` or "< 1s" would be more accurate |
| `events.ts:8` | Event `type` is `string`; a union type would catch typos at compile time without affecting the DB schema |
| `url.ts:27-32` | `getPublicBaseUrl()` re-reads env and runs regex on every call; negligible cost but easy to cache |
| `store.ts:13` | `VideoRecord` type alias (= `Video`) adds indirection with no added value |
| `oembed.ts:38` | `author_name: "Danny Smith"` hardcoded; fine for personal tool, move to config if ever generalized |
| `well-known.tsx:82-88` | `escapeXml` doesn't escape single quotes (`&apos;`); not exploitable in current usage |
| `videos/index.ts:20` | `/v/:slug/*` redirect uses string replacement; safe because `c.req.path` excludes query strings, but fragile-looking |
| `metadata.ts:12` | JSON 404 uses `{ error: "Not found" }` without a `code` field — hybrid of JSON-error and text-error conventions |
| `embed.css:3-5` | Targets unqualified `html` selector; only safe because it's loaded exclusively on embed pages |
| `public/styles/components.css` | Empty placeholder file fetched on every page load |

---

## Things Done Well

### Architecture

- **Clean module boundaries.** Four route modules with distinct auth profiles, mounted in deliberate order. Each module has a single clear responsibility.
- **Side-effect-free app factory.** `createApp()` in `app.ts` is pure; `index.ts` handles the side effects (DB init, server binding). Tests import the factory directly.
- **Abstraction level is right.** `resolveForViewer` encapsulates four concerns (slug lookup, redirect detection, derivative checks, URL building) without over-abstracting. `videoToApiJson` prevents response shape drift between list and detail endpoints.
- **Shared concerns live in `lib/`, not scattered across routes.** Store, playlist, derivatives, auth, errors, URL building, file serving, formatting — each in its own file with a single responsibility.

### Security

- **Layered path traversal defense.** Regex allowlists are the primary defense on both segment uploads and media serving. Belt-and-braces `resolve()` + `startsWith()` checks are added even though the allowlist already prevents traversal.
- **Auth boundary is clean.** Bearer middleware applied at the mount point in `app.ts`, not scattered across routes. Middleware follows RFC 6750 correctly.
- **API key design.** SHA-256 for high-entropy tokens (correct — not bcrypt). `lck_` prefix for leak detection. Plaintext never stored. The design rationale is documented in code comments.
- **Filename allowlists everywhere.** Segment uploads, raw media, stream files, poster — all have explicit allowlists. No path is constructable from user input alone.

### Reliability

- **Crash-safe derivative generation.** Write to `.tmp`, atomic rename to final on success, cleanup on failure. Half-written files can never be served.
- **Idempotent segment uploads.** Re-uploading the same filename overwrites cleanly and rebuilds the playlist. Safe for healing retries and network hiccups.
- **Permanent URLs.** Slug changes atomically write a redirect + update the video in a transaction. Old URLs never break.
- **Fire-and-forget with deduplication.** `scheduleDerivatives` collapses concurrent calls for the same video into one ffmpeg run.
- **Soft delete with opt-in.** Trashed videos are hidden from all default queries. Routes can opt in with `{ includeTrashed: true }`.

### Code Quality

- **Comments explain *why*, not *what*.** The timing-attack rationale in `api-keys.ts`, the ffmpeg `movflags +faststart` explanation, the `noUncheckedIndexedAccess` handling throughout.
- **Consistent patterns.** Every mutation: check existence → compute changes → write atomically → log event → return. Idempotency is explicit where it matters.
- **Schema design is appropriate.** Composite PKs, targeted indexes (including the reverse-lookup index on `video_tags`), cascade deletes, the documented `nowIso()` pattern to avoid SQLite's timezone trap.
- **Clean test infrastructure.** Per-test filesystem isolation + in-memory SQLite. Real filesystem, real SQL — no mocks. Tests run in <1 second.

### Developer Experience

- `CLAUDE.md` is thorough and accurate — a new contributor (human or AI) can orient quickly.
- Error codes are machine-readable with consistent structure (`{ error, code }`).
- The `scripts/` directory provides working CLI tools (key management) that exercise the same code paths as the API.
- All tools pass cleanly: `bun run check`, `bun run typecheck`, `bun test` — zero warnings.

---

## Recommendations Summary (Ranked)

1. **Add `PRAGMA journal_mode = WAL`** — one-line fix, prevents `SQLITE_BUSY` under concurrency
2. **Fix NaN limit propagation** — one-line fix, prevents undefined behavior on bad input
3. **Add `parseRange` unit tests** — highest-value test addition, protects video seeking
4. **Add tests for `url.ts`** — every URL the server emits depends on this code
5. **Fix oEmbed URL parsing** — try/catch or `URL.canParse()`, prevents unhandled throw
6. **Add cache headers to media responses** — matters once deployed, cheap to add now
7. **Split `ConflictError` into `ConflictError` + `ValidationError`** — correct HTTP semantics
8. **Add `await` to `updateSlug` transaction** — consistency fix, zero runtime cost
9. **Add body size limit on segment uploads** — `bodyLimit` middleware, defensive
10. **Add `format.ts` tests** — pure functions, trivial to test, currently unverified
