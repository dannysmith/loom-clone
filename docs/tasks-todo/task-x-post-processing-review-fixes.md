# Post-Processing — Review Fixes & Follow-ups (Task 4)

## Background

Fixes and follow-ups for the post-processing work that landed in [task-4](task-4-post-processing-status-and-robustness.md) (step ledger, `reconcile`, the registry-driven pipeline, status model, readiness UI, reprocess/regenerate controls, edit atomic-set staging). All of it is to be addressed **on the current `task-4-post-processing-robustness` branch** — none of these items is large-and-unrelated enough to warrant its own branch; they all arise from, or are exposed by, the task-4 changes.

This doc was assembled from a cleanup pass and two code-review sessions. The original review labels (items 1, 2, A, and B–N) are preserved in parentheses for traceability; the work itself is organised into the four phases below.

## Decisions (locked)

These were settled with the user before phasing — implement to them:

1. **Per-artifact "↻" regenerate is hidden on edited videos.** Only the global "Re-run post-processing" is offered for an edited video, and it resets the edit first (Phase 2.1). No edit-aware single-artifact regen is built.
2. **`edits.json` is deleted on reset** — reprocessing an edited video washes the edit fully away (no "re-apply the same EDL later").
3. **`incomplete` recovers to `ready`.** A manual reprocess of an `incomplete` video that produces a validated `source.mp4` is a real recovery path: `reconcile` owns the `incomplete → ready` transition.
4. **A forced multi-file rebuild holds `ready` until it settles.** No separate staging dir for the manual from-HLS rebuild — instead reset the to-be-regenerated step rows and keep the video out of `ready` until source + metadata + applicable steps have all re-validated, so the viewer is never served a fresh `source.mp4` beside a stale variant and feeds don't publish mid-rebuild. (The full staged-swap generalisation is explicitly deferred.)

---

## Phase 1 — Status-machine & orchestration correctness

The highest-value robustness fixes; they sit under everything else, so do them first.

### 1.1 `incomplete` videos must recover to `ready` on reprocess (item B) — HIGH

`reconcile`'s `RECONCILE_OWNED` (`lib/processing/reconcile.ts`) is `{processing, ready, processing_failed}`, but `readiness.ts`'s `REPROCESSABLE` *includes* `incomplete`. So the admin offers "Re-run post-processing" on an `incomplete` video, the pipeline runs and marks every step `ready`, `resolve.ts` (gated only on the `source` step, never on `status`) starts serving the MP4 — yet `reconcile` early-returns on every call because `incomplete ∉ RECONCILE_OWNED`, so the video stays `incomplete` forever: excluded from feeds (`feeds.ts` filters `status='ready'`), sitemap, and tag pages.

**Fix (per decision 3):** let `reconcile` own the transition *out of* `incomplete` once the mandatory steps validate. Make the owned/reprocessable sets impossible to contradict — derive `RECONCILE_OWNED` from `REPROCESSABLE` minus the states owned elsewhere (`reprocessing` → editor; `recording`/`healing` → `/complete`) rather than maintaining a second hand-written Set. Add a test: reprocess an `incomplete` video → it reaches `ready` and publishes.

### 1.2 Don't silently drop a forced / `only` reprocess (item C) — MED

`schedule()` (`lib/processing/pipeline.ts`) collapses **all** runs to one in-flight promise per video and *drops* a new request on collision (`if (inFlight.has(videoId)) return;`), returning nothing. The skip-if-ready justification only holds for *resumable* runs — a `force` or `only` run is meant to do work the in-flight run won't. Two failures:

- **UI:** "Re-run post-processing" then "Rebuild from HLS" (or a per-artifact `↻`) in quick succession — the second `scheduleReprocess(force:true)` is dropped but `POST /reprocess` still `302`s as success.
- **Heal:** a video demoted `processing → healing` by a later partial `/complete` can still have its original pipeline in flight when the heal completes and fires `scheduleReprocess(force:true)` (`api/videos.ts:280`). The force is dropped; the in-flight run skips the already-`ready` `source` step, so the healed segments are never re-stitched — `source.mp4` keeps stale pre-heal footage.

**Fix:** when a `force`/`only` run is requested while one is in flight, **coalesce a single follow-up** (set a "re-run requested" flag that fires once when the current run settles) rather than dropping it — this covers both the heal path and the UI. The admin route must also stop returning a success redirect when it couldn't start/queue the run: surface "a run is already in progress" to the user. Keep plain resumable schedules collapsing as today.

### 1.3 Hold `ready` until a forced multi-file rebuild settles (item N) — MED

The atomic stage→validate→swap lives only in `edit-pipeline.ts`. A manual "Rebuild from HLS" (`POST /reprocess?rebuild=hls`) and the heal force-run drive the main pipeline, which re-stitches `source` and regenerates variants/storyboard **in place**, reconciling to `ready` the moment source+metadata validate — so the viewer can be served a fresh `source.mp4` beside a still-stale `720p.mp4`, and feeds can publish mid-rebuild.

**Fix (per decision 4 — no staging dir):**
- At the start of a forced full rebuild (`force` and no `only`), reset the to-be-regenerated step rows (variants, storyboard, thumbnail, peaks, …) so `resolve.ts` stops offering the stale variants — during the window the viewer gets the freshly-restitched source only (content-consistent), not a mismatched variant.
- `reconcile` must not publish `ready` for a forced run until source + metadata **and the applicable expected steps** have re-validated (i.e. wait for `running:false` / a fully-settled run before promoting). This keeps status/feeds honest for the duration of the rebuild.
- A single-artifact `only` regenerate is already atomic (per-file tmp→rename) and is exempt.

### 1.4 Don't strand a `reprocessing` row on deploy-mid-edit (item G) — LOW

Migration `0012` maps `processing → reprocessing`. On `main`, `processing` was set only by the edit-pipeline's transient re-render, so if the migration runs while an edit is in flight (the edit-pipeline process dies on the deploy restart), that row sits in `reprocessing` forever — owned by neither `reconcile` nor `canReprocess`.

**Fix:** on startup (or in the backfill script), nudge any `reprocessing` row whose `source` step is validated `ready` back to `ready` (it has no live edit run). Cheap defensive sweep.

---

## Phase 2 — Edited-video correctness

The largest cluster; depends on Phase 1's reconcile/ledger plumbing.

### 2.1 Reprocessing an edited video resets the edit (run from canonical source) (item 1)

The manual reprocess actions — **"Re-run post-processing"**, **"Rebuild from HLS"**, and the heal/incomplete-recovery force re-run — drive the **main** pipeline, which derives everything from `source.mp4` (the original recording). For an **edited** video this is edit-unaware and produces a mismatched set: the active raw file stays the edited `{H}p.mp4`, but the downscaled variants get rebuilt from the **full** `source.mp4`, so e.g. `720p.mp4` becomes the full-length clip while the active 1080p is the ~117 s edit — switching quality jumps content/length. Storyboard/captions/metadata/duration drift back to the full source too. (The duration-validation half is already fixed via `sourceExpectedDuration`; this is the behavioural half.)

**Desired behaviour:** reprocessing an edited video via the main pipeline **washes the edit away** and rebuilds a fully consistent, *unedited* video. Add `resetAllEdits(videoId)` (name TBD) in the edit subsystem (`lib/edit-pipeline.ts` or a sibling) and call it before the main pipeline runs whenever a reprocess targets a video with `lastEditedAt` set — the two reprocess routes **and** the heal/incomplete force re-run in `api/videos.ts:280`. After it runs:

- The active raw file is `source.mp4` again (the edited `{sourceHeight}p.mp4` is deleted — it's the only edited file the main pipeline won't overwrite for that source height; deleting the other edited files up front is cleaner too, avoiding stale-mismatch windows).
- All derivatives (variants, storyboard, thumbnail, peaks, captions, metadata) reflect the full source.
- The DB transcript is the original full transcript, re-derived from `words.json` (the unedited word timings) with no EDL, and upserted.
- `durationSeconds`/`fileBytes`/dimensions reset from `source.mp4` (let the pipeline's `metadata` step do this).
- `lastEditedAt` is cleared, so `activeRawFilename()` resolves back to `source.mp4`.
- **`edits.json` is deleted** (decision 2 — wash away fully).

**Accepted limitation:** original captions aren't preserved separately (the edit overwrites `captions.srt` in place), so the reset re-derives the full transcript from `words.json` — a faithful reconstruction, not byte-identical to the Mac's original upload. Acceptable.

### 2.2 Hide per-artifact "↻" on edited videos (item 2 / decision 1)

In `ReadinessPanel.tsx`, suppress the per-artifact `↻` buttons when `video.lastEditedAt` is set — only the global "Re-run post-processing" / "Rebuild from HLS" controls are offered for an edited video (and they reset the edit per 2.1). This sidesteps the edit-unaware single-artifact regen hazard entirely without building an edit-aware regen path.

### 2.3 Confirmation + edit-aware warnings on the regenerate controls (item 2)

- **Every** regenerate control gets a confirmation before firing — the global pair *and* (for unedited videos, where they're still shown) the per-step `↻`. Today only "Rebuild from HLS" has an `hx-confirm`; "Re-run post-processing" and the `↻` buttons have none. These re-spend ffmpeg and overwrite outputs, so a click shouldn't be one-tap.
- For **edited videos**, the Processing tab shows a visible warning — "This is an edited video. Re-running post-processing will discard the edit and rebuild from the original recording." — and the reprocess buttons' confirm copy says the same, so the reset (2.1) is never a surprise.

### 2.4 Edit-pipeline writes the ledger and validates the served file (items D, E, + the edit-bypasses-ledger gap)

The edit-pipeline currently transitions straight to `ready` via a raw `videos` UPDATE and **never touches the step ledger or `reconcile`** (confirmed). So:

- **(D) The serving gate validates the wrong file for edited videos.** `resolve.ts` keys `hasSource` off the `source` step (which validated `source.mp4`) but only does a **bare presence** check on the file actually served (`{H}p.mp4` via `activeRawFilename`). The edit validates `{H}p.mp4` with `isProbablyPlayable` only transiently in `.edit-staging`, recording nothing — so "never serve a broken MP4" silently doesn't hold for edited videos. `cleanup.ts` has the mirror gap: it gates HLS deletion on `source.mp4` only, so an edited video whose `{H}p.mp4` later goes missing while `source.mp4` is valid loses its HLS fallback → unplayable.
- **(E) A shortening edit leaves a stale storyboard.** `generateStoryboard` only runs when `editedDuration >= 60`, and the swap only renames files present in staging — so editing a ≥60 s video down to <60 s leaves the old (longer) `storyboard.vtt` and its `ready` step row in place, and scrubbing thumbnails map to the un-edited timeline.
- **Latent:** because the edit relies on pre-existing `ready` variant/storyboard rows, a variant that was `failed`/`skipped`/absent before the edit has its regenerated file ignored by the serving gate.

**Fix:** after the staged swap, have the edit-pipeline mark the regenerated outputs as validated step rows (the active `{H}p.mp4` plus variants, storyboard, captions) and **remove stale ones** (e.g. delete the storyboard + clear its row when the edit drops below 60 s), then call `reconcile`. Make the serving gate **and** cleanup follow `activeRawFilename` for *both* the presence and the validity check (gate on the served file's validated state, not on `source` by proxy). This closes D, E, and the latent gap together.

---

## Phase 3 — Smaller correctness fixes

Independent, low-risk; can land in any order after Phase 1.

### 3.1 Serving/status divergence + readiness badge (item F)

- `resolve.ts` never reads `status` and gates only on the `source` step, so a video that reaches `processing_failed` because **`metadata`** failed while `source` validated is still served as a finished MP4 with null dimensions — contradicting "`processing_failed` → serves HLS". Rare (both use ffprobe), but add a guard (require `metadata` too, or have serving consider the rollup) — or consciously accept + document the decoupling.
- `computeReadiness`'s badge counts a **failed** expected step toward `enriching (N left)`, so a `ready` video whose `audio` step failed shows "enriching (1 left)" forever. Distinguish failed-expected from pending in the badge.

### 3.2 Dead thumbnail-candidates cleanup (item H, pre-existing)

`cleanup.ts` guards the `thumbnail-candidates` removal with `await Bun.file(candidatesDir).exists()`, but `Bun.file(dir).exists()` returns **`false` for a directory** (verified on Bun 1.3.14) — so that branch never runs and candidate frames accumulate forever. Pre-existing on `main`, but it lives in the cleanup function this task rewrote, so fix here: use `fs/promises` `stat`/`readdir` (or `existsSync`) for the directory check.

### 3.3 Purge feeds on demotion out of `ready` (item I)

`markVideoReady` calls `purgeGlobalFeeds()`, but the reverse transitions (`ready → processing_failed`/`processing` inside `reconcile`) don't. The origin feed query self-corrects at read time, but BunnyCDN serves the stale feed until TTL. Add `purgeGlobalFeeds()` on the demotion path.

### 3.4 `duplicateVideo` reconciles the copy's status (item J)

`duplicateVideo` copies `original.status` verbatim then re-derives the ledger via `inferStepsFromDisk`. A duplicate of a `reprocessing` (mid-edit) original is stuck (no owner, `canReprocess` rejects it); a duplicate whose copied `source.mp4` fails inference stays `ready` while the serving gate refuses it. **Fix:** normalise the duplicate's status from the inferred ledger (run a `reconcile`-style rollup after `inferStepsFromDisk`) rather than trusting the copied value.

### 3.5 Smaller nits (item K)

- **Transcript `sizeBytes` is wrong for multibyte text** (`api/videos.ts`): records `body.length` (UTF-16 code units), not byte length. Use `Buffer.byteLength(body)` / the written file size.
- **`source.mp4.tmp` orphaned on ffmpeg failure**: the new `generateSourceFromHls`/`generateSourceFromUpload` dropped the old failure-path `rm(tmp)`. Restore the cleanup. (Harmless but tidy.)
- **Source step validates *after* the rename**: `runStep` renames `source.mp4.tmp → source.mp4` then validates, so a forced rebuild that stitches a broken file overwrites the good copy before validation (then demotes). Recoverable (force needs HLS), but inconsistent with the audio step, which validates the tmp *before* the in-place replace. Validate the source tmp before the rename to mirror that.
- **Backfill marks `audio` `ready` whenever the source has an audio stream** regardless of whether loudnorm ran — so a backfilled/duplicated recorded video is recorded as audio-processed and a non-force reprocess skips audio. The code comment acknowledges this; keep as a conscious accept (force-rebuild is the way to actually loudnorm such a video) — just confirm the comment makes the trade-off explicit.

---

## Phase 4 — Cleanup / DRY / efficiency

Pure polish (maps to task-4's intended Phase 4). No behaviour change; do last.

### 4.1 Single dashboard-filter serializer (item A)

`DashboardFilters` → query-string serialization lives in two hand-synced places: `filtersToParams` (`routes/admin/helpers.ts`) and `viewToggleUrl` (`views/admin/pages/DashboardPage.tsx`). They drifted once already (`viewToggleUrl` silently dropped the `attention`/date/duration filters on a view toggle). Consolidate into one shared serializer, and round-trip `parseFilters` against it so a new filter can't be added to one without the other.

### 4.2 De-duplicate (item L)

- **ffprobe boilerplate, 5–6×:** `isProbablyPlayable` (`playable.ts`), `hasAudio` (`backfill.ts`, a near-clone of `hasAudioStream` in `derivatives.ts`), `probeImageWidth` (`admin/videos.tsx`), `probeMetadata`/`probeDuration`. Fold into one `probeJson(args)` helper in `derivatives.ts`; have backfill reuse `hasAudioStream`.
- **Variant-height list, 3×:** `resolve.ts` `VARIANTS` (height+kind), `derivatives.ts` `VARIANTS` (height+crf), and `registry.ts` (the `> 1080/720` thresholds + `${h}p.mp4` literals). Make one canonical `{kind, height, crf}[]` drive all three (and the backfill switch).
- **Backfill re-derives artifact paths by hand** instead of reading `PROCESSING_STEPS[].artifact(ctx)` — renaming an artifact in the registry silently breaks backfill. Drive `inferStep` off the registry's `artifact()`.

### 4.3 Efficiency (item M)

- **`reconcile` after every step** re-loads the video + does a full `video_processing_steps` scan each time (~8 reloads/run) though only `source`/`metadata` affect the rollup. Pass the already-loaded video/steps in, or only reconcile after the required steps settle. (Coordinate with Phase 1.3, which also touches when reconcile publishes.)
- **`computeReadiness` fetches `getStepStates` twice** (directly + inside `reprocessability`) and does per-step `Bun.file(...).exists()` **sequentially** in a `for` loop. Load steps once; `Promise.all` the existence checks.
- **`resolve.ts` `derivativeFlags`** runs the same serial `exists()` pattern on the **public viewer hot path** — parallelise the active-raw + per-variant checks.

---

## Out of scope (deferred, by decision)

- **Full staged atomic swap for the manual from-HLS rebuild** — Phase 1.3 takes the lighter "hold `ready` + reset stale rows" approach instead. If the brief serving window ever proves a problem in practice, generalising `edit-pipeline`'s `.edit-staging` build→validate→swap to the main forced rebuild is the deeper fix; revisit then.
- **Edit-aware single-artifact regeneration** — sidestepped by hiding `↻` on edited videos (Phase 2.2).
- **Registry-driven receipt path for external (Mac-sent) steps** (the altitude half of item N — their `ready` rows are written by ~5 bespoke `markStepReady` calls in `api/videos.ts` with no `validate`). Noted for a future tidy; not blocking and the storage layer is already shared.
