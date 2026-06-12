# Unify the Post-Processing Pipelines — collapse the parallel edit-pipeline into one parameterised pipeline

> **✅ DONE** on branch `task-1-phase-3-pipeline-unification` (manually verified end-to-end in dev). The edit commit now runs as an `edit`-mode pipeline run: a new `edited_output` step applies the EDL, the run stages→validates→swaps atomically, and `finalizeEdit` derives captions + flips the video to edited. `reconcile` settles `reprocessing` (never demotes); the old `edit-pipeline.ts` was reduced to `edit-reset.ts` (just `resetAllEdits`, still used by the build-reprocess chokepoint); `hold`/`resetRegeneratedSteps` are gone. **[P3.2]** chapters fix shipped. **One deferral:** gating `resolve.ts` serving on `edited_output` was left to Phase 4 — the existing source+metadata+active-file gate already serves the edited cut for new *and* legacy edited videos, so this avoids a serving regression. See [Phase 4](./task-x-pipeline-unification-cleanup.md).

## Lineage

This is **Phase 3** of the work originally scoped in [post-processing & admin pipeline unification](../tasks-done/task-2026-06-11-1-post-processing-pipeline-unification.md) (Phases 1–2 shipped; see that doc for the full review, the [#48](https://github.com/dannysmith/loom-clone/issues/48) findings, and the folded-in issues). Phase 1 (independent correctness fixes, incl. the live editor-lock bug) and Phase 2 ("shrink the model" SSOT prep) are **done and merged**. This doc is the centrepiece refactor that those phases de-risked. **Phase 4** (cleanup fallout) is split into its own doc: [pipeline-unification cleanup](./task-x-pipeline-unification-cleanup.md) — it depends on this.

This subsumes **[#46](https://github.com/dannysmith/loom-clone/issues/46) item 1** (staged atomic swap for the from-HLS rebuild).

---

## The core problem (the architecture headline)

The docs describe a clean two-axis model: a single behaviour-driving `status`, and a derived artifact-readiness *ledger* (`video_processing_steps`). That model is good and should be kept. But several concepts still have parallel implementations, and almost every structural finding traces back to a single root cause: **the edit-pipeline (`lib/edit-pipeline.ts`) is a parallel re-implementation of the main pipeline (`lib/processing/pipeline.ts`).** Collapsing that is the biggest single win.

After Phases 1–2, the remaining duplication is concentrated in the edit-pipeline:

- **Two pipelines** with **two atomicity strategies** (the edit-pipeline's staging-dir swap vs. the main pipeline's `hold` + `resetRegeneratedSteps` dance) and **two independent in-flight maps** (Phase 1 added the shared `run-lock` as a cross-cutting *signal* on top, but each pipeline still keeps its own coalescing `inFlight` map — this phase collapses them into one).
- The edit-pipeline **writes `status` itself** via raw `videos` UPDATEs (`reprocessing`, `ready`) and **never calls `reconcile`** — which is *why* `reconcile` isn't really the single post-footage status owner and why `recoverStrandedReprocessing` has to exist.
- The edit-pipeline **writes ledger rows by hand** with hardcoded variant literals (`"720p.mp4"`/`"1080p.mp4"`), a fourth place the variant kind↔height↔filename mapping lives, and marks them `ready` on bare `exists()` rather than the validated state the main pipeline gates on.

> Note: Phase 1 already added the shared per-video run-lock (`lib/processing/run-lock.ts`) registered by both pipelines, and Phase 2 already extracted `rollupFromSteps`, the `lib/status.ts` taxonomy home, the registry-driven `inferStepsFromDisk`, and the `recordExternalStep` receipt helper. The `runFfmpeg` wrapper duplication called out in #48 is also already gone (Task 2 routed it through `spawnFfmpeg`). Build on those.

---

## Agreed design decisions (treat these as requirements)

These were settled during the #48 review — implement *to* them. If implementing forces a pile of `if (mode === 'edit')` into every step, that's a sign the abstraction is wrong — stop and reconsider.

1. **Unify into one parameterised pipeline.** "Edit" becomes a *mode* of the main pipeline, not a separate pipeline. The differences must be expressible declaratively:
   - The **"active file" is a context concept** (defaults to `source.mp4`; in edit mode it is the EDL-cut `{height}p.mp4`). Downstream steps (variants, storyboard, captions, metadata) consume the active file and don't care how it was produced.
   - **Source/active-file production is a strategy**: stitch-from-HLS (recorded) | remux (uploaded) | apply-EDL (edited).
   - The **only genuinely edit-specific behaviours** are (a) applying the EDL and (b) deriving the *edited* transcript into the DB. Everything else is an `appliesTo` gate (`audio` → recorded-and-not-edited; `suggested_edits` → not-edited; etc.).
2. **`reprocessing` keeps its own status, with a crisp meaning:** *an edit-style run is in flight and `source.mp4` is preserved* (the active file becomes the edited cut). `processing` = a run that **produces or changes `source.mp4`** (first build, heal re-stitch, forced from-HLS rebuild). `reconcile` picks the in-progress label from the run's mode.
3. **One atomicity primitive, scoped correctly.** Adopt the edit-pipeline's stage→validate→swap as the single mechanism for **rebuilds/edits that replace an already-served set** — which lets us delete the `hold`/`resetRegeneratedSteps` workaround. **The first post-recording build stays incremental** (reaches `ready` on `source` + `metadata`, then enriches) so a quick video is shareable in seconds. Do not make the first build wait for all derivatives.
4. **Editing is gated and serialised.** The editor is openable iff `status === ready` **AND** there is no in-flight pipeline run for that video (the optional Mac-sent steps must *not* gate it). A single **shared per-video lock** serialises the main pipeline, reprocess, per-artifact regen, and edit so two runs can never touch one `derivatives/` dir at once. (In-memory is sufficient — after a crash there is no concurrent writer.) *Phase 1 already shipped this lock (`run-lock.ts`); this phase routes the unified pipeline through it.*
5. **An uploaded video that fails post-processing serves the original `upload.mp4`, never a dead player.** *Shipped in Phase 1 (P1.3).* Keep the behaviour intact through the refactor.
6. **No auto-retry (keep the decision)** — the dead `attempts` machinery was already removed in Phase 1.

### Current-state caveats (verified against `main`, post Phase 1–2)

The decisions above are the *target*. A few of them describe state that doesn't exist yet — note these so the implementation doesn't assume them:

- **There is no `captions` step.** Decision 1(c) / the direction say the edited-transcript-to-DB "becomes part of the captions step," but the registry has no such step today (captions come from the Mac transcript upload → `captions.srt` + DB row, and the edit-pipeline's `deriveEditedCaptions`). This phase must **create** a captions step (or place the edited-transcript derivation deliberately), not fold into an existing one.
- **`reconcile` does not own `reprocessing` today — by design.** `RECONCILE_OWNED` (now in `lib/status.ts`) excludes it, and `recoverStrandedReprocessing` exists *precisely because* the editor writes that status out-of-band. Decision 2 therefore requires a real change to the ownership invariant: add `reprocessing` to `RECONCILE_OWNED` (or equivalent) and pass the run **mode** to `reconcile` so it maps "in-progress" → `reprocessing` for edits. `rollupFromSteps` returns only `ready`/`processing`/`processing_failed`, so the mode→label mapping is layered on top. `recoverStrandedReprocessing` only shrinks *after* that lands.
- **The run-lock currently gates only the editor.** `hasActiveRun` is consulted in exactly two places (editor page-load + commit) plus the UI button. Decision 4's "serialises the main pipeline, reprocess, per-artifact regen, and edit" is the *target* — reprocess and per-artifact regen are gated by `status`/`canReprocess`, **not** the lock, today. Wiring them through the lock (or through the unified pipeline's single `inFlight` map) is part of this phase.
- **Edit-mode `appliesTo` must also gate off `thumbnail` and `peaks`, not just `audio`/`suggested_edits`.** Today the edit-pipeline regenerates only variants/storyboard/captions and leaves the thumbnail, peaks and editor-storyboard reflecting the original `source.mp4` (the editor always works from source). Preserve that: in edit mode, `thumbnail` and `peaks` stay source-based (gated off). Regenerating peaks from the edited audio would be a *conscious* behaviour change, not a freebie — decide it explicitly.

> The `edit-pipeline.ts` line numbers in the divergences below are approximate — they drifted slightly after the Phase 1 merge. Re-anchor them at execution time.

---

## The work

### [P3.1] Eliminate the parallel edit-pipeline (subsumes #46 item 1)

**The divergences to remove:**

- **Own status writes** — it sets `reprocessing`/`ready` via raw `videos` UPDATEs (`edit-pipeline.ts:~144/~154/~273`) and never calls `reconcile`. This is why `reconcile` isn't really the single owner and why `recoverStrandedReprocessing` has to exist.
- **Own ledger writes with hardcoded variant literals** — it marks `variant_720`/`variant_1080`/`storyboard` by hand (`edit-pipeline.ts:~250-260`, `"720p.mp4"`/`"1080p.mp4"`), defeating the `VARIANTS` single-source-of-truth. Add a third rendition and the edit path silently won't mark it.
- **A different "ready" definition** — it marks ledger rows `ready` on bare `Bun.file(...).exists()` rather than the validated state the main pipeline gates on (it *does* run `isProbablyPlayable` on the staged outputs before swap, but the ledger marking itself is existence-only).
- **A second atomicity strategy** — staging-swap (`.edit-staging`), vs. the main pipeline's `hold` + `resetRegeneratedSteps` (`pipeline.ts` + `reconcile.ts`).

**Direction (the end state):**

- Edit becomes a **mode**: the active-file production step gains an apply-EDL strategy; downstream steps consume `ctx.activeFile`; `audio`/`suggested_edits` are gated off via `appliesTo`; the edited-transcript-to-DB becomes part of the captions step.
- The edit commit goes through the normal scheduling so **`reconcile` writes status** (picking `reprocessing` vs `processing` from the run mode, decision 2) and **`runStep` writes the ledger** (validated, off `VARIANTS`).
- **Staging-swap becomes the single rebuild atomicity primitive** (decision 3), used by edits *and* the forced from-HLS rebuild; **`hold`/`resetRegeneratedSteps` are deleted**. The first post-recording build keeps publishing incrementally.
- `recoverStrandedReprocessing` shrinks to (at most) "a run was interrupted; settle a video whose required steps validated back to `ready`," since the editor no longer owns status out-of-band.

**Where:** `lib/edit-pipeline.ts` (whole file), against `lib/processing/pipeline.ts` + `registry.ts` + `lib/derivatives.ts` + `routes/admin/editor.ts` + `reconcile.ts`.

#### Active file ↔ ledger model (resolved: Option B)

The edited cut `{height}p.mp4` is the file an edited video actually serves, yet today it has **no ledger step** and is gated at serve time by bare disk-presence (`resolve.ts`), not a validated `ready` state — a weaker guarantee than recorded videos get. The unified model fixes this with a **dedicated active-file step** rather than overloading `source`:

- **`source` keeps meaning `source.mp4`** — the preserved original. Its row is set `ready` at first build and stays valid forever (editing never mutates `source.mp4`). `reprocessability.sourceValid`, re-editing, and from-source regen all keep relying on it unchanged.
- **Add an `edited_output` step** (the active-file step): `appliesTo` = the video is edited; `artifact(ctx)` = `ctx.activeFile` (the `{height}p.mp4` cut); `validate` = `isProbablyPlayable`. So the edited cut becomes a first-class, validated artifact that's **visible in the readiness checklist** (today it's invisible).
- **Serving gates on the active-file producer.** `resolve.ts` serves the active file iff *the step that produced it* is `ready` AND the file is present — `source` for recorded/uploaded, `edited_output` for edited. (This is the natural home for Phase 4's `isServable(step, ctx)` predicate.)
- **`ready` (status) stays `source` + `metadata`.** `lastEditedAt` is set **only after** a validated staging-swap, so by the time a video presents as edited its `edited_output` is already valid — `ready` needn't add a mode-dependent required kind. (`metadata` describes the edited output for edited videos, as today.)

**Failure behaviour — preserve exactly what we have:** staging-swap never swaps a set that fails validation, and `lastEditedAt` is set only after a successful swap. So a failed edit leaves the *prior* served state untouched (the previous edited cut, or `source.mp4` for a first edit) — it can never produce a dead player, and it must **never** silently fall back to serving the un-edited `source.mp4` in place of an intended edit.

### Suggested decomposition (commit at each safe checkpoint)

Refine this when execution starts; the goal is reviewable, individually-committable steps rather than one giant diff.

1. **Introduce `ctx.activeFile`** and route the existing downstream steps (variants, storyboard, metadata) through it — no behaviour change yet (active file is still `source.mp4` for every current path).
2. **Add the run "mode"** (`recorded` | `uploaded` | `edit`) and the source/active-file production strategy, with `appliesTo` gates for `audio`/`suggested_edits`. Still no edit path wired in.
3. **Adopt staging-swap as the shared rebuild primitive** for the forced from-HLS rebuild; delete `hold` + `resetRegeneratedSteps`; verify the incremental first-build still publishes early.
4. **Route the edit commit through the unified pipeline**: apply-EDL strategy producing the `edited_output` active-file step (validated, serving-gated per the model above) + the new captions step deriving the edited transcript; `reconcile` + `runStep` own status + ledger.
5. **Delete `edit-pipeline.ts`'s parallel machinery** and shrink `recoverStrandedReprocessing`.

Each step needs tests; the editor end-to-end (record → commit a trim → quality menu stays consistent) is the key regression to guard.

### [P3.2] Only expect `chapter_titles` when chapters were recorded during recording

**Problem:** the `chapter_titles` external step's `appliesTo` is just `source === "recorded"`, so *every* recorded video shows "Chapter titles" as ❌ (and a `ready` video's badge reads "awaiting chapter titles") until the Mac sends suggestions — even when no chapter markers were ever recorded, in which case the Mac will *never* send them. The step should only be *expected* when the macOS app actually recorded chapter markers during the session (those are what trigger the Mac's suggested-title pass); otherwise it should read "—" (not applicable), not ❌.

This is specifically about chapters **recorded during recording** — *not* chapters a user adds/edits later in the editor. Those are a separate, post-processing-independent concern; the Mac only suggests titles for markers that existed at recording time.

**The data already exists — no new on-disk file generation is needed:**
- `chapters.json` is written at `/complete` from `recording.json` *only when `extractChaptersFromTimeline` finds markers* (`routes/api/videos.ts:240-246`), so its mere presence already implies recorded markers.
- Better still, each `Chapter` carries a `createdDuringRecording: boolean` flag (`lib/chapters.ts:21`), which cleanly distinguishes recorded markers from editor-added ones — so an editor-added chapter on an otherwise marker-less recording won't wrongly re-trigger the expectation.

**Direction:** gate `chapter_titles` applicability on "at least one chapter with `createdDuringRecording === true`." Because `appliesTo(ctx)` is synchronous, thread the boolean into `StepContext` (e.g. `ctx.hasRecordedChapters`), populated where the applicability context is built for the **readiness UI** (`computeReadiness`) and **backfill** (`inferStepsFromDisk`) — both already async, so they can `readChapters()` first. The live pipeline never evaluates this step (it's external), so its context can leave the field undefined. Then `chapter_titles.appliesTo = ctx.source === "recorded" && ctx.hasRecordedChapters === true`.

Folded into Phase 3 because it's exactly the `appliesTo` + context-threading work the unification is already doing (decision 1); it can land as an early, self-contained commit. **Where:** `lib/processing/registry.ts` (the `chapter_titles` step + `StepContext` + `applicabilityContext`), `lib/processing/readiness.ts`, `lib/processing/backfill.ts`.

---

## What's good — do not disturb

The registry shape (`{kind, tier, inputs, appliesTo, run, validate, artifact}`); `VARIANTS` as the single height/crf/kind source; `isProbablyPlayable` as the one validity primitive run once at generation/intake (with the viewer never re-probing); table-`ready`-AND-disk-`stat` for "servable"; atomic tmp→rename + validate-before-rename (including the in-place audio replace); the `cleanup.ts` validated-`ready` + active-file gate (the property that prevents permanent unplayability); `completedAt` set-once; the two-axis status/ledger split; and the no-auto-retry decision. These are all correct. Phase 2's `rollupFromSteps`, `lib/status.ts`, and `recordExternalStep` are the SSOT foundations this phase builds on.

## Explicitly NOT doing (documented decisions)

- **#40 Tier 3 — sidecar worker / job queue.** Out of scope: the resumable pipeline + cgroup `mem_limit` + memory hardening together make the OOM non-recurring for a single-user tool. Revisit only if a real recurrence or a multi-user future makes it worth the operational complexity.
- **Segments arriving *after* a video reaches `ready` are not re-stitched.** The Mac `HealAgent` sends a single final `/complete`, so this is theoretical given the client protocol. **Document the assumption** rather than build machinery for it.
- **`isProbablyPlayable` is header-only** and won't catch a declared-vs-actual frame-rate mismatch. Deliberate — declared ≠ avg fps is normal for honest VFR (Task 3). **Do not add a decode-based check.**
- **A `processing` video that stalled keeps serving HLS** even when its `source.mp4` is fine. Conscious no-auto-retry stance; surfaced by the "needs attention" filter, recovered by a manual reprocess.

## References

- Parent doc / source review: [Phases 1–2 + full review](../tasks-done/task-2026-06-11-1-post-processing-pipeline-unification.md), [#48](https://github.com/dannysmith/loom-clone/issues/48), [#46](https://github.com/dannysmith/loom-clone/issues/46) (item 1 → here; item 2 → Phase 4 P4.7; item 3 → shipped P2.4).
- Developer docs to read before executing: `docs/developer/streaming-and-healing.md`, `docs/developer/server-routes-and-api.md`, `docs/developer/admin-editor.md`, `docs/developer/audio-post-processing.md`.
