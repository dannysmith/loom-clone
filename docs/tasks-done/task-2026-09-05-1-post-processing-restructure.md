# Post-Processing Restructure & Pipeline Orchestrator Redesign

Design doc for [#63](https://github.com/dannysmith/loom-clone/issues/63), which absorbed the pipeline half of [#5](https://github.com/dannysmith/loom-clone/issues/5). Comes from §6 of the [architecture review](../archive/architecture-review-2026-07-28.md).

Note: This should land before concurrent work on improving the audio chain is ported over. Today the audio chain is baked into `source.mp4` in place, so once the HLS segments are cleaned up after 10 days the pre-loudnorm audio is gone forever. Watermarking itself stays in #5 and becomes a consumer of the presentation step this doc introduces if we ever do it.

## The problem

The step registry is good. The three things that hurt are all consequences of one design decision — `source.mp4` doing two jobs at once:

1. **`source.mp4` is both the archive and the served file**, and the `audio` step rewrites it in place. That's why `audio` is excluded from `REGENERABLE_KINDS`, why "redo the audio" means "re-stitch from HLS", and why the original audio is unrecoverable after cleanup.
2. **"Edit" is a run mode rather than an input.** Five `mode !== "edit"` guards in `appliesTo`, `edited_output` mutating `ctx.duration` as a side channel to later steps, `finalizeEdit` living inside the generic orchestrator, and `resetAllEdits` existing only so a build reprocess can wash an edit away before running edit-unaware steps.
3. **`force` is one global boolean** driving three different things (re-stitch the source, redo everything, stage-and-swap), so each site re-derives what it means: `staged = !opts.only && (mode === "edit" || (force && video.status === "ready"))`.

## The model

Two roles, split into two files:

- **`source.mp4` — the pristine original.** Stitched `-c copy` from the HLS segments (or remuxed from `upload.mp4`), never modified afterwards, never served publicly. It is the backup, the editor's playback file, and the input every regeneration starts from.
- **`<H>p.mp4` — the presentation master**, where `H` is the source height. Always generated. Carries the audio chain, the EDL if one is committed, and (later) the watermark. It is what viewers are served, and what the downscaled variants are cut from.

Every artifact then belongs to exactly one of two groups, and the group determines when it regenerates:

| Group            | Derived from       | Artifacts                                                                    |
| ---------------- | ------------------ | ---------------------------------------------------------------------------- |
| **Source**       | `source.mp4`       | `thumbnail.jpg` + candidates, `peaks.json`, `editor-storyboard.*`, `suggested-edits.json`, geometry metadata |
| **Presentation** | `<H>p.mp4`         | the master itself, `1080p.mp4`, `720p.mp4`, `storyboard.*`, `captions.srt`, duration + size metadata |

`captions.srt` is in the presentation group because it has to follow the EDL. Its input, the Mac's uploaded transcript, is a source-group artifact — see [Captions](#captions).

The source group changes only when the source itself changes (a first build, or a heal re-stitch). The presentation group is regenerated wholesale, atomically, whenever anything about the presentation changes: an edit is committed, you press reprocess, or we run a bulk programatic reprocess after improving some part of the chain (eg adding watermarks).

**Committing an edit and reprocessing become the same operation.** `edits.json` stops being a mode trigger and becomes an input to the presentation master. `mode: "edit"` disappears.

### File layout after this lands (1440p recording, edited)

```
data/<id>/
  stream.m3u8, init.mp4, seg_*.m4s   # cleaned up 10 days after ready
  recording.json
  derivatives/
    source.mp4          # pristine original — never served, never modified
    edits.json          # the EDL (absent or empty = unedited)
    1440p.mp4           # presentation master: audio chain + EDL applied
    1080p.mp4           # cut from the master
    720p.mp4            # cut from the master
    thumbnail.jpg       # from source
    thumbnail-candidates/
    peaks.json          # from source
    editor-storyboard.* # from source
    storyboard.*        # from the master
    captions.original.srt  # the Mac's transcript, verbatim — never modified
    captions.srt        # served captions, mapped onto the presentation timeline
    words.json
    suggested-edits.json
```

## Settled decisions

1. **The editor plays `source.mp4`** — pristine, un-denoised, un-loudnormed. The editor shows what came in from the Mac app or the upload, which keeps the mental model simple. If audio processing later gains editor controls it will come with separate audio tracks anyway, at which point this gets revisited.
2. **`ready` does not wait for the master.** `REQUIRED_KINDS` stays `[source, metadata]`, so a video reaches `ready` (and hits the feeds) as soon as its footage is whole and probed. MP4 serving is gated separately on the presentation step being servable; until then the page serves HLS, exactly as it does today for a freshly-stopped recording. Consequence: **the public is never served `source.mp4`** — it's either the HLS playlist or an `<H>p.mp4`. (One documented exception survives: an *uploaded* video whose post-processing failed has no HLS, so `upload.mp4` remains its fallback.)
3. **The master uses `-c:v copy`** for now — identical video bytes, audio chain applied. That is exactly the work `processAudio` already does, written to a new filename instead of over the source, so this restructure costs ~zero extra CPU. Watermarking (#5) turns it into a full re-encode; a CRF re-encode may also become worth doing on its own for the disk/bandwidth saving.
4. **Full-resolution master.** Capping presentation at 1080p would defeat the point of the Mac app's 1440p preset.
5. **Eager migration** (see [Migration](#migration)). Every existing video gets a master up front, so there is exactly one shape on disk and `activeRawFilename` loses its branch.
6. **Reprocess honours `edits.json`.** A forced reprocess now regenerates the same edited cut instead of silently discarding the edit. Clearing every edit in the editor and committing is the revert path, and it already works (see [Empty EDL](#empty-edl-is-the-revert-path)).
7. **`<H>p.mp4` naming, with `video.mp4` as the public entry point.** Asking for "the MP4" should implicitly give the highest resolution; asking for a smaller one should be explicit. See [Serving and URLs](#serving-and-urls).

## Step table

Before → after. Removed: `audio`, `edited_output`. Added: `presentation`, `captions`, `editor_storyboard`.

| kind                | tier     | inputs                | applies when                        | artifact                     |
| ------------------- | -------- | --------------------- | ----------------------------------- | ---------------------------- |
| `source`            | required | —                     | always                              | `source.mp4`                 |
| `metadata`          | required | `source`              | always                              | — (DB geometry)              |
| `presentation`      | expected | `source`              | always                              | `<H>p.mp4`                   |
| `variant_1080`      | expected | `presentation`        | `height > 1080`                     | `1080p.mp4`                  |
| `variant_720`       | expected | `presentation`        | `height > 720`                      | `720p.mp4`                   |
| `storyboard`        | expected | `presentation`        | presentation duration ≥ 60          | `storyboard.vtt`             |
| `captions`          | expected | `presentation`, `transcript` | transcript received            | `captions.srt`               |
| `thumbnail`         | expected | `source`              | always                              | `thumbnail.jpg`              |
| `peaks`             | expected | `source`              | source duration ≥ 1                 | `peaks.json`                 |
| `editor_storyboard` | expected | `source`              | source duration ≥ 5                 | `editor-storyboard.vtt`      |
| `suggested_edits`   | expected | `source`              | source duration ≥ 5, never edited   | `suggested-edits.json`       |
| external (Mac-sent) | external | —                     | unchanged                           | unchanged                    |

Notes on the changes:

- **`presentation`** subsumes `audio` and `edited_output`. It reads `source.mp4`, computes kept segments from `edits.json` (absent → one full-span segment), and produces `<H>p.mp4`. When the kept set is a single full-span segment it takes the copy path (`-c:v copy` + audio chain, i.e. today's `processAudio` writing elsewhere); otherwise it takes the edit-render path (`buildEditArgs`, which already re-encodes). The audio chain is skipped for uploads and for non-pristine sources (see [`sourcePristine`](#db-changes)). It also writes `durationSeconds` and `fileBytes` — the properties that describe *what viewers get*.
- **`captions`** is the last of `finalizeEdit`'s work, promoted to a real step. See [Captions](#captions) — it needs one small change on the intake side to be correct.
- **`editor_storyboard`** is promoted from an ad-hoc try/catch in the orchestrator to a source-group step. It is a real artifact that can go missing; making it a step removes bespoke code from the orchestrator and puts it on the readiness checklist.
- **`metadata`** probes `source.mp4` for geometry (width/height/aspect) and reads `recording.json`. Geometry is identical for source and master (the edit render doesn't scale), so probing the source is equivalent and lets metadata stay early enough to gate `ready` without waiting on the master.
- **`thumbnail`** is source-derived and therefore does *not* re-run during a presentation rebuild. This is also the fix for a real hazard: `extractAndPromoteThumbnails` `rm -rf`s `thumbnail-candidates/`, including `custom-*.jpg` from the cover generator, and re-promotes an auto pick. Today that only happens on a rare deliberate rebuild; once "reprocess the whole library with watermarks" exists, the current behaviour would wipe every cover image in the library.
- **`REGENERABLE_KINDS`** becomes everything except `source` and `presentation`. Both are excluded for the same reason: they have dependents that would be left stale. `presentation` is regenerated via the presentation intent, which rebuilds its dependents with it.

### The `ctx.duration` side channel

`ctx.duration` is currently one field that `edited_output.run` mutates in place so that later steps' `appliesTo` see the edited value. Replace it with two named fields:

- `ctx.sourceDuration` — immutable for the run. Segment-duration sum for recordings (those rows outlive HLS cleanup), probed value for uploads. Drives the source-group steps and the EDL computation.
- `ctx.presentationDuration` — written by the presentation step from a probe of the master. Drives the storyboard threshold and the `durationSeconds` column.

This also removes `sourceExpectedDuration`'s special case (`undefined` for edited videos, because `durationSeconds` describes the edited cut rather than the source): with the segment sum available, the `source` step's duration check works for edited videos too.

### Captions

Captions need care, because the transcript arrives from the Mac *after* the pipeline has finished, and `PUT /api/videos/:id/transcript` currently writes the body straight to `captions.srt` with no EDL awareness. Two consequences today: an edit commit derives edited captions from `words.json` via `deriveEditedCaptions`, replacing the Mac's own segmentation; and a transcript that lands *after* an edit was committed (entirely possible for a long recording) silently overwrites the edited captions with a full-length SRT, desyncing subtitles for viewers. That second one is a latent bug now and would get worse once reprocessing is routine.

Fix the seam rather than working around it:

- The transcript endpoint writes the Mac's body verbatim to **`captions.original.srt`** (or `.vtt`) — a source-group artifact, pristine and never modified — instead of writing `captions.srt` directly. It then schedules an `only: captions` run.
- The **`captions` step** produces the served `captions.srt` by mapping the original onto the presentation timeline: an empty EDL is the identity, so it copies `captions.original.srt` verbatim (no re-derivation, so the Mac's segmentation is preserved exactly); a non-empty EDL derives from `words.json` + the kept segments, as `deriveEditedCaptions` does today.
- If the video is edited and `words.json` is absent, the mapping can't be computed: mark the step skipped and remove `captions.srt`, so viewers get no subtitles rather than wrong ones.

That makes captions declarative and resumable, gives the revert path the Mac's original segmentation back for free, removes the last piece of `finalizeEdit`, and closes the late-transcript bug — one implementation, reached both by the pipeline and by the upload endpoint.

**Alternative considered:** no pristine file; `captions` applies only when the EDL is non-empty, and reverting re-derives full-length captions from `words.json`. Less code and no new file, but it leaves the late-transcript bug open and means reverting an edit silently changes your subtitle segmentation.

**Migration:** for existing videos, `captions.srt` is either the Mac's verbatim upload (unedited) or a derived edited version. Copy it to `captions.original.srt` only for unedited videos; for edited ones re-derive both from `words.json` if present, else leave the existing file alone and mark the step ready.

## Orchestrator

Replace the build/edit × force × only × staged matrix with two sets and one rule.

```ts
type Run = {
  runSet: Set<ProcessingStepKind>;   // which steps to consider at all
  forceSet: Set<ProcessingStepKind>; // which to redo even when already ready
};
```

Four named intents build those sets. Nothing else in the orchestrator branches on intent:

| Intent      | runSet | forceSet         | Triggered by                                                     |
| ----------- | ------ | ---------------- | ---------------------------------------------------------------- |
| `intake`    | all    | all              | first `/complete`, heal re-`/complete`, "Rebuild from HLS"        |
| `present`   | all    | presentation group | commit edits, "Re-run post-processing", future bulk audio reprocess |
| `resume`    | all    | ∅                | a redundant `/complete`, filling gaps after a failure            |
| `only:kind` | {kind} | {kind}           | per-artifact ↻                                                   |

Everything else falls out:

- **Skip-if-ready** is unchanged; it just consults `forceSet.has(step.kind)` instead of a global boolean.
- **Staging** becomes one rule stated once: *stage when the run's force set includes an artifact the video is currently serving.* In practice that is `present` and `intake` on a `ready` video. `resume`, `only`, and a heal (which serves HLS, not MP4) write in place.
- **The reprocess chokepoint disappears.** `resetAllEdits` has no callers left and `edit-reset.ts` is deleted, because a `present` run rebuilds the correct thing whether or not there is an EDL.
- **`finalizeEdit` disappears** into the `captions` step, the presentation step's duration/size write, and one small post-run action (purge + `lastEditedAt`).
- **`lastEditedAt` is set by the presentation step**: non-empty EDL → stamp it; empty or absent → clear it. Duplicate/backfill keep working because they read the same file the pipeline does.

`inFlight`, `pendingRerun` and the run lock stay. The downgrade-protection logic simplifies to a precedence order over the four intents (`intake` > `present` > `only` > `resume`).

### Fix the staged swap

`runStepsStaged` does `readdir(staging)` then renames each entry into `derivatives/`. The thumbnail step creates `staging/thumbnail-candidates/`, and renaming a directory onto an existing non-empty directory fails with `ENOTEMPTY` — verified. So "Rebuild from HLS" on a `ready` video throws mid-swap, *after* some files have already moved, despite the log claiming the previous outputs were kept; and the catch only logs an event, never marking the step failed or reconciling. No test covers it, because the staged path is currently only exercised by edit runs, where the thumbnail step doesn't apply.

This restructure makes staged swaps the normal path, so the swap must be fixed properly: swap files only (steps that write directories belong to the source group and never run in a staged presentation rebuild), and assert that up front rather than discovering it at rename time. Add a test for a forced rebuild of a `ready` video that already has thumbnail candidates.

## Serving and URLs

`activeRawFilename(video)` becomes unconditional after migration: `${video.height}p.mp4`. The serving gate in `resolve.ts` keys on the `presentation` step being servable (the same `isServable` predicate); when it isn't, the page falls back to HLS as it does today. `cleanup.ts` already refuses to delete HLS while the active file's producer isn't servable, so a broken master can never leave a video unplayable.

Public URLs:

| URL                        | Behaviour                                                            |
| -------------------------- | -------------------------------------------------------------------- |
| `/:slug/raw/video.mp4`     | **New canonical entry point.** 302 → `/:slug/raw/<H>p.mp4`           |
| `/:slug/raw/<H>p.mp4`      | Serves that rendition directly (what the player's `<source>` list uses) |
| `/:slug/raw/source.mp4`    | 302 → `/:slug/raw/video.mp4` (back-compat; the pristine file is no longer publicly reachable) |
| `/:slug.mp4`               | 302 → `/:slug/raw/<H>p.mp4` directly — one hop, unchanged shape       |

`video.mp4` is what gets published in the JSON metadata, `llms.txt`, the Markdown view, the feeds, JSON-LD `contentUrl`, and the admin download link — so "give me this video" resolves to the best available rendition without the caller knowing its height. The player keeps receiving concrete per-rendition URLs so playback never pays for a redirect.

The admin editor's `/admin/videos/:id/media/raw/source.mp4` is a separate authenticated route and continues to serve the real pristine file.

Unchanged: `chapters.json` stays in recording-timeline coordinates and is remapped through `edits.json` at serve time.

## DB changes

One migration:

- `videos.source_pristine` — integer boolean, default true. False means "this video's `source.mp4` already has audio processing baked in, from before this restructure". It gates exactly one thing: whether the presentation step applies the audio chain. Worth surfacing in the admin video detail as a small note, since it means the original audio is unrecoverable for that video.
- `PROCESSING_STEP_KINDS`: add `presentation`, `captions`, `editor_storyboard`; remove `audio`, `edited_output`. The migration deletes the retired rows after deriving `source_pristine` from them.

`lastEditedAt` stays as a display/audit timestamp, but stops being consulted for behaviour — the EDL is the truth.

## Migration

Deliberately split in two, along the line of "what can run automatically" versus "what touches video files".

**At deploy — a normal drizzle migration** (applied by `initDb()` on startup, like every other one). Pure SQL, no ffmpeg, no filesystem:

1. Add `videos.source_pristine`, default true.
2. **Derive `source_pristine`** from the existing ledger: an `audio` row in state `ready` → false; `skipped`, absent, or an uploaded video → true. Deliberately conservative — `inferStepsFromDisk` marks `audio` ready merely because the source has an audio stream, so a video that never actually got loudnormed may be marked non-pristine. The only cost of that is a future audio reprocess leaving its audio alone.
3. **Re-key the ledger**: `edited_output` → `presentation`, then delete the `audio` rows.

**After deploy — a one-shot script** (`bun run videos:migrate-presentation`), run over SSH, per video:

1. **Materialise the master.** Unedited videos: copy `source.mp4` → `<H>p.mp4` (no audio chain — the audio is already baked in). Already-edited videos: `<H>p.mp4` exists and *is* the master, so there's nothing to produce; the drizzle migration already re-keyed its ledger row.
2. **Seed `captions.original.srt`** by copying the served `captions.srt`, which used to be the only copy of the transcript.
3. **Re-run `inferStepsFromDisk`** so the new kinds get rows, then `reconcile` each video.
4. Report per video: master created or already present, captions seeded, bytes added.

**Re-stitching moved out of the script.** The plan had it re-stitch `source.mp4` from surviving HLS segments to recover a genuinely pristine original. That turned out to be both the riskiest step — the only one that rewrites the irreplaceable file — and wrong on its own: a re-stitched source has *unprocessed* audio, so copying it as the master would produce a worse video than the one being replaced. Getting it right would mean running the audio chain inside the migration script, duplicating the pipeline.

Instead, the `source` step now sets `source_pristine = true` whenever it stitches, because a freshly stitched source is pristine by definition. That makes **"Rebuild from HLS" in the admin** the recovery path: it re-stitches through the real pipeline, flips the flag, and rebuilds the presentation with the chain applied properly. No special-casing, no duplicated logic, and the migration script keeps the property that it can't damage anything.

### Data-safety properties

These are requirements on the script, not nice-to-haves — the production data is the one irreplaceable thing in this system.

- **It never deletes OR REWRITES a video file.** It only creates `<H>p.mp4` and `captions.original.srt`. `source.mp4`, the HLS segments and the thumbnails are read-only to it. Nothing in this task removes footage.
- **Dry-run is the default.** It prints the full per-video plan (including projected bytes) and writes nothing without `--apply`.
- **Idempotent and resumable.** Re-running skips any video that already has a valid master, so an interrupted run is fixed by running it again.
- **Every produced file is validated before it counts.** Masters go through `isProbablyPlayable` and are written tmp→rename, exactly like the pipeline's own steps.
- **Disk headroom check up front.** Sums the projected additions and aborts if free space is under 2× that, rather than filling the volume halfway through.
- **The ledger is re-derivable.** If the row re-key goes wrong, `videos:backfill-processing-steps` reconstructs every step row from what's on disk. That is the backstop for the one part of the migration that isn't purely additive.
- **A restic snapshot immediately before.** `backup.sh` takes both a SQLite snapshot and the file set, so the pre-migration state is recoverable independently of any of the above.

Cost on the production box: 15 videos, 4.1 GB used of a 20 GB volume, 15 GB free. Materialising a master for each adds roughly the total size of all `source.mp4` files — on the order of 2 GB. Backup size is unaffected — `backup.sh` takes only `source.mp4`, the thumbnail, `recording.json`, `edits.json` and `words.json`, all of which stay as they are — but it gains one small file: **`captions.original.srt` must be added to the backup list**, because unlike `captions.srt` it is not regenerable from `words.json`. (`chapters.json` is missing from that list too — a known gap from the review, tracked separately.)

**Alternative considered — lazy migration:** leave existing videos alone and let `activeRawFilename` keep falling back to `source.mp4` until something touches them. Costs no disk and no ffmpeg, but keeps two shapes on disk indefinitely and preserves the branch in serving, cleanup, readiness and backfill — which is most of the conceptual confusion this task exists to remove. Given the numbers above, eager is the better trade. Flipping back is a small change if the disk picture changes.

### Ongoing disk cost

This roughly doubles the per-minute cost of a recording: ~79 → ~139 MB/min at 1080p, ~150 → ~248 MB/min at 1440p (source + master + variants, ignoring the transient HLS). Against 15 GB free that is roughly 108 minutes of future 1080p recording rather than ~190. Not near-term pressure at the current usage rate, but it moves two things up the list: a CRF (rather than copy) master, which for screen content is plausibly 30-50% the size of the VideoToolbox original and would make the master nearly free; and eventually object storage ([#4](https://github.com/dannysmith/loom-clone/issues/4)).

### Empty EDL is the revert path

Nothing gates the editor's Commit button on a non-empty EDL, and `computeKeptSegments([], d)` already returns one full-span segment. So "remove every edit, commit" produces a full-length master, re-derives full-length captions, restores `durationSeconds`, and clears `lastEditedAt` — with no new UI. Two rules make it exact: an empty or absent EDL clears `lastEditedAt`, and a single full-span kept segment takes the copy path rather than the crf-18 re-encode (so reverting doesn't cost a generation of quality).

## Phases

One PR, one commit per phase. Phases 1–5 happen in the branch and each ends green on `bun run check:all`; phase 6 happens on `main`, on the server, after the merge deploys.

**Deploy posture:** production downtime during the changeover is accepted. Merging phases 1–5 deploys code that expects a presentation master no video has yet, so until phase 6 runs, videos under 10 days old fall back to HLS and older ones have nothing to serve. That's the trade for not carrying a transitional serving fallback we'd only delete again. The admin panel keeps working throughout, which is what phase 6 needs.

### Phase 1 — Registry & orchestrator [✅ DONE]

The `presentation`, `captions` and `editor_storyboard` steps; retire `audio` and `edited_output`; run set / force set / the four intents; `sourceDuration` / `presentationDuration` replacing the mutated `ctx.duration`; the staged-swap directory fix; the transcript endpoint's pristine-original change; delete `edit-reset.ts` and `finalizeEdit`.

Tests: a forced rebuild of a `ready` video that already has thumbnail candidates (the `ENOTEMPTY` case, which has no coverage today), an edit commit, an empty-EDL revert, a reprocess that preserves an edit, per-artifact regen on an edited video, and a transcript arriving after an edit was committed.

### Phase 2 — Serving & URLs [✅ DONE]

`activeRawFilename` unconditional; `resolve.ts` gated on `presentation`; `/raw/video.mp4` plus the `source.mp4` and `/:slug.mp4` redirects; and every publishing surface that names a file — JSON metadata, the Markdown view, RSS/JSON feeds, `llms.txt`, JSON-LD `contentUrl`, oEmbed, the admin download link.

### Phase 3 — Migration tooling [✅ DONE]

The drizzle migration, the `migrate-presentation-masters.ts` script with `--apply` gating, and the [data-safety properties](#data-safety-properties) as executable behaviour rather than intentions — each one gets a test against synthetic fixtures. Also add `captions.original.srt` to `backup.sh`.

I can't validate this against real videos from here, so the script must be legible enough to review by reading, and its dry-run output detailed enough to check by eye on the box before `--apply`.

### Phase 4 — Documentation [✅ DONE]

Not a sweep for stale sentences — a rewrite where the mental model changed. The source/presentation split and the two artifact groups are the organising idea a future reader needs; several docs currently teach the opposite.

- `streaming-and-healing.md` — the derivatives table and the pipeline description; the source/presentation groups as the framing.
- `server-routes-and-api.md` — "Edited video file resolution" becomes general file resolution. Its "why not always generate a resolution-named file" rationale is deliberately reversed here and should say so rather than quietly disappearing. Plus `video.mp4` and the transcript endpoint's new behaviour.
- `admin-editor.md` — commit is no longer a special mode; the empty-EDL revert path.
- `audio-post-processing.md` — the chain writes the master, not the source, and is skipped per video via `source_pristine`.
- `transcription.md` — the pristine original and the derived served captions.
- `backup-and-restore.md` — a restored video needs a presentation rebuild before it serves.
- `AGENTS.md` — the project-structure block and anything describing the pipeline.

### Phase 5 — Codebase review [✅ DONE]

The standard end-of-large-change pass, before the PR goes up:

- **Comments.** Every comment near the code this touched, checked against what the code now does. The pipeline's comments do a lot of work — several record *why* something is the way it is, sometimes including hypotheses that were tested and refuted, and a stale one of those is worse than no comment at all. Evergreen phrasing, no references to this task or to the old mode matrix.
- **Tests.** Whether the new seams are actually covered, whether anything left behind is now testing a removed concept, and whether the ffmpeg-gated tests still gate correctly.
- **Refactor opportunities.** Duplication this work exposed or created, and anything from the review's nitpick list that this change now makes trivial (the third segment-filename regex spelling, the duplicated ffmpeg path lookups, the `DOWNSCALE_HEIGHTS` mirror in `metadata.ts` — all sit in files this touches).

### Phase 6 — Deploy & migrate production

On `main`, after merge. Can be driven from a session on the server itself; anything that needs fixing there goes back through the repo rather than being patched in place on the box.

1. Run `backup.sh` and confirm the restic snapshot and SQLite copy both landed.
2. Merge → deploy. The drizzle migration applies on startup: verify `source_pristine` is populated and the ledger re-key happened.
3. Run the migration script dry, read the plan, check the projected bytes against `df -h`.
4. Run it with `--apply`. Re-run it once after — it's idempotent, and a clean second pass is the signal that nothing was left half-done.
5. Verify by hand: all 15 videos play, an edited one serves its cut, `video.mp4` and the `source.mp4` redirect both resolve, readiness is green, feeds list what they should.
6. Purge the CDN for every slug — the raw URLs have changed and Bunny caches them long.
7. Run `backup.sh` again, so the post-migration state is the one that gets kept.

## Follow-on work this unblocks

- **Watermarking (#5)** — the presentation step gains an overlay filter and switches from copy to re-encode. The PiP-corner logic reads `recording.json`, which the step already has access to.
- **Retroactive audio reprocessing** — a bulk `present` run across every `source_pristine` video, once the audiolab chain is ported.
- **Self-healing presentation set** — the daily sweep could schedule a `present` run for any `ready` video whose master has gone missing or failed validation. Cheap now that "rebuild the presentation" is a single named intent. Probably belongs with [#61](https://github.com/dannysmith/loom-clone/issues/61).
