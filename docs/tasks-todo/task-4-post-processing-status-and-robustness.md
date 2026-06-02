# Post-Processing: Status Model, Serving Robustness & Recovery

## Background

A ~21-minute recording uploaded fine — all HLS segments landed on the server — but the post-processing pipeline ran the box out of RAM and the `bun` process was OOM-killed (`exitCode 137`) mid-pipeline. The container restarted cleanly, but the damage to that one video was already done:

- `derivatives/source.mp4` exists but is **not web-playable**; no other derivative was generated.
- The viewer page serves that broken `source.mp4` anyway, because serving is decided purely on **file presence**.
- The video's status is `complete`, so nothing tells me it's broken, and nothing ever re-runs the pipeline.

The memory-footprint fixes (Task 2) and the blast-radius limits (Task 1 for the container cgroup limit, plus the now-shipped `danny-vps-infra` host hardening) address what made the pipeline die and how widely it blasted. **This task is about the LoomClone-side robustness problems the incident exposed — which apply regardless of what caused the pipeline to die.** Three of them:

1. We mark a video `complete` when the *footage* is uploaded, not when it's actually *processed*. There's no honest representation of "we have the bytes but the video isn't finished baking", and no granular record of which post-processing steps succeeded.
2. If post-processing produces a broken (or partial) media file, we serve it anyway. We should serve the last-known-good thing (the HLS playlist) until we're confident a derivative is actually valid.
3. There's no way — automatic or manual — to recover a video whose post-processing was interrupted. It's stuck forever.

## Relationship to Tasks 1–3 (do those first)

This is the last of four tasks spun out of the [#40](https://github.com/dannysmith/loom-clone/issues/40) incident. It assumes the other three have landed:

- **Task 1 — container limits.** The cgroup `mem_limit`/`pids_limit` on the server container (from [#39](https://github.com/dannysmith/loom-clone/issues/39)). Pure infra blast-radius containment — not a code dependency of this task, but it's the floor under everything else: a future runaway dies inside its own cgroup instead of taking the box down.
- **Task 2 — memory hardening.** Permanent per-step footprint reductions (bounded ffmpeg stderr, coalesced thumbnail spawns, streamed peaks, operational logging). This task builds on that lower baseline. Task 2 deliberately left the **concurrency/dedupe** cause unfixed — **that fix lives here**: the `video_processing_steps` table + `reconcile` + skip-if-ready resumable pipeline make a re-entrant heal `/complete` a near-no-op and make dedupe durable across restarts, replacing the in-memory `inFlight` Map's blind spot. So do not write an interim dedupe guard before this task; it is one of this task's outputs.
- **Task 3 — frame-rate correctness.** Fixes the macOS writer's wrong `r_frame_rate` declaration and adds defensive `-fps_mode`/`-r` handling to the server's variant/storyboard encoders. This task's **reprocessing** only produces *correct* derivatives once Task 3(b) exists, so Task 3 precedes this one. Note also that the `isProbablyPlayable` check below is **header-only (no decode)** and will **not** catch the fps/DTS problem — that's a known, accepted limitation here; Task 3 may add a cheap fps-sanity heuristic this task's validation can adopt.

## What's actually happening (the gap)

Confirmed in code:

- `POST /api/videos/:id/complete` (`server/src/routes/api/videos.ts:257`) sets status straight to `complete` the moment all *segments* are present, then fires `scheduleDerivatives(id)` **fire-and-forget** (`:267`). So `complete` means "footage uploaded", not "video processed".
- The clipboard URL and the viewer page don't depend on status at all. The viewer decides MP4-vs-HLS purely on **file presence** (`server/src/routes/videos/resolve.ts:96` — `hasSource → MP4 else HLS`).
- The derivatives pipeline (`server/src/lib/derivatives.ts:630`) runs each step fault-tolerantly and emits **one terminal `derivatives_ready` event** at the very end (`:835`). That single event is the only durable record of what got produced — and it only exists if the process survives to the end. An OOM `SIGKILL` mid-pipeline leaves a half-populated `derivatives/` dir with **no record of what completed**, and status still `complete`.
- The in-flight dedupe is an **in-memory `Map`** (`:107`), wiped on restart, and **nothing re-triggers the pipeline on boot**. An interrupted video is stuck forever unless a heal happens to re-`/complete` it.
- `createUploadedVideo` (`server/src/lib/store.ts:248`) has the same shape: status `complete` immediately, derivatives fired afterwards.

Two facts that shape the design:

1. **The `status` enum already contains `processing` and `failed`** (`server/src/db/schema.ts:21`). `processing` is already used transiently by the *editor* re-render (`server/src/lib/edit-pipeline.ts:59` → back to `complete` at `:68`); the dashboard already has filters for both states (`DashboardPage.tsx:46`). `failed` is wired into the dashboard and admin validation but is **never set by any code path** — it's dead, waiting for exactly this.
2. **Presence ≠ valid.** Every step writes `.tmp` then `rename`s, and `rename(2)` is atomic — a kill *cannot* leave a truncated *final* file. So the broken `source.mp4` is almost certainly **byte-complete but semantically broken** (a `-c copy` stitch of a long, mode-switching recording that doesn't cleanly play), not a truncation. This matters: the robustness fix isn't "did the file finish writing" (atomic writes already guarantee that) — it's "**is this file actually a playable video**". Only the second check would have caught this incident.

## Core architectural idea: two orthogonal axes

The root bug is **conflation** — one `status` field is read as both "what is the system doing?" and "what does this video have?". Split them:

- **`status` = lifecycle / orchestration state machine.** Answers "what should happen next?". Drives healing, reprocessing, admin attention, deletion rules. Mutually-exclusive states. Its primary job is to tell me, at a glance in the admin panel, what state a video is in.
- **Artifact readiness = a checklist/inventory.** Answers "which derivatives does this video have, and are they valid?". A *set* of independent items, each present/absent/valid/skipped. This is the "✅ Upload finished | ✅ Serving source | ✅ Audio processed | …" idea.

Status is a coarse rollup *derived from* (segment-completeness + the mandatory subset of the checklist). The checklist is the source of truth for serving and for the detailed UI.

---

## Part 1 — The status state machine

### Decided: status is single-valued and behaviour-driving; "how far through post-processing" is a *derived badge*, not a status

A single `status` field is single-valued, but post-processing is a *set* of independent tasks that finish in any order (a transcript can arrive before variants finish encoding, or vice versa). So a linear "how far through" enum (e.g. "still server-processing" → "waiting on client" → "all done") can't faithfully represent the real state — those phases overlap. The tell: **only one moment actually changes behaviour** — "do we have a stable, validated video?" (serve MP4 vs HLS, allow edits, publish feeds, deletion rules all flip there). "Storyboard done?" / "transcript arrived?" change nothing the system *acts on*; they're things to *read*.

So: collapse the "ready region" into a **single `ready` status**, and express the remaining granularity as a **derived readiness badge** computed from the checklist (Part 2), shown next to the status. This is strictly *more* expressive than separate linear statuses — the badge can show "enriching **and** awaiting transcript" simultaneously, which an ordered enum cannot.

### The states (canonical)

| State | Meaning | Serves |
| --- | --- | --- |
| `recording` | capturing / uploading segments | HLS (live) |
| `healing` | segments missing, being backfilled (`/complete` re-runs afterwards as new segments arrive) | HLS |
| `processing` | core/mandatory pipeline running; no stable video yet | HLS |
| `ready` | stable validated MP4 exists (+ derived badge for everything else) | MP4 |
| `reprocessing` | manual or post-edit regeneration in progress (must land as an atomic set) | last-good |
| `processing_failed` | HLS plays fine, but core post-processing failed unrecoverably — needs attention | HLS |
| `incomplete` | never completed; footage may be partial/truncated, but plays whatever we have | partial HLS |
| `deleting` | being permanently deleted | — |

Notes on the choices:

- **`processing`** reuses the existing enum value, *redefined* from the editor's transient use to mean "core pipeline running". The editor's post-edit re-render moves to **`reprocessing`** (`edit-pipeline.ts:59` currently sets `processing`).
- **`failed` is split** into `incomplete` (footage broken, not viewer-playable) and `processing_failed` (viewer-playable now, but no stable video). These are genuinely different to triage: "nobody can watch it" vs. "it plays, but I don't have a stable archive copy yet". This finally puts the dead `failed` enum value (`schema.ts:21`, never set today) to work.
- **`reprocessing`** is its own state because edit-regeneration must finish atomically as a *set* — a new `1080p.mp4` beside a stale `720p.mp4` and a half-rewritten VTT is a real corruption mode the per-file atomic-rename design does **not** protect against. Two distinct pipelines feed it: regeneration **from HLS** (full) and regeneration **from `source.mp4`** (post-edit; skips the stitch + some steps — the editor already works this way).

### The derived readiness badge

Shown alongside `ready` (and computed from the `video_processing_steps` checklist, Part 2). Examples: `ready · enriching (2 left)`, `ready · awaiting transcript`, `ready · complete ✓`. It surfaces every distinction the old 4/5/6 idea wanted — "server enrichment still running", "waiting on client-generated extras", "everything done and good" — without forcing a false order onto concurrent work, and can show several at once. Optionally store a coarse rollup column for cheap dashboard filtering, but compute it from the checklist in one reconcile function — never hand-maintain it.

### Mandatory set (gate for `processing` → `ready`)

**Mandatory = `source.mp4` (validated playable) + `metadata`. Nothing else.** Specifically, audio processing is **not** mandatory:

- The stitched `source.mp4` is fully playable without loudnorm.
- Audio processing is the heavy, fragile step (it's what OOM'd) — gating "serve the good MP4" on the most failure-prone step is backwards.
- The fallback while audio is pending is HLS, and the HLS segments aren't loudnormed either — so serving the un-normalised MP4 is no worse on audio than the fallback, and better on everything else. (Safe under in-place replace on Linux: the audio rename swaps the inode; in-flight reads keep the old fd, new requests get the normalised file.)

A video that can only ever produce HLS (stitch/validation keeps failing) lands in `processing_failed`, not `ready`.

> **Implementation note — audio ordering.** Today `metadata` extraction runs *after* audio processing in the pipeline (`derivatives.ts` post-recipe ordering), so as written `ready` couldn't be reached until audio finished — which contradicts "audio isn't mandatory". Making the mandatory-set rule actually true means reordering/splitting steps so `metadata` (which only needs `source.mp4`) runs ahead of audio. There's a deliberate reason audio sits where it does, so treat the exact reordering as a **discussion at implementation time** (and after the other pending notes are folded into this doc) — not a settled detail here.

### Defining `incomplete` (upload-failed detection — needs new machinery)

Today nothing ever sets this: a recording that never `/complete`s just sits in `recording`/`healing` forever. Detection is **segment-activity based**, not a heartbeat:

> `status = recording`, no valid `/complete` received, **and** no new segment received for `n` minutes → mark `incomplete`.

`n` must be **large** — a user may legitimately pause recording for a long time, and a paused recording produces no segments. **Threshold: 4 hours.** Implementation: a periodic sweep (alongside the daily cleanup timer) comparing `now` against the latest `video_segments.uploadedAt` for `recording`-status videos. An explicit client-side abort signal could complement this later but isn't required.

**Viewer behaviour:** an `incomplete` video **serves whatever partial HLS it has** — we never got an authoritative `/complete`, so the footage may be truncated or missing its tail, but the segments on disk still play. (Contrast `processing_failed`, where footage is known-whole and fully watchable and only the MP4 pipeline failed.) `incomplete` never produces an MP4 derivative; it stays on HLS unless/until a heal or manual recovery completes it.

### Known accepted edge: stuck `healing`

`healing` is set when `/complete` finds a discrepancy between the client timeline (`recording.json`) and the on-disk segments (`missing > 0`). Two facts to be precise about:

- **A `healing` video has no derivatives yet.** `scheduleDerivatives` only fires when `/complete` lands with nothing missing (`videos.ts:266`). So during healing there is no `source.mp4` — the video serves **partial HLS**. It's watchable, just not a stable MP4.
- **Healing normally self-resolves:** the Mac re-uploads the missing segments and re-sends `/complete`; now `missing = 0`, which triggers the full build → `processing` → `ready`.

The Mac's `HealAgent` gives up after ~3 days, so in the rare case it never heals, a video can sit in `healing` indefinitely on partial HLS. **We accept this for now** — it's rare and the video is still playable. Not adding machinery to force-finalise a stuck heal in this task; recorded here so the decision is conscious.

### Transition mechanics

- **`reconcile(videoId)` owns the *post-footage* statuses.** Post-processing only ever runs on videos that have received `/complete` (so they have whole footage + `recording.json`). `reconcile` reads the `video_processing_steps` rows and sets `processing` / `ready` / `processing_failed` / `reprocessing` accordingly — replacing scattered `setVideoStatus` calls. It does **not** own the `recording`↔`healing` boundary: that's decided in the `/complete` handler by diffing the client timeline against on-disk segments (segment-completeness isn't knowable without that timeline). Call `reconcile` after each pipeline step, after a heal re-`/complete`s, and after a manual reprocess.
- **`completedAt` is redefined to mean "reached `ready`"** (first time a stable validated MP4 exists), replacing today's "footage complete" meaning. It still drives the 10-day cleanup cutoff (`store.ts:613`).
- **Feeds: two changes, not just purge timing.** (a) The feed *query* filters `status === "complete"` (`feeds.ts:24`) — it must become `ready`, or feeds break entirely after the rename. (b) Move `purgeGlobalFeeds` to the `processing → ready` transition so we don't RSS-publish before the MP4 exists. (`feed-items.ts` pubDate uses `completedAt`, which now means "reached `ready`".)
- **`DELETE /api/videos/:id` also refuses `processing` / `reprocessing`** (today only `complete`) so a mid-pipeline video isn't torn out from under ffmpeg.
- **Editor "Edit video" gates on `ready`** (today `status === "complete"`).
- **`duplicateVideo` must keep working under table-gated serving.** It copies tags, segments, and on-disk files (`store.ts:871–898`) but *not* the new `video_processing_steps` rows — so a duplicated `ready` video would have the derivative files yet no step rows, and fail the serving gate. Fix by either copying the step rows **or** (cleaner) re-deriving them for the copy by running the backfill/infer-from-disk helper against the copied files — re-deriving avoids carrying over stale rows. Apply the same wherever else we clone a video.
- **Audit every other status check** against the new value set: dashboard filters, `helpers.ts` `VALID_STATUS`, the metadata route, the API JSON shape, `cleanup.ts`.

### Uploaded videos: same lifecycle, different pipeline

Uploaded videos flow through the **same** `processing → ready` lifecycle and `reconcile` logic — set `processing` on upload (not `complete` immediately, as `store.ts:248` does today). But the *pipeline* genuinely differs, so the step set is source-type-aware. (Review `uploadSourceRecipe` / `scheduleUploadDerivatives` — they currently share `generateFromRecipes`, so uploads presently run audio processing etc., which we don't want.)

- **Source** is `upload.mp4` (remux/transcode → `source.mp4`), **not** stitched from HLS — there are no HLS segments.
- **No audio post-processing** — uploads aren't mic recordings; loudnorm/denoise shouldn't run on them.
- **No `recording.json`** — so no camera/mic names, no `recordingHealth`, no timeline-derived chapters, and none of the client-sent suggestion items (those are recorded-only — they show as `—`).
- **Variant/derivative selection** still keys off probed resolution/aspect, but the exact set may differ — flagged as a separate task, not solved here.
- **No HLS fallback exists for uploads** — so `source.mp4` validation matters even more here: a failed/invalid upload source has nothing to fall back to. The `processing_failed` semantics for the upload case need a moment's thought (there's no "serve partial HLS" escape hatch).

---

## Part 2 — The post-processing checklist

### Storage: a `video_processing_steps` side table

Matches the existing side-table pattern (`videoSegments`, `videoEvents`, `videoTranscripts`). One row per `(videoId, kind)`, recording **the outcome of each post-processing step** — whether we *produced or received* it and how that attempt went. It is **not** a live inventory of what's on disk: if a derivative is later deleted by hand, this table is *not* updated. It's a generation/receipt ledger, not the source of truth for current file presence.

- `kind` — stable key: `source`, `audio`, `metadata`, `thumbnail`, `variant_720`, `variant_1080`, `storyboard`, `peaks`, `suggested_edits`, `transcript`, `words`, `title_suggestion`, `description_suggestion`, `chapter_titles`.
- `state` — `pending | ready | failed | skipped`.
- `producedAt`, `sizeBytes`, `error`, `attempts` (`attempts` is informational — a manual reprocess increments it; there is no auto-retry, see Part 4).

**Because the table is a production record rather than a live inventory, anything that asks "is this servable right now?" checks the table _and_ the disk:** an artifact counts as servable only when its row is `ready` (validated good) **and** the file is still present (one cheap `stat`). That keeps the table honest while never serving a phantom file someone deleted by hand.

Why a table over the alternatives:

- **vs. boolean/timestamp columns on `videos`** — most queryable, but ~14 nullable columns, a migration per new kind, and no clean home for per-item error/size/attempts.
- **vs. a single JSON blob column** — extensible without migration, but not SQL-queryable (couldn't filter the dashboard by "videos missing a thumbnail") and no integrity.

### Expected vs. optional is computed, not stored

Whether an item *applies* is a pure function of `(source, durationSeconds, height)`, mirroring the existing gates in `derivatives.ts`:

- `variant_1080` applies iff `height > 1080`; `storyboard` iff `duration ≥ 60`; etc.
- **Source type drives the suggestion set:** a `recorded` video expects transcript/words/title/description/chapter-titles (Mac-sent); an `uploaded` video never will, so those show as `—` (not-applicable), never as "missing".

UI representation is simple **yes/no presence**, with the hourglass reserved for active work only:

- ✅ — we have it (row `ready` + file present).
- ❌ / `—` — we don't have it (`—` when it doesn't apply to this video: a 1080p variant on a 720p source, suggestion items on an uploaded video).
- ⏳ — **only** while a run is actively generating it (status is `processing`/`reprocessing` and it's not yet present). No perpetual "pending".

Three tiers of meaning drive *behaviour* (not the icon):

- **Required** (gates `processing → ready`; failure → `processing_failed`): `source`, `metadata`.
- **Expected** (should happen; absence is a soft warning, never blocks): `audio`, `thumbnail`, applicable `variants`/`storyboard`, `peaks`, `suggested_edits`.
- **External/optional** (Mac-dependent, may legitimately *never* arrive; never blocks, never `failed`): the suggestion items — shown as a plain ✅/❌.

### Relationship to the event log (hard constraint)

Readiness lives **only** in `video_processing_steps`. The event log is **never** queried to determine state — its job is the append-only audit trail. But each step outcome *also* appends an event. Concretely: replace the single terminal `derivatives_ready` event (`derivatives.ts:835`) with **per-step events** — as each step validates-and-renames, it upserts its `video_processing_steps` row *and* logs an event — **plus** a final "everything done" summary event when the run finishes (additive, for the activity feed). The old all-or-nothing terminal event was the wrong granularity on its own: it's absent precisely when you need it (on crash).

---

## Part 3 — Validate before serving; serve last-known-good

Once readiness is decoupled from raw file presence:

### A reusable "probably playable" check

Add a shared `isProbablyPlayable(path, { expectedDuration? })` helper — one `ffprobe` (container + stream headers, **no decode**, so it's fast). It checks:

- has a video stream,
- finite duration, and within tolerance of `expectedDuration` when we have one (recordings: from the segment-duration sum; uploads: from `probeDuration` at intake). Tolerance: **±2 s or ±2%, whichever is larger** (starting point, tune later).

Run it at three sites: on **every generated video derivative** as it's produced (the `ready` write is gated on it), at **upload intake** (catch a bad upload early), and as the thing that decides each step's `ready`/`failed` outcome in `video_processing_steps`. Keep it performant — one probe per file, header-only, never a full decode. The viewer **never re-probes per request** — it reads the table (`ready`) + a disk `stat`; validation cost is paid once at generation/intake.

(Out of scope: "does this codec play in *this* browser" — e.g. HEVC in Chrome. That's codec-compatibility, a separate concern from structural validity.)

(Also out of scope here — handled by **Task 3**: the declared-vs-actual frame-rate problem. A header-only probe reads the *declared* `r_frame_rate` and so cannot catch a 30-fps declaration over 60-fps content; only a full decode reveals the DTS collisions. We accept that `isProbablyPlayable` won't detect it. If Task 3 ships a cheap declared-vs-`avg_frame_rate` sanity heuristic, fold it in as an extra check at the same call sites.)

### Serving + cleanup

- **The viewer consults readiness, not raw presence.** Change `resolve.ts` `derivativeFlags` to gate on (`video_processing_steps` row = `ready` **AND** file present) rather than bare `Bun.file(...).exists()`. A broken or missing `source.mp4` is never served → viewer falls back to HLS automatically. **The gate must check the *active* raw file's step, not always `source`:** for edited videos `activeRawFilename` points at a variant (`{height}p.mp4`, `url.ts:19`), so the readiness check has to follow the same active-file logic the URL builders already do.
- **Cleanup must gate on validated `ready`, not existence — verify the whole path.** `cleanup.ts:37` currently deletes HLS segments once a `source.mp4` merely *exists*. It must instead require the `source` step = `ready` (validated good). **This is the single most important safety change here** — it's what stops a temporarily-broken MP4 from turning a video permanently unplayable once its HLS is gone. Double-check the entire cleanup path as part of this task.
- **In-place audio is the one hazard.** `processAudio` (`derivatives.ts:548`) renames the processed file *over* `source.mp4`. Run the same `isProbablyPlayable` check on the `.audio-tmp` *before* the rename — never overwrite a good served file with an unvalidated one.
- **Text files** (`words.json`, `captions.vtt`, `peaks.json`, `suggested-edits.json`) are tmp→rename whole-or-nothing, so half-writes aren't really possible. A trivial parse-check at write time (valid JSON / starts with `WEBVTT`) is sufficient — no need to go further.

---

## Part 4 — Reprocessing (manual only)

**No automatic recovery or retry.** We deliberately do *not* re-fire pipelines on server boot, and we don't auto-retry failures. Rationale: retrying a resource-driven failure (the OOM) just reproduces it, and in practice these failures will be rare — being able to *see* the state and click a button is worth more than hidden retry machinery, and far less code.

Consequences:

- A **deterministic** failure of a mandatory step (ffmpeg exits non-zero) → `processing_failed` immediately. Retrying wouldn't help.
- An **interrupted** run (process killed mid-pipeline, e.g. OOM) leaves the video in `processing` with no active run. Nothing auto-detects this — it simply shows as `processing` in the admin until I reprocess it. The dashboard status filter makes these easy to spot; a video sitting in `processing` long after its `updatedAt` is effectively "stalled, needs a manual kick".

### Resumable pipeline (skip-if-already-ready)

Today each run redoes everything from scratch. Generalize the "no-op if already present" pattern (`suggested-edits`/`chapters` already do this): each step is a no-op when its `video_processing_steps` row is `ready` **and** the file is present — unless a `force` flag is passed. So **re-running the pipeline _is_ "resume from where it failed"**: it only does the missing/failed steps. The manual button relies on this.

> Re-running 2-pass loudnorm on a long file is the memory-heavy step that OOM'd. Resumability avoids re-doing the cheap steps; the heavy one's footprint is already reduced by Task 2 (bounded stderr) and bounded further by the container cgroup limit (Task 1).

### Two reprocess pipelines, and the cleaned-up-HLS constraint

- **From HLS** — full pipeline, including the stitch → `source.mp4`. Only possible while the HLS segments still exist.
- **From `source.mp4`** — regenerate everything *downstream* of source (variants, thumbnail, storyboard, peaks, etc.). This is the editor's post-edit path (`edit-pipeline.ts`).

**Cleaned-up videos have no HLS segments** (deleted 10 days post-`ready`), so a from-HLS reprocess is impossible for them — only from-`source.mp4` works. The reprocess UI must detect this: if HLS is gone, offer only source-based regeneration; if `source.mp4` itself is missing/invalid **and** HLS is gone, the video can't be rebuilt from the server (data-loss territory — surface that clearly rather than offering a button that can't work).

**Edit regeneration is atomic-as-a-set** (the reason `reprocessing` is its own status): stage the full regenerated set to a side location, validate all of it, then swap — never leave a new `1080p.mp4` beside a stale `720p.mp4` and a half-rewritten VTT. This atomic-set requirement applies to **multi-file** regenerations — edits, and any full from-HLS rebuild that replaces several outputs. A **single-artifact** regenerate (Phase B — e.g. just the thumbnail) is already atomic via the per-file tmp→rename and needs no staged swap. So read the state-table phrase "must land as an atomic set" as "whenever a regeneration touches multiple files".

### Manual reprocess UI (two phases)

- **Phase A — global "Re-run post-processing" button.** Re-fires the (resumable) pipeline for the whole video. Nearly free given the resumable pipeline + reconcile.
- **Phase B — per-artifact "regenerate this" buttons.** Surfaced per checklist row, and **dependency-aware**: only offer a button when its inputs exist (no variant without a valid `source.mp4`; no re-stitch of `source.mp4` without HLS). Disable/hide buttons whose prerequisites are absent.

---

## Suggested sequencing

**Phase 0 — refactor for workability (major restructuring up front).** If we're going to make this easier to reason about, do it *before* building on top. Likely shape: a **step registry** where each post-processing step declares `{ kind, appliesTo(video), inputs, run(), validate() }`, plus the single **`reconcile(videoId)`** function that derives status from segment-completeness + `video_processing_steps`. This makes per-step events, skip-if-ready resumability, per-artifact buttons, and dependency-aware UI all fall out naturally instead of being bolted on.

**Phase 1 — foundation + the critical safety fix.** Add `video_processing_steps`; write it incrementally from the pipeline (per-step events + a final summary event); gate `processing → ready` on validated mandatory steps; add the `isProbablyPlayable` helper and run it on derivatives + upload intake; **fix `cleanup.ts` to require validated `ready`**; redefine `completedAt`; move feed publication; unify the uploaded-video path onto the same lifecycle (with its pipeline differences). This set alone would have prevented the incident.

**Phase 2 — serving + admin surface.** Point `resolve.ts` at (table `ready` AND disk present); render the checklist (✅/❌/⏳) and the derived readiness badge in `VideoDetailPage`; add the global "Reprocess" button (Phase A) and a dashboard "needs attention" filter; add the `incomplete` detection sweep.

**Phase 3 — granular controls + polish.** Per-artifact regenerate buttons (Phase B, dependency-aware); the two-pipeline (HLS vs source) reprocess distinction with cleaned-up-HLS handling; any suggestion-item display polish.

**Phase 4 — final refactor / cleanup pass.** A last sweep to simplify and tidy now that everything's in place.

---

## Migration & backfill

- **Status values:** existing `complete` rows → `ready`; the editor's transient `processing` usage → `reprocessing`.
- **Backfill `video_processing_steps` via a one-time script run on the server** (we have only a small number of live videos). It infers each step's state from on-disk presence (validating `source.mp4`/variants with the same `isProbablyPlayable` helper) so existing videos keep serving correctly under the new table-gated logic. **Do not regenerate existing videos** — that's a lot of processing for no benefit, and many old videos no longer have HLS segments (cleaned up), so they couldn't be rebuilt from scratch anyway.
- **Cleaned-up videos:** the backfill must mark their `source` step `ready` (so they keep serving the MP4) and simply record the HLS/segment-derived steps as absent — they must never be flagged as needing repair just because their HLS is gone.

## Still to pin during implementation

- Exact validation tolerance (starting at ±2 s / ±2%).
- Final event names (`processing_complete` vs. keeping `derivatives_ready` for the summary).
- Whether to add a coarse rollup status column for dashboard filtering or compute the badge purely on the fly (default: compute on the fly).
