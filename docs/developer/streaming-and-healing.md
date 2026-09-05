# Streaming & Healing

## The big picture

A recording is a series of HLS segment files (`seg_000.m4s`, `seg_001.m4s`, …) plus an `init.mp4` header. The client emits one segment every ~4 seconds while recording, writes it to local disk as a safety net, and uploads it to the server. The server assembles a playlist (`stream.m3u8`) from whatever segments are on disk at any moment, and viewers stream it back.

If a segment fails to upload live — network blip, server restart, app crash — the server ends up with a gap. Stop-time reconciliation and startup healing close those gaps in the background so the user's share URL becomes complete over time without any manual intervention.

Two principles drive the design:

- **Never lose footage.** Every segment is written locally before the upload is attempted. The local copy is the audit trail of what was recorded; the server copy converges towards it.
- **Instant shareability.** The URL goes on the clipboard at stop. If the server is still missing segments at that moment, the video plays back as far as it goes and heals itself in the background — the user is never blocked waiting for uploads to finish.

## File inventory

### Client: `~/Library/Application Support/LoomClone/recordings/<video-id>/`

| File             | Written when                                   | Purpose                                                                                                             |
| ---------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `init.mp4`       | First segment of a recording                   | HLS fMP4 header — single codec description for the whole stream                                                     |
| `seg_NNN.m4s`    | Every ~4s during recording                     | Composited HLS media segment (what viewers watch)                                                                   |
| `recording.json` | At stop, again after each heal                 | Structured timeline — session info, events, per-segment `uploaded` flag. Schema in `Models/RecordingTimeline.swift` |
| `screen.mov`     | During recording if a display was selected     | Raw screen master, ProRes 422 Proxy. Safety net for future re-composition                                           |
| `camera.mp4`     | During recording if a camera was selected      | Raw camera master, H.264 native resolution. Includes an audio track (AAC) when mic is also selected                  |
| `audio.m4a`      | During recording if a mic was selected         | Raw mic master, AAC                                                                                                 |
| `captions.srt`   | After transcription completes                  | Local backup of the generated SRT transcript                                                                        |
| `.transcribed`   | After transcript upload succeeds               | Sentinel — TranscribeAgent skips this recording                                                                     |
| `.orphaned`      | When a heal attempt gets a 404 from the server | Sentinel — stops HealAgent and TranscribeAgent from ever retrying this recording again                              |

### Server: `server/data/`

The video record itself (id, slug, status, visibility, timestamps, cached duration, etc.) plus the per-segment durations, slug redirects, tags, and event log all live in `server/data/app.db` (SQLite via Drizzle — see `server/CLAUDE.md` for schema and scripts). The per-video directory holds the blobs that need to be on a real filesystem:

`server/data/<video-id>/`

| File                        | Written when                                     | Purpose / lifecycle                                                                                                                       |
| --------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `init.mp4`, `seg_NNN.m4s`   | On each PUT                                      | Mirror of the client's segments — what viewers stream until the MP4s land. **Cleaned up 10 days post-`ready`**, and only once both the `source` and `presentation` steps are validated good |
| `stream.m3u8`               | After each PUT and after `/complete`             | The HLS playlist — rebuilt from the on-disk segment listing. **Cleaned up with segments**                                                 |
| `recording.json`            | On `/complete` (and re-`/complete` after heal)   | Server-side copy of the client's timeline, authoritative post-upload                                                                      |
| `chapters.json`             | On the first `/complete` carrying chapter markers | User-editable chapter list extracted from `recording.json` events. Times stored in the original recording timeline; remapped through `edits.json` at read time. Subsequent `/complete` calls are no-ops if the file already exists, so admin renames survive healing. |
| `derivatives/source.mp4`    | Background task once footage is whole (status → `processing`) | The **pristine original**: HLS stitched into one file with `-c copy`, nothing else applied. Never modified, never served publicly. Everything below is regenerated from it |
| `derivatives/<H>p.mp4`      | Same pipeline                                    | The **presentation master** at the source's own height (`1440p.mp4` for a 1440p recording). Carries the audio chain and any committed edit. This is what viewers are served |
| `derivatives/edits.json`    | On save in the admin editor                      | The EDL. Absent or empty means unedited; it's an input to the master, not a mode switch |
| `derivatives/thumbnail.jpg` | Same pipeline                                    | Promoted from `thumbnail-candidates/` — the best auto-selected or admin-chosen frame. ~1280px wide JPEG |
| `derivatives/thumbnail-candidates/` | Same pipeline                             | Multiple JPEG frames sampled from the video, scored by luminance variance. Admin can pick or upload custom. **Cleaned up 10 days post-`ready`** |
| `derivatives/720p.mp4`      | Same pipeline (if source > 720p)                 | Downsampled variant cut from the master, libx264 CRF 23 |
| `derivatives/1080p.mp4`     | Same pipeline (if source > 1080p)                | Downsampled variant cut from the master, libx264 CRF 20 |
| `derivatives/captions.original.srt` | On `PUT /api/videos/:id/transcript`      | The transcript exactly as the Mac's TranscribeAgent produced it. Never modified — it's the input the served captions are derived from |
| `derivatives/captions.srt`  | Same pipeline                                    | The served captions: the original mapped onto the presentation timeline. A verbatim copy when nothing is cut |
| `derivatives/storyboard.jpg`| Same pipeline                                    | Sprite sheet of preview frames for scrubber hover thumbnails |
| `derivatives/storyboard.vtt`| Same pipeline                                    | WebVTT mapping time ranges to sprite regions (`#xywh=`) for Vidstack |
| `derivatives/peaks.json`    | Same pipeline                                    | Waveform peaks from the source, for the editor timeline |
| `derivatives/editor-storyboard.*` | Same pipeline (if source ≥ 5s)             | Denser sprite sheet from the source, for the editor timeline |

## End-to-end flow of a recording

1. **Create.** User hits record. Client POSTs `/api/videos`. Server inserts a row in the `videos` table with `status: "recording"` and `visibility: "unlisted"`, returns `{id, slug}`.
2. **Segment loop.** Every ~4s the writer emits a segment. For each one:
   - Client writes it to the local recordings dir as a safety net.
   - Client PUTs it to `/api/videos/<id>/segments/<filename>` with an `x-segment-duration` header.
   - Server writes the bytes, updates the durations sidecar, rebuilds the playlist. Idempotent — re-PUTting the same filename is safe.
   - If the PUT fails, the client retries with exponential backoff (1s → 2s → 4s → 8s → 16s → 30s, then 30s indefinitely). No hard retry cap while the recording is active — the client keeps trying until it succeeds or stop-flow cancellation fires. A `ReachabilityMonitor` (backed by `NWPathMonitor`) pauses attempts while the network path reports `.unsatisfied`, so a Wi-Fi drop doesn't burn retry budget on attempts that can't plausibly succeed.
3. **Stop.** User hits stop. Client:
   - Finishes the writer and waits up to 10 seconds for the upload queue to drain. Anything still pending after that window is cancelled and left on local disk for the heal path — the stop flow never hangs on a long outage.
   - Snapshots the timeline and writes `recording.json` locally.
   - POSTs `/api/videos/<id>/complete` with the timeline in the body.
4. **Complete & diff.** Server:
   - Reads the timeline's `segments[].filename` list (plus `init.mp4`, added implicitly) as the expected set.
   - Lists `data/<id>/` to get the present set.
   - Returns `{ url, slug, missing }`. `missing` is empty if the server has everything; otherwise it's the gap.
   - Footage whole → `status: "processing"` (footage uploaded, not yet baked); footage missing → `"healing"`. `status: "complete"` no longer exists — see [Status model](#status-model).
   - Persists the received timeline as server-side `recording.json`.
   - Rebuilds the playlist.
   - If footage is whole, schedules the post-processing pipeline (stitch `source.mp4` → metadata → the presentation master → variants, storyboard, captions, thumbnail, peaks …) as a background task, which `reconcile()`s the video to `ready` once the mandatory steps validate. Fire-and-forget — the response is not delayed. See [Derivatives](#derivatives).
5. **URL on clipboard.** Client receives the URL. The UI copies it to the clipboard ~1 second after stop — the user is done.
6. **Heal (if needed).** If `missing` was non-empty, the client hands off to `HealAgent`. See below.

## Healing

Two entry points into the same core flow.

### Post-stop handoff

As soon as `/complete` returns a non-empty `missing`, `RecordingCoordinator` fires `HealAgent.scheduleHeal(...)` with the video id, local dir, timeline bytes, and the missing list. Fire-and-forget — the user's clipboard already has the URL.

### Startup scan

At app launch, `HealAgent.runStartupScan()` walks `~/Library/Application Support/LoomClone/recordings/`. For each session within the last **3 days** whose `recording.json` has at least one segment with `uploaded: false`, it kicks off a heal. Directories with a `.orphaned` marker are skipped. Recordings older than 3 days are ignored — if it didn't heal by now, it's very unlikely to ever heal cleanly. The window and the sidecar semantics are shared with TranscribeAgent in `Pipeline/LocalRecordings.swift`.

### The heal loop

For each video being healed:

1. **Preflight `/complete`.** Re-call the endpoint with the timeline to get the authoritative missing list. (Handles the case where a prior heal attempt already uploaded some segments.)
2. If the server returns 404, write `.orphaned` in the local dir and stop. Forever.
3. If `missing` is empty, flip the local `uploaded` flags to `true` (they were stale) and exit.
4. Otherwise, for each missing filename:
   - Read bytes from the local dir.
   - PUT to the server.
   - On success, patch the local `recording.json` to set `uploaded: true` for that filename. The read/patch mechanics are in `Helpers/SegmentLedger.swift` (free functions over a URL, unit-tested against a temp directory); the round-trip preserves fields the patcher doesn't know about, so a future schema addition survives a heal.
   - On 404, mark `.orphaned` and stop.
   - On any other failure, log and move on — the recording will be picked up again at next startup.
5. **Final `/complete`.** Re-POST with the updated timeline so the server's `recording.json` mirrors the healed local state. Server transitions `status: "healing"` → `"processing"` → `"ready"` when there's nothing missing.

## Status model

`status` is a single behaviour-driving lifecycle field; "how far through post-processing" is a *derived* readiness checklist (`video_processing_steps`), not part of `status`. The states:

| State | Meaning | Serves |
| --- | --- | --- |
| `recording` | capturing / uploading segments | live HLS |
| `healing` | segments missing, being backfilled | HLS |
| `processing` | core pipeline running; footage not yet whole and probed | HLS |
| `ready` | the footage is whole and probed | MP4 once the master lands, HLS until then |
| `reprocessing` | a staged rebuild is in progress | last-good |
| `processing_failed` | HLS plays, but core post-processing failed unrecoverably | HLS |
| `incomplete` | never `/complete`d; serves whatever partial HLS exists | partial HLS |
| `deleting` | being permanently deleted | — |

`reconcile(videoId)` (`src/lib/processing/reconcile.ts`) owns the post-footage transitions: it reads the step rows and sets `processing` / `ready` / `processing_failed` from whether the **mandatory** steps (`source` + `metadata`) have validated. `completedAt` marks the first time a video reached `ready`.

`ready` deliberately does *not* wait for the presentation master. It means the footage is whole and probed, so the video publishes to the feeds immediately; the page serves HLS for the minute or two until the master lands, exactly as it does for a freshly-stopped recording. MP4 serving is gated separately, on the `presentation` step.

The admin video page renders a **readiness checklist** (✅/❌/⏳/—) and a derived badge (`ready · enriching (N left)` / `awaiting transcript` / `complete ✓`) from `computeReadiness()`. Reprocess controls are dependency-aware via `reprocessability()` (`canRebuildSource` / `sourceValid` / `dataLoss`): a global **"Re-run post-processing"** (`POST /reprocess`, a `present` run that rebuilds the presentation set and honours whatever EDL is on disk), **"Rebuild from HLS"** (`POST /reprocess` with `rebuild=hls`, an `intake` run — only when the HLS/upload source still exists), and per-row **"↻" regenerate** buttons (`POST /reprocess/:kind`) for the steps in `REGENERABLE_KINDS` — everything except `source` and `presentation`, the two steps with dependents that would be left describing a file that no longer exists. When nothing can be rebuilt, a data-loss message replaces the buttons. A daily sweep (`markStalledRecordingsIncomplete`) marks `recording` videos with no segment activity for >4h as `incomplete`, and the dashboard **"Needs attention"** filter (`?attention=1`) surfaces `processing_failed` / `incomplete` / stalled-`processing` videos.

## Derivatives

Once footage is whole the video enters `processing` and the server runs a post-processing pipeline (`src/lib/processing/pipeline.ts`) that generates derivative files in `data/<id>/derivatives/`. Generation is fire-and-forget from the `/complete` handler so the stop flow is never delayed.

### Two files, two groups

`source.mp4` does one job: it is the pristine original, stitched `-c copy` from the segments and never touched again. It's the backup, the file the editor plays, and the input every regeneration starts from. It is never served to the public.

`<H>p.mp4` — the **presentation master**, named for the source's height — is what viewers get. Every video has one. It carries the audio chain, any committed edit, and eventually the watermark, and the downscaled variants are cut from it.

That split is what makes "reprocess the whole library with a better audio chain" possible years from now: the originals are still there to reprocess. It also sorts every artifact into one of two groups, which is the thing to hold in your head:

| Group            | Derived from | Artifacts                                                                     | Regenerated when |
| ---------------- | ------------ | ----------------------------------------------------------------------------- | ---------------- |
| **Source**       | `source.mp4` | thumbnail + candidates, `peaks.json`, `editor-storyboard.*`, `suggested-edits.json`, geometry metadata | the source itself changes — a first build or a heal re-stitch |
| **Presentation** | `<H>p.mp4`   | the master, `1080p.mp4`, `720p.mp4`, `storyboard.*`, `captions.srt`, duration and size metadata | anything about the presentation changes — an edit, a reprocess, a future watermark |

The source group is the editor's material and doesn't move when you edit. The presentation group is regenerated as a set, atomically.

### The registry

The pipeline is driven by a **step registry** (`src/lib/processing/registry.ts`) — each step declares `{ kind, tier, appliesTo, inputs, run, validate, artifact }`, and `inputs` is where the group shows up: source-group steps declare `["source"]`, presentation-group steps declare `["presentation"]`.

Steps run in this order: `source` (stitch HLS → `source.mp4`), `metadata` (ffprobe the source + `recording.json` → DB), `presentation` (the master — see [Audio Post-Processing](audio-post-processing.md)), `variant_1080`/`variant_720`, `storyboard`, `captions`, then the source-group steps `thumbnail`, `peaks`, `editor_storyboard`, `suggested_edits`. External (Mac-sent) artifacts — `transcript`, `words`, the suggestion items — get their step rows written by the API handlers that receive them, not the pipeline.

**There is no edit mode.** `edits.json` is an input to the presentation master, so committing an edit and pressing reprocess are the same run. Committing an empty EDL is how you revert.

Each step writes a `video_processing_steps` row (`pending`/`ready`/`failed`/`skipped`) plus an event, and `reconcile()` runs after each so status advances as soon as the mandatory steps are good.

Properties worth keeping in mind:

- **Validated, not just present.** A generated video derivative is `ready` only when `isProbablyPlayable` (one header-only ffprobe) passes — this is what catches a byte-complete-but-broken `source.mp4`. Text artifacts get a cheap parse check.
- **Atomic writes.** Steps write to `.tmp` and rename on success. A crash or ffmpeg failure leaves either a stale-but-complete final file or nothing — never a half-written output.
- **Skip-if-ready resumability.** A step is a no-op when its row is `ready`/`skipped` and (for file producers) the artifact is present — so re-running the pipeline *is* "resume from where it failed". This is the durable dedupe (the in-memory in-flight `Map` only collapses concurrent calls within one process).
- **Four run intents, not a mode matrix.** A run is described by two sets — which steps it considers, and which it redoes even when they're already `ready` — and four named intents build them: `intake` (re-stitch the source and everything from it), `present` (rebuild the presentation set from the existing source), `resume` (fill gaps, redo nothing), and `only` (one artifact). Staging follows from that: stage the presentation group when the run would replace what the video is currently serving.
- **Healed recordings regenerate cleanly.** A heal re-`/complete`s, dropping back to `processing`. Because healing *changes the HLS segments*, the `/complete` handler runs an `intake` when the prior status was `healing`/`incomplete` — otherwise skip-if-ready would keep the stale `source.mp4` stitched before the heal. (A first `/complete` from `recording`, or a redundant one on an already-processed video, uses `resume` — there's nothing to re-stitch.) The Mac-sent steps aren't server-run, so an intake never touches them.
- **A stitch means a pristine source.** The `source` step sets `source_pristine` whenever it stitches, because segments that came off the Mac have never been through the audio chain. That's what makes "Rebuild from HLS" the recovery path for a video migrated from before the presentation master existed.
- **Failures are scoped.** A failed *expected* step (audio, thumbnail, …) is logged and the pipeline continues. A failed *mandatory* step (`source`/`metadata`) lands the video in `processing_failed` (HLS still plays). Failures never invalidate the m3u8.
- **Serving is table-gated.** The viewer decides MP4-vs-HLS on the step table (`presentation` = `ready` AND the file present), not bare file presence — a broken or hand-deleted master falls back to HLS automatically (`src/routes/videos/resolve.ts`).
- **The audio chain is an enhancement, not a precondition.** If it fails, the master is still produced without it and the failure goes on the activity feed. A video with un-enhanced audio beats no video; a later reprocess retries the chain.
- **Stale file cleanup.** A daily timer removes HLS segments (`init.mp4`, `seg_*.m4s`, `stream.m3u8`) and `thumbnail-candidates/` from videos that have been `ready` for >10 days **and** whose `source` *and* `presentation` steps are both validated with their files present. Two gates because the two files have different jobs: the source is the archive that must outlive the segments, the master is what a viewer actually gets. Code: `src/lib/cleanup.ts`.

## Viewer

The playback page at `/:slug` decides what to serve per request via `resolveForViewer` (`src/routes/videos/resolve.ts`). MP4 serving is table-gated, as described above: the mandatory steps must be `ready`, and the `presentation` step must be validated with the master still on disk. When that passes, the Vidstack `<media-player>` gets a `<source>` list — the master first (`/:slug/raw/1440p.mp4`), then any servable downscaled variants — plus the poster, captions, and chapters tracks when those exist. When it fails, the page falls back to `/:slug/stream/stream.m3u8` (the HLS playlist) — except uploaded videos, which have no HLS and serve the retained `upload.mp4` instead. That upload fallback is the one case where an original is served publicly, and only because there is nothing else. An embed variant at `/:slug/embed` provides a chromeless player for iframe use.

The player gets concrete per-rendition URLs rather than the redirecting `video.mp4`, because it follows them on every load and shouldn't pay for a redirect. Everything we *publish* names `video.mp4` instead — see [File resolution](server-routes-and-api.md#file-resolution).

The check is per-request with no state tracked client-side: a freshly-stopped recording serves HLS for a second or two, then upgrades to MP4 on the next page load. A recording still healing stays on HLS for as long as healing takes and upgrades once derivatives land.

UUIDs never appear in viewer-facing URLs. All media is served under the slug namespace — `/:slug/raw/*` for MP4 renditions, `/:slug/stream/*` for HLS segments, `/:slug/poster.jpg` for the thumbnail. The slug-to-id lookup happens per request (indexed, fast). See [Server Routes & API](server-routes-and-api.md) for the full route reference.

## Corner cases worth knowing about

- **`.orphaned` sidecar.** Only written when the server returns 404 — meaning the video record was deleted upstream (e.g. user cancelled, someone pruned `data/`). Prevents HealAgent from retrying a ghost forever. If a recording *should* be healed and has `.orphaned`, delete the sidecar by hand.
- **Idempotent PUT.** `PUT /api/videos/:id/segments/:filename` overwrites bytes and rebuilds the playlist from the directory listing — so double-uploads, out-of-order arrivals, and late heal uploads all converge to the correct state.
- **Server restart mid-recording.** The video record lives in SQLite so it's already durable — no rehydration step needed. The client's next PUT for that video id succeeds rather than 404ing, and the recording can continue.
- **Empty `missing` from a heal preflight.** Means the server already has everything. The code treats local flags as stale and flips them — otherwise the next startup scan would pointlessly re-trigger a heal that has nothing to do.
- **Init segment.** `init.mp4` is never in `timeline.segments` (the timeline only tracks media segments). The server's diff adds it implicitly — a missing `init.mp4` would break playback silently otherwise.
- **Heal is idempotent.** Running the same heal twice is safe. Every HTTP call the heal makes is designed to be replayable.

## See also

- [Transcription](transcription.md) — how WhisperKit inference, SRT generation, and transcript upload work (the source of the `.transcribed` sidecar and the `TranscribeAgent` referenced above).
