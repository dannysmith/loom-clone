# Post-Processing — Review Fixes & Follow-ups (Task 4)

## Background

A living list of fixes and follow-ups for the post-processing work that landed in [task-4](task-4-post-processing-status-and-robustness.md) (step ledger, `reconcile`, the registry-driven pipeline, status model, readiness UI, reprocess/regenerate controls, edit atomic-set staging). Items are found during the cleanup pass and the code-review session(s) and added here as we go — append freely under "Additional findings".

Each item should be specific enough to implement without re-deriving the context: what's wrong, the desired behaviour, and any open questions to pin during implementation.

---

## 1. Reprocessing an edited video must reset the edit (run from canonical source)

### The problem

The manual reprocess actions — **"Re-run post-processing"**, **"Rebuild from HLS"**, and the heal/incomplete-recovery force re-run — drive the **main** pipeline, which derives everything from `source.mp4` (the original recording). For an **edited** video this is edit-unaware and produces a mismatched set:

- The active raw file is the edited `{H}p.mp4` (e.g. a 1080p source edits to `1080p.mp4`, ~117 s). The main pipeline does **not** regenerate it (there's no `variant_{sourceHeight}` step), so it stays the edited file.
- The main pipeline regenerates the downscaled variants from the **full** `source.mp4`, so e.g. `720p.mp4` becomes the full-length (~120 s) clip. Result: the viewer's quality menu offers an edited 1080p beside a full-length 720p — switching quality jumps content/length.
- Storyboard/captions/metadata/duration similarly drift back towards the full source while the active file stays edited.

(The duration-validation half of this — `source.mp4` being checked against the *edited* `durationSeconds` — is already fixed via `sourceExpectedDuration`; this item is the remaining behavioural half.)

### Desired behaviour

Reprocessing an edited video via the main pipeline should **wash the edit away** and rebuild from the canonical `source.mp4`, leaving a fully consistent, *unedited* video. Concretely, before the pipeline runs we should reset the edit so that afterwards:

- The active raw file is `source.mp4` again (no `{H}p.mp4` orphan left on disk).
- All derivatives (variants, storyboard, thumbnail, peaks, captions, metadata) reflect the full source.
- The DB transcript is the original full transcript, not the edited one.
- `durationSeconds` / `fileBytes` reflect `source.mp4`.
- `lastEditedAt` is cleared, so `activeRawFilename()` resolves back to `source.mp4`.

### Proposed shape

Add a `resetAllEdits(videoId)` (name TBD) in the edit subsystem (`lib/edit-pipeline.ts` or a sibling) that performs the edit reset, and call it at the appropriate point when a reprocess targets an edited video — i.e. when `Re-run`/`Rebuild from HLS` (and the heal force-run) fire on a video with `lastEditedAt` set, run `resetAllEdits` first, then let the main pipeline regenerate everything from `source.mp4`.

`resetAllEdits` roughly needs to:

- Delete the edited output `{sourceHeight}p.mp4` (the only edited file the main pipeline won't overwrite for that source height). The other edited files (variants, viewer storyboard, captions) get overwritten by the subsequent pipeline run, but deleting them up front is cleaner and avoids stale-mismatch windows.
- Re-derive the full transcript + `captions.srt` from `words.json` (the unedited word timings) with no EDL, and upsert it as the DB transcript.
- Clear `lastEditedAt`; let the pipeline's `metadata` step reset `durationSeconds`/`fileBytes`/dimensions from `source.mp4`.

### Open questions / details to pin

- **`edits.json`**: delete it (truly wash away the edit) or keep it so the user could re-apply the same EDL later? The user's framing was "wash away any edits", which leans towards delete — but confirm.
- **Original captions are not preserved separately** — the edit-pipeline overwrites `captions.srt` in place, so the reset re-derives the full transcript from `words.json` (a faithful reconstruction, but not byte-identical to whatever the Mac originally uploaded). Note this limitation; it's acceptable.
- **Per-artifact "↻" regen on edited videos** has the same edit-unaware hazard for source-derived files (regenerating `thumbnail`/`storyboard`/`peaks`/a variant from the full source while the active file is edited). Decide the policy: (a) per-artifact regen on an edited video also triggers the full edit-reset, (b) per-artifact regen is disabled/hidden for edited videos (only the global reprocess, which resets, is offered), or (c) make it edit-aware. (a) or (b) are the coherent options; (c) is more work.
- **Interaction with `reprocessability`/serving**: after a reset the video is unedited, so `activeRawFilename` → `source.mp4`; make sure the readiness/serving gates still line up during the transient.

---

## 2. Confirmation + edit-aware warnings on the regenerate controls

### Current state

In `ReadinessPanel.tsx`:
- **"Re-run post-processing"** — no confirmation.
- **"Rebuild from HLS"** — has an `hx-confirm`.
- Per-artifact **"↻"** regenerate buttons — no confirmation.

### Requirements

- **Every** regenerate control gets a confirmation prompt before firing — the global pair *and* the per-step "↻" buttons. These are destructive-ish (they re-spend ffmpeg and overwrite outputs), so a click shouldn't be a one-tap action.
- For **edited videos**, the controls need to clearly signal that reprocessing will **discard the edit** (per item 1):
  - A visible warning in the Processing tab text when the video is edited — "This is an edited video. Re-running post-processing will discard the edit and rebuild from the original recording."
  - The confirmation copy on the reprocess buttons should say the same, so it's not a surprise.
- Tie the per-artifact policy here to whatever we decide in item 1's open question (reset vs disable vs edit-aware).

---

## Additional findings

### A. Dashboard filter serialization is duplicated

`DashboardFilters` → query-string serialization now lives in two hand-synced places: `filtersToParams` (`routes/admin/helpers.ts`) and `viewToggleUrl` (`views/admin/pages/DashboardPage.tsx`). They drifted once already (`viewToggleUrl` silently dropped the `attention`, date, and duration filters when toggling grid/list view — now fixed). Consolidate into a single shared serializer (and have `parseFilters` round-trip against it) so a new filter can't be added to one without the other. Minor, but it's a recurring footgun.

---

## Code review (session 2)

A second full code-review pass over the branch (9 finder angles + verification). Items ordered correctness-first. Two existing items were independently re-confirmed and need no new entry: **item 1** (the edited-video reprocess hazard — surfaced again from the reconcile/serving angles; note the fix must also cover the heal/incomplete force re-run in `api/videos.ts:280`, not just the two reprocess buttons) and **item A** (the duplicated filter serializer).

### B. `incomplete` videos can be reprocessed but `reconcile` never advances them — they strand (HIGH)

`reconcile()`'s `RECONCILE_OWNED` set (`lib/processing/reconcile.ts:19`) is `{processing, ready, processing_failed}`, but `readiness.ts`'s `REPROCESSABLE` set (`:66`) **includes `incomplete`**. So `canReprocess(incompleteVideo)` is `true`, the admin "Re-run post-processing" button is offered, and `POST /admin/videos/:id/reprocess` accepts it and runs the full pipeline. `runPipeline` never sets status itself — it relies entirely on `reconcile`, which early-returns on every call because `incomplete ∉ RECONCILE_OWNED`.

Result: the pipeline stitches `source.mp4`, validates metadata, marks every step `ready` — and because `resolve.ts` is gated purely on the `source` step (never on `status`), the viewer **starts serving the full MP4** — yet `status` stays `incomplete` forever, so the video is excluded from feeds (`feeds.ts` filters `status='ready'`), the sitemap, and tag pages. A recovered video that plays fine is permanently invisible to every public surface, and nothing else ever transitions it out of `incomplete`.

**Desired behaviour:** decide the intended semantics and make the two sets consistent. Either (a) `reconcile` should own the transition *out of* `incomplete` once a successful run produces validated mandatory steps (the cleanest: derive `RECONCILE_OWNED` from `REPROCESSABLE` minus the genuinely-in-flight/owned-elsewhere states rather than maintaining a second hand-written Set), or (b) `incomplete` should be removed from `REPROCESSABLE` and recovery routed through an explicit re-`/complete`/heal. Add a test for "reprocess an `incomplete` video → it reaches `ready`".

### C. A forced reprocess is silently dropped (with a false success redirect) when any run is in-flight (MED)

`schedule()` in `lib/processing/pipeline.ts:52` collapses **all** runs — `force`, `only`, and plain — to a single in-flight promise per video: `if (inFlight.has(videoId)) { log("skipped"); return; }`. It drops the new request rather than queuing it, and the dedupe comment's justification ("the durable dedupe is the step table / skip-if-ready") only holds for *resumable* runs — it does **not** hold for a `force` or `only` run, whose whole point is to do work the skip-if-ready run won't.

Two concrete failures:
- **UI:** click "Re-run post-processing" (schedules a resumable run), then "Rebuild from HLS" (or a per-artifact `↻`) while it's still running. The second `scheduleReprocess(force:true)` is dropped, but `POST /reprocess` still `302`s to `?tab=processing` as if it succeeded. The forced rebuild / regenerate never happens and the user gets no feedback.
- **Heal:** a video demoted `processing → healing` by a later partial `/complete` can have its original `processing` pipeline still in flight when the heal completes and fires `scheduleReprocess(force:true)` (`api/videos.ts:280`). The force is dropped; the in-flight run skips the already-`ready` `source` step, so the re-uploaded healed segments are never re-stitched — `source.mp4` keeps stale pre-heal footage until a later manual reprocess.

**Desired behaviour:** don't silently drop a `force`/`only` request. At minimum, surface "a run is already in progress" to the admin (don't return a success redirect); better, queue the requested run (or a coalesced "re-run after current"). The heal path especially must not lose its forced re-stitch.

### D. Serving + cleanup gate on the `source` step, but edited videos are served from `{H}p.mp4` — which has no validated ledger entry (MED)

For an edited video, `activeRawFilename(video)` resolves to `{H}p.mp4`, but the serving gate (`resolve.ts:32`, `derivativeFlags`) computes `hasSource = steps.get("source").state === "ready" && Bun.file({H}p.mp4).exists()` — i.e. it takes its *playability evidence* from the `source` step (which validated `source.mp4`) and only does a **bare presence** check on the file it actually serves. The edit-pipeline never writes a step row for its edited output (confirmed: `edit-pipeline.ts` touches neither `markStep*` nor `reconcile`); it validates `{H}p.mp4` with `isProbablyPlayable` only transiently in `.edit-staging`, then discards that result. So the gate's entire thesis — "a byte-complete but semantically-broken MP4 is never served" — **silently does not hold for edited videos**.

Compounding it: `cleanup.ts:49` deletes the HLS segments gating only on the `source` step + `source.mp4` presence. For an edited video whose `{H}p.mp4` later goes missing/corrupt while `source.mp4` stays valid, cleanup still removes the HLS, and `resolve` then finds no active raw file → falls back to `urls.hls`, which no longer exists → the video is unplayable despite a valid `source.mp4` on disk.

**Desired behaviour:** key both the serving gate and the cleanup gate off the file that is actually served. Either record a validated step row for the active raw output (a generalized "active raw" ledger entry the edit-pipeline writes on swap, mirroring how the source step works), or have `derivativeFlags`/`cleanup` follow `activeRawFilename` for *both* the presence check **and** the validity check. (Ties into the altitude note in item N.)

### E. An edit that shortens a video below 60 s leaves the old (longer) storyboard in place (LOW-MED)

`_runEditPipelineInner` (`edit-pipeline.ts:138`) only regenerates the viewer storyboard `if (editedDuration >= 60)`, and the staging swap (`:159`) only renames files that exist in staging. So when a ≥60 s video with a `storyboard.vtt` (step row `ready`) is edited down to <60 s, no new storyboard is staged, the stale `storyboard.vtt` is never replaced or removed, and its step row stays `ready`. The viewer's scrubbing thumbnails then map to timestamps from the *un-edited* timeline.

**Desired behaviour:** when the edited duration drops below the storyboard threshold, delete the stale `storyboard.vtt` (and reflect it in the ledger) as part of the swap. More generally, the swap should reconcile *removals*, not just replacements.

### F. Serving ignores `status` and `metadata`, so `processing_failed` (and the "enriching" badge) can misrepresent a video (LOW)

`resolve.ts` never reads `video.status` and gates only on the `source` step. A video that reaches `processing_failed` because the **`metadata`** step failed while `source` validated (rare but reachable — `isProbablyPlayable` and `extractMetadata` both shell out to ffprobe, but with different requirements) will still be served as a finished MP4 (with null width/height → no Quality menu), contradicting the design's "`processing_failed` → serves HLS". Separately, `computeReadiness`'s badge (`readiness.ts:147`) counts a **failed** expected step toward `enriching (N left)`, so a `ready` video whose `audio` step failed shows "enriching (1 left)" forever — "enriching" implies in-progress, but it's permanently failed. Both are minor; note them and decide whether serving should consider the rollup, and whether the badge should distinguish failed-expected from pending.

### G. Migration `0012` maps `processing → reprocessing`; a deploy mid-edit strands that row (LOW)

`0012_rich_silver_surfer.sql:23` does `UPDATE videos SET status='reprocessing' WHERE status='processing'`. On `main`, `processing` was set **only** by the edit-pipeline's transient re-render, so the mapping is correct for the intended case — but `reprocessing` is owned by neither `reconcile` nor `canReprocess` (and the edit-pipeline process is gone after the deploy restart). If the migration runs while an edit is in flight, that video sits in `reprocessing` forever with no transition path. Narrow, but worth a defensive sweep after deploy (or have the backfill/startup nudge any `reprocessing` row with a validated `source` step back to `ready`).

### H. Dead branch: thumbnail-candidates are never cleaned up (LOW, pre-existing)

`cleanup.ts:78` guards the `thumbnail-candidates` removal with `await Bun.file(candidatesDir).exists()` — but `Bun.file(dir).exists()` returns **`false` for a directory** (verified on Bun 1.3.14), so that branch never runs and candidate frames accumulate indefinitely. Pre-existing on `main`, but it lives in the function this PR rewrote for cleanup-correctness, so fix it here: use `fs/promises` `stat`/`readdir` (or `existsSync`) for the directory check.

### I. Transitions *out of* `ready` don't purge the CDN feeds (LOW)

`markVideoReady` (`store.ts:692`) calls `purgeGlobalFeeds()`, but the reverse transitions (`ready → processing_failed`/`processing` via `setVideoStatus` inside `reconcile`) don't. The origin feed query filters `status='ready'` so it self-corrects at read time, but BunnyCDN keeps serving the stale cached feed (still listing the now-unpublished video) until TTL. Add a `purgeGlobalFeeds()` on the demotion path if a video leaving `ready` should drop from feeds promptly.

### J. `duplicateVideo` copies `status` verbatim but re-derives the ledger, so non-`ready` originals can produce inconsistent copies (LOW)

`duplicateVideo` (`store.ts:929`) copies `original.status` and then re-derives step rows via `inferStepsFromDisk`. Duplicating a mid-edit (`reprocessing`) original yields a copy stuck in `reprocessing` (no owner, `canReprocess` rejects it). Duplicating a `ready` original whose copied `source.mp4` fails inference (ffprobe unavailable, or a duration-tolerance trip) leaves the copy `ready` while `derivativeFlags` refuses to serve it and there's no copied HLS to fall back to. Consider normalising the duplicate's status from the inferred ledger (run a `reconcile`-style rollup after `inferStepsFromDisk`) rather than trusting the copied value.

### K. Smaller correctness nits (LOW)

- **Transcript `sizeBytes` is wrong for multibyte text.** `api/videos.ts:334` records `sizeBytes: body.length` (JS string length = UTF-16 code units), not the stored file's byte length. A CJK/emoji transcript under-reports its size in the ledger/UI. Use the byte length (e.g. `Buffer.byteLength(body)` / the written file size).
- **`source.mp4.tmp` is orphaned on ffmpeg failure.** The new `generateSourceFromHls`/`generateSourceFromUpload` (`derivatives.ts`) dropped the old failure-path `rm(tmp, {force:true})`; a failed stitch leaves `source.mp4.tmp` on disk. Harmless (next run overwrites) but the old cleanup invariant is gone.
- **Backfill marks `audio` `ready` whenever the source has an audio stream** (`backfill.ts:96`), regardless of whether loudnorm actually ran. A backfilled/duplicated recorded video is then recorded as audio-processed, and a *non-force* reprocess skips audio permanently. The code comment acknowledges this; flagging so the trade-off is a conscious one (force-rebuild is the only way to actually loudnorm such a video).
- **Source step validates *after* the rename.** `runStep` renames `source.mp4.tmp → source.mp4` (inside `run`) and only then calls `validate`. A forced from-HLS rebuild that stitches a structurally-broken file overwrites the previously-good `source.mp4` before validation (then demotes to `processing_failed`). Recoverable because force-rebuild requires HLS, but inconsistent with the audio step, which deliberately validates the tmp *before* the in-place replace. Consider validating the source tmp before the rename to mirror that safety.

### L. Reuse / duplication cleanups

- **ffprobe boilerplate is duplicated 5–6×.** `isProbablyPlayable` (`playable.ts`), `hasAudio` (`backfill.ts:28`, a near-clone of `hasAudioStream` in `derivatives.ts` differing only `-select_streams a` vs `a:0`), `probeImageWidth` (`admin/videos.tsx`), and `probeMetadata`/`probeDuration` each re-spawn ffprobe with their own not-found / non-zero-exit / JSON-parse handling. Fold into one `probeJson(args)` helper in `derivatives.ts`; have backfill reuse `hasAudioStream`.
- **The variant-height list is hand-synced across three files.** `resolve.ts` `VARIANTS` (height+kind), `derivatives.ts` `VARIANTS` (height+crf), and `registry.ts` (the `ctx.height > 1080/720` thresholds + `${1080|720}p.mp4` literals). Adding/removing a rendition means editing all three (plus the backfill switch). Make one canonical `{kind, height, crf}[]` drive all of them.
- **`backfill.ts` re-derives every artifact path by hand** (`${kind}p.mp4`, `thumbnail.jpg`, `storyboard.vtt`, …) instead of reading `PROCESSING_STEPS[].artifact(ctx)` from the registry — so renaming an artifact in the registry silently makes backfill probe the wrong path. Drive `inferStep` off the registry's `artifact()`.

### M. Efficiency (lower priority)

- **`reconcile` is called after every step and re-loads the video + does a full `video_processing_steps` scan each time** (`pipeline.ts:133`) — ~8 reloads per run, when only `source`/`metadata` affect the rollup. Pass the already-loaded video/steps in, or only reconcile after the required steps settle.
- **`computeReadiness` fetches `getStepStates` twice** (once directly, once inside `reprocessability`) and does its per-step `Bun.file(...).exists()` **sequentially** in a `for` loop (`readiness.ts:101,104`). Load steps once and `Promise.all` the existence checks. Same serial-`exists()` pattern in `resolve.ts` `derivativeFlags` runs on the **public viewer hot path** — parallelise the active-raw + per-variant checks.

### N. Altitude — atomicity and validation live only in the edit path

The atomic stage→validate→swap machinery exists **only** in `edit-pipeline.ts`. But the original task doc (line 225) scopes "must land as an atomic set" to "edits **and** any full from-HLS rebuild that replaces several outputs." The manual `POST /reprocess?rebuild=hls` (and the heal force-run) drive the main pipeline, which re-stitches `source` and regenerates each variant/storyboard **in place, one at a time, reconciling to `ready` after the required steps** — so there's a window where a freshly-restitched `source` sits beside a stale `720p.mp4` while the viewer is already served `ready`. Consider generalising the staged-swap to any multi-file forced rebuild, or holding `ready` until the whole forced set re-validates. Relatedly, **external (Mac-sent) steps** are declared in the registry but their `ready` rows are written by ~5 bespoke `markStepReady` calls scattered across `api/videos.ts` with no `validate` ever run — a malformed `words.json` still reads as ✅. A thin `markExternalStep(kind, {validate})` driven off the registry entry would put their receipt path next to the declaration.
