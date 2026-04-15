# Task 2 — Server-Side MP4 Generation

After every recording converges to `status: "complete"`, the server generates a single-file MP4 stitched from the HLS segments plus a JPEG thumbnail. The viewer page prefers the MP4 when it exists and falls back to HLS otherwise, preserving the "URL-on-clipboard works immediately" principle.

The design is shaped so that additional derivatives (downsampled MP4 variants, adaptive-bitrate HLS playlists) can be added later by appending to a recipe list, without reshuffling directory layouts, routes, or state.

---

## Context

- Today every video is served as HLS only (`stream.m3u8` + `seg_*.m4s`). There is no single-file MP4 and no thumbnail.
- The server knows when a video is fully converged: `/complete` sets `video.json` `status` to `"complete"` iff the client's expected segment list matches what's on disk (see `task-1-upload-resilience-and-reconciliation.md`). Healing paths re-hit `/complete`, so a recording that arrived incomplete and was later healed will transition `healing → complete` at the end of the heal.
- The server runs on Hetzner; `ffmpeg` is available there and locally. Derivative generation will shell out to `ffmpeg` via `Bun.spawn`.
- HLS segments (`init.mp4`, `seg_*.m4s`) are retained. The MP4 is produced alongside, not instead.

---

## Artifact layout

Derivatives live in a subdirectory per video:

```
server/data/<id>/
  init.mp4, seg_*.m4s, stream.m3u8, segments.json, video.json, recording.json   # existing
  derivatives/
    source.mp4          # 1:1 stitch of HLS segments, no re-encode
    thumbnail.jpg       # single-frame extract, ~1280px wide
    # future: 1080p.mp4, 720p.mp4, hls/master.m3u8 …
```

`source.mp4` is the full-resolution, lossless stitch — the "download me" file. All future variants are derivatives of `source.mp4` (never of the m4s segments), so the single-source-of-truth chain is clear.

**Disk is truth.** Readiness of any derivative is signalled by the presence of its final file. Generation writes a `<name>.tmp` first and renames atomically on success. No new fields in `video.json`.

---

## Phase 1 — Derivatives generation

### Goal

Produce `source.mp4` and `thumbnail.jpg` on disk whenever a video transitions to `status: "complete"`. Fire-and-forget from the `/complete` handler — the client's stop flow is never blocked waiting for ffmpeg. Idempotent: repeated triggers collapse to a single generation, and a re-run after healing cleanly overwrites the stale output.

### Why this matters

The viewer integration in Phase 2 depends on files being on disk. Phase 1 is the plumbing; it has no user-visible effect on its own (the viewer keeps using HLS until Phase 2 lands) but can be validated in isolation by hitting `/complete` and watching `derivatives/` populate.

### Behaviour after this lands

- On every successful `/complete` call whose response shows `status: "complete"`, the server kicks off derivative generation in the background.
- A "recipe list" declares the derivatives to produce. v1 recipes: `source.mp4` (from `stream.m3u8`, `-c copy`), then `thumbnail.jpg` (from `source.mp4`, single frame at ~1s).
- Recipes run sequentially in list order so thumbnail can safely depend on the source file existing.
- Each recipe writes `<filename>.tmp` then renames to `<filename>` atomically. Partial output on failure is `.tmp` only — never a half-written final file.
- A per-video in-memory promise cache (`Map<videoId, Promise<void>>`) prevents concurrent generation for the same video. If `/complete` fires twice back-to-back, the second caller awaits the same promise.
- A healed recording that re-hits `/complete` regenerates the derivatives, overwriting the previous `source.mp4` and `thumbnail.jpg` atomically. No special "invalidate" logic needed — the transition is the trigger.
- Generation failures are logged but never surfaced to the client. The m3u8 playlist remains valid; the viewer simply falls back to HLS in Phase 2 when MP4 is missing.

### Implementation outline

**`server/src/lib/derivatives.ts`** (new):

- `interface Recipe { filename: string; generate(videoId: string, dir: string): Promise<void> }` — each recipe declares its output filename (relative to `data/<id>/derivatives/`) and a function that writes `<filename>.tmp` into `dir` and resolves when done.
- Two recipes for v1:
  - `sourceMp4Recipe` — invokes `ffmpeg -i data/<id>/stream.m3u8 -c copy data/<id>/derivatives/source.mp4.tmp`.
  - `thumbnailRecipe` — invokes `ffmpeg -i data/<id>/derivatives/source.mp4 -ss <t> -vframes 1 -vf "scale=1280:-1" data/<id>/derivatives/thumbnail.jpg.tmp`, where `t` is `min(1.0, duration/2)` clamped to the recording length. Duration can be read from `segments.json` (sum of values) or from `source.mp4` via ffprobe; pick whichever is cleanest.
- `scheduleDerivatives(videoId: string): void` — synchronous fire-and-forget entry point. Looks up or creates a promise in the per-video cache, then returns. Does **not** `await`.
- `generateDerivatives(videoId: string): Promise<void>` — the cached promise body. Creates `derivatives/` if needed, iterates recipes in order, awaits each. On success, renames `.tmp` to final. On failure, logs with recipe name + videoId, removes the `.tmp`, and continues to the next recipe (failures are independent; a broken thumbnail shouldn't erase the mp4).
- `ffmpeg` is assumed on PATH. Add a one-time startup log line on first use if the binary isn't found (warning, not fatal).

**`server/src/routes/videos.ts`**:

- In the `/complete` handler, after computing `nextStatus` and writing the playlist, if `nextStatus === "complete"` call `scheduleDerivatives(id)`. No await.

### Validation

- **Clean recording → complete.** Record normally. After `/complete`, `derivatives/source.mp4` and `derivatives/thumbnail.jpg` appear within a second or two. Duration of `source.mp4` matches the recording's logical duration. Thumbnail is a recognisable frame.
- **Recording that heals.** Record with an induced outage so some segments arrive late via heal. Final `/complete` (after heal) regenerates derivatives; `source.mp4` reflects the full healed segment set (verify by duration or by `ffprobe -show_format`).
- **Concurrent `/complete` calls.** Fire `/complete` twice in quick succession via curl. Only one ffmpeg process should run per recipe; verify via logs or by spot-checking that the `.tmp` file doesn't flicker.
- **Generation failure.** Temporarily break the recipe (e.g. point it at a nonexistent input). Confirm: error logged, no `.tmp` left behind, m3u8 still valid, `/complete` response still 200.

### Exit criteria

- [ ] `server/data/<id>/derivatives/source.mp4` is produced after every complete transition
- [ ] `server/data/<id>/derivatives/thumbnail.jpg` is produced after every complete transition
- [ ] Writes are atomic: no partial final files on failure
- [ ] Generation is idempotent — repeated `/complete` calls collapse via the per-video promise cache
- [ ] A healed recording's final `/complete` regenerates both derivatives (verify with a dropped-segment test)
- [ ] `/complete` response latency is unchanged (generation runs after the response is sent)
- [ ] Recipe list is additive — adding a new recipe is a single append, no changes to the orchestrator
- [ ] ffmpeg failures are logged, don't affect `/complete` status or m3u8

---

## Phase 2 — Viewer chooses MP4 when available

### Goal

The playback page at `/v/:slug` serves the MP4 when `derivatives/source.mp4` exists, and falls back to the current HLS player when it doesn't. The decision is made at request time by checking disk.

### Why this matters

The "share URL is instantly usable" principle from task-1 requires that the URL works even before derivatives are generated (including during heal). Choosing at request time means: a healthy recording serves HLS for ~1 second then transparently upgrades to MP4 on any subsequent page load; a healing recording serves HLS for as long as healing takes, then upgrades once done. No client-side smarts, no state tracked.

### Behaviour after this lands

- Viewer page checks for `data/<id>/derivatives/source.mp4` on each `GET /v/:slug` request.
- If present: render a simpler `<video>`-based page backed by the MP4 file.
- If absent: render the current Vidstack HLS player pointed at `stream.m3u8`.
- Implementation choice: either two distinct HTML responses, or one Vidstack-based page where the `src` attribute swaps between MP4 and m3u8. Pick whichever is cleaner — Vidstack handles both source types, so a single-player-with-switching source is reasonable.
- The `thumbnail.jpg`, if present, is set as the video's poster so the first frame is visible before playback starts. When absent (MP4 not yet generated), omit the poster — no placeholder.

### Implementation outline

**`server/src/routes/playback.ts`**:

- Before rendering, check `existsSync("data/<id>/derivatives/source.mp4")`.
- Build the `src` accordingly: `/data/<id>/derivatives/source.mp4` or `/data/<id>/stream.m3u8`.
- Optionally check `existsSync("data/<id>/derivatives/thumbnail.jpg")` for the poster.
- Static file serving for `data/*` already covers the new paths — no route changes needed.

### Validation

- **Fresh recording.** Record normally, hit `/v/:slug` immediately after stop. First page load serves HLS (derivatives not ready). Refresh after ~2s — now serves MP4. Poster image visible.
- **Healing recording.** Record with a drop, stop. URL serves HLS and is watchable during heal. After heal completes, page load serves MP4.
- **Failed derivative generation.** Force a generation failure (per Phase 1 validation). Viewer page still works — HLS path taken.

### Exit criteria

- [ ] Viewer page serves MP4 when `source.mp4` exists; falls back to HLS otherwise
- [ ] Poster image (thumbnail) is set when present; omitted when absent
- [ ] A recording that's still healing remains playable via the URL the whole time
- [ ] No regression in existing HLS playback behaviour
- [ ] Request-time disk check; no new state tracked in `video.json`

---

## Phase 3 — Update developer docs

Update `docs/developer/streaming-and-healing.md` to reflect the new layout and behaviour:

- Add `derivatives/source.mp4` and `derivatives/thumbnail.jpg` to the server file inventory.
- Add a short "Derivatives" section explaining: generation trigger (complete transition), atomic write pattern, per-video promise cache, recipe list as the extension point for future variants.
- Update the end-to-end flow to mention that `/complete` schedules derivative generation as a background task when it yields `status: "complete"`.
- Update the viewer-related prose (if any) to note that playback prefers MP4 when available.

Keep the "current as of" marker current.

---

## Sequencing

1. Implement Phase 1 (generation plumbing).
2. Validate Phase 1 exit criteria — verify derivatives appear on disk for both clean and healed recordings.
3. Commit Phase 1.
4. Implement Phase 2 (viewer chooses MP4 when ready).
5. Validate Phase 2 exit criteria with real recordings.
6. Commit Phase 2.
7. Update `docs/developer/streaming-and-healing.md` per Phase 3. Commit.

Each phase must leave the app and server in a shippable state.

---

## Follow-ups not in this task

- **Multi-variant downsampling** (`1080p.mp4`, `720p.mp4`). Recipe list is the extension point — add entries, respecting a no-upsampling rule (skip a variant if `source` height is already below the target). Deferred because the personal-use case doesn't currently need adaptive bitrate.
- **Adaptive-bitrate HLS master playlist**. When multi-variant lands, a `derivatives/hls/master.m3u8` referencing multiple variant playlists becomes the "smart" serve target. Deferred.
- **Server-startup self-heal for missing derivatives.** Out of scope per design call — we accept that a server crash mid-generation leaves derivatives missing until the next complete transition. If that gap turns out to matter in practice, add a startup scan modeled on `HealAgent.runStartupScan()`.
- **Thumbnail picker heuristics.** v1 uses a fixed timestamp (`min(1s, duration/2)`). Smarter selection (e.g. brightness or motion heuristic) is a polish item.
- **Download button on viewer page.** Linking `/data/<id>/derivatives/source.mp4` from a button is trivial once the file exists. Out of scope here.
- **Derivative garbage collection.** A video that's deleted removes the whole `data/<id>/` tree — derivatives go with it. Separate cleanup for orphaned derivatives isn't needed.
