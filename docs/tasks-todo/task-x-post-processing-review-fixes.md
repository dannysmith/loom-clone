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

_(Append code-review findings below as we go.)_
