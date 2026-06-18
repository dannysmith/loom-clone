# Post-Processing & Admin Pipeline — Unify the Pipelines, Fix Concurrency & Correctness Edges

> **✅ COMPLETE (Phases 1–2).** This doc has done its job: it captured the #48 review and delivered the independent correctness fixes (Phase 1, incl. the live editor-lock bug) and the SSOT prep (Phase 2). The two remaining phases were spun out into their own docs and continue from here:
> [Phase 3 — unify the pipelines](./task-2026-06-12-1-pipeline-unification-phase-3.md) and [Phase 4 — cleanup](./task-2026-06-14-x-pipeline-unification-cleanup.md).
> It is kept as the record of Phases 1–2 plus the original analysis (core problem, agreed design decisions, what's good, explicitly-not-doing).

## Why this task exists

Tasks 1–4 spun out of the [#40](https://github.com/dannysmith/loom-clone/issues/40) OOM incident landed the durable foundations: a `video_processing_steps` ledger, `reconcile()` as the status deriver, a resumable skip-if-ready pipeline, `isProbablyPlayable` validation, table-gated serving, the memory-footprint reductions (Task 2), the cgroup limit (Task 1), and frame-rate correctness (Task 3 / #42, plus the camera-fps fix in #44). On top of that, an architectural review of the whole recording → server → post-processing → admin flow ([#48](https://github.com/dannysmith/loom-clone/issues/48)) found that the subsystem is well-built and most failure modes are handled — but the documented invariants ("`reconcile` owns post-footage status; the registry is the single source of truth for steps") are only *partially* realised, plus a small number of genuine correctness edges remain. This doc turns that review into an executable, phased plan.

The findings below were re-verified against the current code (post-#44/#45) before writing this doc. Two things have already changed since #48 was filed and are reflected here:

- **#45 / P4.3 (remove thumbnail-candidates cleanup) is already done** (commit `fa21a36`) and is dropped from this plan.
- **The edit-pipeline's `runFfmpeg` is no longer a verbatim copy of the derivatives wrapper** — Task 2 routed it through the shared `spawnFfmpeg()` helper. The other edit-pipeline divergences (parallel status writes, hardcoded variant literals, bare-`exists()` ledger marking, separate atomicity + separate in-flight map) all still stand and are the real targets of Phase 3.

### Scope folded in from related issues

- **[#40](https://github.com/dannysmith/loom-clone/issues/40) is fully addressed and should be closed.** Every Tier 1/2 fix landed across Tasks 2–4 (skip-if-output-exists → resumable pipeline; durable heal-survivable dedupe → step ledger + `reconcile`; audio pass-1 `-nostats`; bounded stderr; streamed peaks; structured logging). The thumbnail-coalescing item was consciously descoped (it runs sequentially after audio, so it buys ≈ zero peak-RSS, and collides with VFR fps). The **only** unaddressed part is **Tier 3** (relocating derivatives into a memory-capped sidecar worker / job queue) — see *Explicitly NOT doing*.
- **[#46](https://github.com/dannysmith/loom-clone/issues/46):** item 1 (staged atomic swap for the from-HLS rebuild) is folded into **Phase 3 [P3.1]**; item 3 (registry-driven receipt for external steps) is **Phase 2 [P2.4]**; item 2 (edit-aware single-artifact regen) is folded into **Phase 4 [P4.7]** (it becomes natural once Phase 3 makes "edit" a pipeline mode).

---

## The core problem (the architecture headline)

The docs describe a clean two-axis model: a single behaviour-driving `status`, and a derived artifact-readiness *ledger* (`video_processing_steps`). That model is good and should be kept. But to *safely change* the subsystem today, an engineer has to hold a much larger model, because several concepts have multiple parallel implementations:

- **`status` is written in ~5 places**: the `/complete` handler (`recording`↔`healing`, → `processing`), `reconcile` (`processing`/`ready`/`processing_failed`/`incomplete`), the **edit-pipeline via raw `videos` UPDATEs** (`reprocessing`, `ready` — `edit-pipeline.ts:141,150,268`), `recoverStrandedReprocessing` at boot, and the `markStalledRecordingsIncomplete` sweep. So "`reconcile` owns post-footage status" is not actually true — the editor owns its own transitions in parallel, and `recoverStrandedReprocessing` exists *only* to clean up the one status `reconcile` refuses to own.
- **Step rows are created 3–4 different ways**: `runStep` in the pipeline, **bespoke `markStepReady` calls inside the edit-pipeline** (`edit-pipeline.ts:244-252`), the hand-written switch in `inferStepsFromDisk` (`backfill.ts`), and 5 hand-rolled `markStepReady` calls in `routes/api/videos.ts` for the Mac-sent steps. So the registry is the single source of truth for *some* steps, not all.
- **Two pipelines** (`processing/pipeline.ts`, `edit-pipeline.ts`) with **two atomicity strategies** (staging-dir swap vs. the `hold` + `resetRegeneratedSteps` dance) and **two independent in-flight maps** (`pipeline.ts:40`, `edit-pipeline.ts:40`), bolted together by a `resetAllEdits` chokepoint.

Almost every structural finding below traces back to a single root cause: **the edit-pipeline is a parallel re-implementation of the main pipeline.** Collapsing that is the biggest single win and is the centrepiece of this plan (Phase 3).

---

## Agreed design decisions (treat these as requirements)

These were settled during the #48 review — implement *to* them:

1. **Unify into one parameterised pipeline.** "Edit" becomes a *mode* of the main pipeline, not a separate pipeline. The differences must be expressible declaratively (if implementing forces a pile of `if (mode === 'edit')` into every step, that's a sign the abstraction is wrong — stop and reconsider). Specifically:
   - The **"active file" is a context concept** (defaults to `source.mp4`; in edit mode it is the EDL-cut `{height}p.mp4`). Downstream steps (variants, storyboard, captions, metadata) consume the active file and don't care how it was produced.
   - **Source/active-file production is a strategy**: stitch-from-HLS (recorded) | remux (uploaded) | apply-EDL (edited).
   - The **only genuinely edit-specific behaviours** are (a) applying the EDL and (b) deriving the *edited* transcript into the DB. Everything else is an `appliesTo` gate (`audio` → recorded-and-not-edited; `suggested_edits` → not-edited; etc.).
2. **`reprocessing` keeps its own status, with a crisp meaning:** *an edit-style run is in flight and `source.mp4` is preserved* (the active file becomes the edited cut). `processing` = a run that **produces or changes `source.mp4`** (first build, heal re-stitch, forced from-HLS rebuild). `reconcile` picks the in-progress label from the run's mode.
3. **One atomicity primitive, scoped correctly.** Adopt the edit-pipeline's stage→validate→swap as the single mechanism for **rebuilds/edits that replace an already-served set** — which lets us delete the `hold`/`resetRegeneratedSteps` workaround. **The first post-recording build stays incremental** (reaches `ready` on `source` + `metadata`, then enriches) so a quick video is shareable in seconds. Do not make the first build wait for all derivatives.
4. **Editing is gated and serialised.** The editor is openable iff `status === ready` **AND** there is no in-flight pipeline run for that video (the optional Mac-sent steps must *not* gate it). A single **shared per-video lock** serialises the main pipeline, reprocess, per-artifact regen, and edit so two runs can never touch one `derivatives/` dir at once. (In-memory is sufficient — after a crash there is no concurrent writer.)
5. **An uploaded video that fails post-processing serves the original `upload.mp4`, never a dead player.** Validate the upload at intake and surface the result in admin (a genuinely-broken upload showing a broken player is acceptable — that's the uploader's problem, caught immediately). But a *good* upload whose limited post-processing fails must fall back to the original file.
6. **No auto-retry (keep the decision)** — and remove the dead `attempts` machinery that was its vestige.

---

## Phase 1 — Independent correctness fixes ✅ DONE

Low-risk, high-value, no refactor required. Each is self-contained. Independent of Phases 2 and 3. **Ship [P1.1] first — it's the one live bug.**

**Status:** shipped on branch `task-1-phase-1-correctness-fixes`. All five items landed with tests; `bun run check && bun run typecheck && bun test` green (710 pass). Notes per item:

- **[P1.1] ✅** — shared per-video run lock (`lib/processing/run-lock.ts`), registered by both the main pipeline and the edit pipeline; editor page-load + commit gated on `ready` + no in-flight run (`409`); detail-page "Edit video" button hidden mid-run via a `runInFlight` prop. The dashboard "Open editor" menu item and the edited-badge link are left to the server-side gate (no UI threading).
- **[P1.2] ✅** — `duplicateVideo` preserves `lastEditedAt` and `notes`.
- **[P1.3] ✅** — uploaded videos fall back to `upload.mp4` (media allowlist + `resolve.ts`); upload intake validated with `isProbablyPlayable` and surfaced via an `upload_received` event.
- **[P1.4] ✅** — `attempts` column dropped (migration `0013_amazing_karen_page.sql`), `incrementAttempts` removed, dead-path test replaced.
- **[P1.5] ✅** — `VIDEO_ALREADY_COMPLETE`→`VIDEO_NOT_DELETABLE`; `skipped` reprocess notice; `PROCESSING_STEP_KINDS` reordered to match the registry; single source probe threaded through `ctx.scratch.sourceMeta`; `probeImageWidth` uses the shared `probeJson`.

### [P1.1] The editor can run concurrently with the post-processing pipeline and corrupt the served video — **highest-severity bug**

- **Problem:** `reconcile` publishes `ready` the moment `source` + `metadata` validate (`pipeline.ts:194-204`, `running: true`), while the *expected* steps (`audio` — an in-place rewrite of `source.mp4` — plus variants, storyboard, peaks) are **still running in the same run** (minutes, for a long recording). During that whole window `status === "ready"`, so the editor page-load gate (`editor.ts:25`) and the commit gate (`editor.ts:121`) both pass and the "Edit video" button is shown. The main pipeline and the edit-pipeline use **separate in-flight maps** (`pipeline.ts:40` vs `edit-pipeline.ts:40`) and don't know about each other, so committing an edit during enrichment runs two ffmpeg writers + two ledger writers against the same `derivatives/` dir. Likely result: `lastEditedAt` set but `720p.mp4`/`1080p.mp4` are the *full-length* main-pipeline variants beside the edited active file — exactly the "quality switch jumps content/length" corruption Task 4 set out to prevent; worst case `audio`'s in-place rename clobbers `source.mp4` mid-edit-read. Reachable by ordinary clicks (finish a long recording → editor is right there → trim → commit), not misuse.
- **Where:** `processing/pipeline.ts` (`inFlight:40`, the reconcile-after-`metadata` at `:199,204`), `lib/edit-pipeline.ts` (its own `inFlight:40`), `routes/admin/editor.ts` (page gate `:25`, commit gate `:121`), the admin view that shows the Edit button on `ready`.
- **Direction:** the agreed shared per-video lock (decision 4); gate editor page-load **and** commit on `ready` + no in-flight run. The lock survives into Phase 3 unchanged. Worth shipping here rather than waiting on the Phase 3 refactor, since it's the one *live* bug.

### [P1.2] Duplicating an edited video produces a broken copy

- **Problem:** `duplicateVideo`'s insert (`store.ts:926-945`) omits `lastEditedAt` (and silently drops `notes`), so a copy of an edited video is treated as **unedited**. `inferStepsFromDisk` then validates the copied full-length `source.mp4` against the copied *edited* `durationSeconds` — because `sourceExpectedDuration` (`registry.ts:85-86`) only returns `undefined` (skip the duration check) when `lastEditedAt` is set, and the copy has lost it — so it fails the duration tolerance → marks `source` **failed** → the duplicate lands in `processing_failed`. Even if it passed, `activeRawFilename` would now resolve to `source.mp4`, silently serving the un-edited full video instead of the edit.
- **Where:** `lib/store.ts` `duplicateVideo` (the insert values, `:926-945`), `processing/backfill.ts` (`source` inference, `:53`), `processing/registry.ts` (`sourceExpectedDuration`, `:85-86`).
- **Direction:** preserve `lastEditedAt` (and `notes`) on the duplicate so a copy of an edited video is itself a working edited video.

### [P1.3] An uploaded video that fails its required post-processing serves a dead HLS player

- **Problem:** `resolve.ts` falls back to the HLS URL whenever there's no servable MP4 (`:156-158`) — but uploaded videos have **no HLS**. A *required*-step failure (`source` remux or `metadata`) on an upload → `processing_failed` → the viewer page renders a player pointing at a 404 manifest (`media.ts:41-55` 404s on the missing `stream.m3u8`), with nothing to show. (Only required-step failures cause this — `maybeDeleteUpload` keeps `upload.mp4` on disk until `source` + `metadata` succeed, so in exactly the failure case the original upload is still available.)
- **Where:** `routes/videos/resolve.ts` (HLS fallback `:156-158`), `routes/admin/upload.tsx` (no intake validation today, `:21-71`).
- **Direction:** validate `upload.mp4` with `isProbablyPlayable` at intake and surface the result in admin; for an uploaded video with no servable `source.mp4`, serve `upload.mp4` as the fallback instead of HLS. (The "good upload but post-processing fails" case is rare given how limited upload processing is, but the fix is cheap and the failure mode is user-visibly broken — decision 5.)

### [P1.4] The `attempts` column is dead machinery

- **Problem:** `incrementAttempts` is plumbed through `upsertStep` (`steps-store.ts:47-66`) and exercised by an isolated unit test, but **no production caller ever passes it** — so `attempts` (`schema.ts:136`) is always 0, despite the schema comment and the readiness type advertising "a manual reprocess increments it." Vestige of the abandoned auto-retry idea (superseded by the manual regenerate buttons, decision 6).
- **Where:** `processing/steps-store.ts` (`incrementAttempts`, the `attempts` arithmetic), `db/schema.ts:136`, the isolated steps-store test.
- **Direction:** remove the column (a small drop-column migration), the `incrementAttempts` field, and the test that only exercises the dead path.

### [P1.5] Small correctness/UX nits (batch)

- **`DELETE /api/videos/:id` error code mismatch:** returns `VIDEO_ALREADY_COMPLETE` (`errors.ts:24`) but the message says "processing or ready" — the code name predates the status rename. Rename to something like `VIDEO_NOT_DELETABLE`. (`routes/api/videos.ts`, `lib/errors.ts`, docs.)
- **"Re-run post-processing" is a silent dead-click during the normal run:** the button shows whenever the video is reprocessable (which includes `processing`); clicking during the standard post-recording run returns `"skipped"` and the page shows no notice (only `queued` is handled). Add a "nothing to do — a run is already in progress" notice, or hide/disable the resumable button while a run is in flight. (`routes/admin/videos.tsx`, the detail-page notice handling.)
- **`PROCESSING_STEP_KINDS` encodes the old, wrong step order:** the schema array (`schema.ts:104-119`) lists `audio` before `metadata`, but the registry deliberately runs `source → metadata → audio` (`registry.ts:125,140,151` — metadata must gate `ready` before the fragile audio step). Nothing iterates the schema array for order today, but it's a trap for a future reader. Reorder it to match the registry, or comment that it's an unordered key set and `PROCESSING_STEPS` is the ordering authority. (`db/schema.ts`.)
- **`source.mp4` is probed twice per run:** once to seed `ctx.height` for resolution-gated steps (`pipeline.ts:179-185`), and again inside the `metadata` step's `extractMetadata` (`derivatives.ts:207-240`). Thread the probe result through the context.
- **`probeImageWidth` hand-rolls `Bun.spawn(ffprobe)`** (`routes/admin/videos.tsx:393-417`) instead of the shared `probeJson` helper (`ffprobe.ts:8-21`) that the rest of the ffprobe consolidation uses.

---

## Phase 2 — "Shrink the model" prep ✅ DONE

Cheap, mostly mechanical, and they de-risk the Phase 3 refactor by removing duplicated rules first. Independent of Phase 1.

**Status:** shipped on branch `task-1-phase-1-correctness-fixes` (kept as the single branch for the whole task). `bun run check && bun run typecheck && bun test` green (714 pass). Notes per item:

- **[P2.1] ✅** — one pure `rollupFromSteps(steps)` in `reconcile.ts`, now used by `reconcile`, `recoverStrandedReprocessing`, and `duplicateVideo`. This also fixed the drift the doc flagged: a mid-`processing` copy now lands on `processing`, not mislabelled `processing_failed`.
- **[P2.2] ✅** — new `lib/status.ts` is the single home for `RECONCILE_OWNED`, `POST_FOOTAGE_STATUSES`, and `VALID_STATUS` (members validated against the schema enum via `satisfies`). `reconcile`/`readiness`/`store`/admin `helpers` import from it; the uphill `readiness → reconcile` import is gone.
- **[P2.3] ✅** — `inferStepsFromDisk` now drives file-producing steps off each step's `artifact(ctx)`/`validate(ctx)`; only `metadata`/`audio`/`transcript`/`words` keep bespoke handling.
- **[P2.4] ✅** — one `recordExternalStep(id, kind, { payload? })` receipt helper replaces the five hand-rolled `markStepReady` calls in `routes/api/videos.ts` (it centralises the transcript byte-length sizing).

### [P2.1] The status rollup is hand-written three times and already disagrees

- **Problem:** the core rule — *"if every required step is `ready` → `ready`; if any required step `failed` → `processing_failed`; else `processing`"* — is implemented independently in `reconcile` (`reconcile.ts:34-85`), in `recoverStrandedReprocessing` (`reconcile.ts:96-114`), and in `duplicateVideo` (`store.ts:996-1010`). They already differ: `duplicateVideo` maps "not all ready" straight to `processing_failed` (`:1007-1009`), whereas `reconcile` only does that on an actual failure (a mid-`processing` copy would be mislabelled). This is the most important invariant in the subsystem, copied three times.
- **Where:** `processing/reconcile.ts` (the rollup, and `recoverStrandedReprocessing`), `lib/store.ts` (`duplicateVideo`).
- **Direction:** extract one pure `rollupFromSteps(steps)` helper. Ideally `duplicateVideo` and `recoverStrandedReprocessing` just **seed the ledger and call `reconcile`** rather than re-deriving status at all.

### [P2.2] Overlapping, hand-maintained status sets + an upside-down import

- **Problem:** three overlapping status sets maintained by hand — `RECONCILE_OWNED` (`reconcile.ts:27-32`), `POST_FOOTAGE_STATUSES` (`store.ts:1021-1026`), and a re-typed copy of the status enum in the admin helpers (`VALID_STATUS`, `helpers.ts:22-30`) that will drift the next time a status is added. Their relationships are load-bearing but only documented in prose. Also, `readiness.ts:10` imports `RECONCILE_OWNED` *from the state-machine module* — a UI/derivation module reaching into the state machine, the dependency running uphill.
- **Where:** `processing/reconcile.ts`, `lib/store.ts`, `routes/admin/helpers.ts`, `processing/readiness.ts`.
- **Direction:** a small status-taxonomy home (e.g. `lib/status.ts` or in `schema.ts`) where the sets are derived from one another (`VALID_STATUS = all − deleting`, `POST_FOOTAGE = RECONCILE_OWNED + reprocessing`, etc.), imported by `reconcile`/`readiness`/`store` rather than from each other.

### [P2.3] `inferStepsFromDisk` re-derives the registry by hand

- **Problem:** backfill (used by the one-time script *and* `duplicateVideo`) iterates `PROCESSING_STEPS` (`backfill.ts:36`) but then re-states every artifact path and validation in a per-kind switch with hardcoded literals (`"720p.mp4"` `:82`, `"thumbnail.jpg"` `:90`, `"storyboard.vtt"` `:93`, `"peaks.json"` `:96`, `"suggested-edits.json"` `:99`, `"words.json"` `:106`). Renaming an artifact in the registry silently breaks backfill/duplicate — exactly the drift the registry exists to prevent.
- **Where:** `processing/backfill.ts`.
- **Direction:** use each step's `artifact(ctx)`/`validate(ctx)` from the registry instead of hardcoded paths. Only `metadata` (no artifact) and the external/transcript items need bespoke handling.

### [P2.4] External (Mac-sent) step rows bypass the registry — (#46 item 3)

- **Problem:** the five external kinds (`transcript`, `words`, `title_suggestion`, `description_suggestion`, `chapter_titles`) get their `ready` rows written by 5 hand-rolled `markStepReady` calls in `routes/api/videos.ts` (`:336,381,416,451,513`), with no `validate` and no shared receipt path. So for ~⅓ of step kinds the registry is a UI-applicability table, not a generation/receipt authority.
- **Where:** `routes/api/videos.ts` (the suggest-* / transcript / words handlers).
- **Direction:** a single `recordExternalStep(id, kind, …)` receipt helper, centralising the bookkeeping (including the `Buffer.byteLength` sizing the transcript route special-cases at `:336`).

---

## Phases 3 & 4 — spun out into their own task docs

The big refactor and its cleanup were split out of this doc once Phases 1–2 shipped (they are too large to track inline, per the original "break it into its own sub-task doc(s) at execution time" note):

- **Phase 3 — unify the pipelines (the centrepiece):** [`task-1-pipeline-unification-phase-3.md`](../tasks-todo/task-1-pipeline-unification-phase-3.md). Eliminate the parallel edit-pipeline so there is one parameterised pipeline, `reconcile` is the only post-footage status writer, `runStep` is the only ledger writer, and staging-swap is the single rebuild atomicity primitive. Subsumes #46 item 1. Carries the agreed design decisions forward as requirements.
- **Phase 4 — cleanup fallout:** [`task-2026-06-14-x-pipeline-unification-cleanup.md`](./task-2026-06-14-x-pipeline-unification-cleanup.md). Pure polish that depended on Phase 3 (plus the small #46-item-2 feature, P4.7). ✅ Done.

The "Agreed design decisions", "Explicitly NOT doing", and "What's good — do not disturb" sections below are reproduced (and kept current) in the Phase 3 doc.

---

## Explicitly NOT doing (documented decisions)

- **#40 Tier 3 — sidecar worker / job queue.** Moving derivatives into a memory-capped sidecar container (or a server-side job queue with concurrency control) is the one unaddressed #40 item. It is **out of scope**: the resumable pipeline (Task 4) + the cgroup `mem_limit` (Task 1) + the memory hardening (Task 2) together make the OOM non-recurring for a single-user tool that makes no new long recordings between deploys. Revisit only if a real recurrence or a multi-user future makes it worth the operational complexity.
- **Segments arriving *after* a video reaches `ready` are not re-stitched** (`/complete` keys "segments changed" off the prior status). The Mac `HealAgent` computes the missing set once and sends a single final `/complete`, so this is theoretical given the client protocol. **Document the assumption** rather than build machinery for it.
- **`isProbablyPlayable` is header-only** and won't catch a declared-vs-actual frame-rate mismatch (a full decode would). This is deliberate — declared ≠ avg fps is normal for honest VFR (Task 3) — and a declared-vs-avg heuristic would false-positive on every healthy recording. **Do not add one.**
- **A `processing` video that stalled (e.g. interrupted run) keeps serving HLS** even when its `source.mp4` is fine. This is the conscious no-auto-retry stance; it's surfaced by the "needs attention" filter and recovered by a manual reprocess.

## What's good — do not disturb

The registry shape (`{kind, tier, inputs, appliesTo, run, validate, artifact}`); `VARIANTS` as the single height/crf/kind source; `isProbablyPlayable` as the one validity primitive run once at generation/intake (with the viewer never re-probing); table-`ready`-AND-disk-`stat` for "servable"; atomic tmp→rename + validate-before-rename (including the in-place audio replace); the `cleanup.ts` validated-`ready` + active-file gate (the property that prevents permanent unplayability); `completedAt` set-once; the two-axis status/ledger split; and the no-auto-retry decision. These are all correct.

---

## Suggested sequencing

**Phase 1 ✅ → Phase 2 ✅** landed here (one branch, one commit each). **Phase 3** (the unification) and **Phase 4** (cleanup that falls out of it, incl. [P4.7]) continue in their own docs — Phase 4 depends on Phase 3.

## References

- Source review: [#48](https://github.com/dannysmith/loom-clone/issues/48). Folded follow-ups: [#46](https://github.com/dannysmith/loom-clone/issues/46) (item 1 → P3.1, item 2 → P4.7, item 3 → P2.4); [#40](https://github.com/dannysmith/loom-clone/issues/40) (close — Tier 3 only, out of scope). [#45](https://github.com/dannysmith/loom-clone/issues/45) (P4.3) already shipped.
- Background: [task-4 robustness](../tasks-done/task-2026-06-06-4-post-processing-status-and-robustness.md), [task-4 review fixes](../tasks-done/task-2026-06-06-x-post-processing-review-fixes.md), [task-2 memory hardening](../tasks-done/task-2026-06-02-2-derivatives-pipeline-memory-hardening.md), [task-3 frame-rate correctness](../tasks-done/task-2026-06-03-3-frame-rate-metadata-correctness.md).
- Developer docs to read before executing: `docs/developer/streaming-and-healing.md`, `docs/developer/server-routes-and-api.md`, `docs/developer/admin-editor.md`, `docs/developer/audio-post-processing.md`.
