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
| `init.mp4`, `seg_NNN.m4s`   | On each PUT                                      | Mirror of the client's segments — what viewers stream. **Cleaned up 10 days post-complete** (source.mp4 takes over for playback)           |
| `stream.m3u8`               | After each PUT and after `/complete`             | The HLS playlist — rebuilt from the on-disk segment listing. **Cleaned up with segments**                                                 |
| `recording.json`            | On `/complete` (and re-`/complete` after heal)   | Server-side copy of the client's timeline, authoritative post-upload                                                                      |
| `derivatives/source.mp4`    | Background task after each `complete` transition | Single-file MP4 stitched from HLS, then audio-processed (denoise + loudnorm). Video track is `-c copy`; audio is re-encoded AAC 160 kbps |
| `derivatives/thumbnail.jpg` | Same pipeline                                    | Promoted from `thumbnail-candidates/` — the best auto-selected or admin-chosen frame. ~1280px wide JPEG |
| `derivatives/thumbnail-candidates/` | Same pipeline                             | Multiple JPEG frames sampled from the video, scored by luminance variance. Admin can pick or upload custom. **Cleaned up 10 days post-complete** |
| `derivatives/720p.mp4`      | Same pipeline (if source > 720p)                 | Downsampled variant, libx264 CRF 23, audio copied from processed source |
| `derivatives/1080p.mp4`     | Same pipeline (if source > 1080p)                | Downsampled variant, libx264 CRF 20, audio copied from processed source |
| `derivatives/captions.srt`  | On `PUT /api/videos/:id/transcript`              | SRT transcript uploaded by the macOS app's TranscribeAgent after WhisperKit inference |
| `derivatives/storyboard.jpg`| Same pipeline (if duration ≥ 60s)                | Sprite sheet of preview frames for scrubber hover thumbnails |
| `derivatives/storyboard.vtt`| Same pipeline (if duration ≥ 60s)                | WebVTT mapping time ranges to sprite regions (`#xywh=`) for Vidstack |

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
   - Sets `status: "complete"` if nothing is missing, `"healing"` otherwise.
   - Persists the received timeline as server-side `recording.json`.
   - Rebuilds the playlist.
   - If the transition lands on `status: "complete"`, schedules derivative generation (`source.mp4` + `thumbnail.jpg`) as a background task. Fire-and-forget — the response is not delayed. See [Derivatives](#derivatives).
5. **URL on clipboard.** Client receives the URL. The UI copies it to the clipboard ~1 second after stop — the user is done.
6. **Heal (if needed).** If `missing` was non-empty, the client hands off to `HealAgent`. See below.

## Healing

Two entry points into the same core flow.

### Post-stop handoff

As soon as `/complete` returns a non-empty `missing`, `RecordingCoordinator` fires `HealAgent.scheduleHeal(...)` with the video id, local dir, timeline bytes, and the missing list. Fire-and-forget — the user's clipboard already has the URL.

### Startup scan

At app launch, `HealAgent.runStartupScan()` walks `~/Library/Application Support/LoomClone/recordings/`. For each session within the last **3 days** whose `recording.json` has at least one segment with `uploaded: false`, it kicks off a heal. Directories with a `.orphaned` marker are skipped. Recordings older than 3 days are ignored — if it didn't heal by now, it's very unlikely to ever heal cleanly.

### The heal loop

For each video being healed:

1. **Preflight `/complete`.** Re-call the endpoint with the timeline to get the authoritative missing list. (Handles the case where a prior heal attempt already uploaded some segments.)
2. If the server returns 404, write `.orphaned` in the local dir and stop. Forever.
3. If `missing` is empty, flip the local `uploaded` flags to `true` (they were stale) and exit.
4. Otherwise, for each missing filename:
   - Read bytes from the local dir.
   - PUT to the server.
   - On success, patch the local `recording.json` to set `uploaded: true` for that filename.
   - On 404, mark `.orphaned` and stop.
   - On any other failure, log and move on — the recording will be picked up again at next startup.
5. **Final `/complete`.** Re-POST with the updated timeline so the server's `recording.json` mirrors the healed local state. Server transitions `status: "healing"` → `"complete"` when there's nothing missing.

## Derivatives

After every transition to `status: "complete"`, the server runs a post-processing pipeline that generates derivative files in `data/<id>/derivatives/`. Generation is fire-and-forget from the `/complete` handler so the stop flow is never delayed.

The pipeline runs these steps in order:

1. **Stitch** — HLS segments → `source.mp4` via `ffmpeg -c copy` with `+faststart`.
2. **Audio processing** — Denoise + loudness normalisation on `source.mp4` in-place (skipped if no audio track). See [Audio Post-Processing](audio-post-processing.md).
3. **Thumbnail candidates** — Multiple frames extracted, scored by luminance variance, best one promoted to `thumbnail.jpg`. Admin can override via the thumbnail picker.
4. **Metadata extraction** — ffprobe on `source.mp4` for dimensions/file size, `recording.json` for camera/mic names and recording health. Written to the `videos` DB row.
5. **Video variants** — Downsampled 720p/1080p MP4s generated if source height warrants it.
6. **Storyboard** — Sprite sheet + WebVTT for scrubber hover previews (skipped for videos under 60s).

Each step is fault-tolerant — a failure is logged and the pipeline continues with the remaining steps.

Properties worth keeping in mind:

- **Disk is truth.** Readiness of a derivative is the presence of its final file (except metadata, which writes to the DB).
- **Atomic writes.** Recipes and post-recipe steps write to `.tmp` and rename on success. A crash or ffmpeg failure leaves either a stale-but-complete final file or nothing — never a half-written output.
- **Per-video dedupe.** An in-memory `Map<videoId, Promise<void>>` collapses concurrent generations for the same video, so two back-to-back `/complete` calls mean one pipeline run.
- **Healed recordings regenerate cleanly.** A healing→complete transition re-triggers the whole pipeline; the rename overwrites previous derivatives atomically.
- **Failures are independent.** If audio processing fails, thumbnails and variants still run. Failures never surface to `/complete` and never invalidate the m3u8.
- **Stale file cleanup.** A daily timer removes HLS segments (`init.mp4`, `seg_*.m4s`, `stream.m3u8`) and `thumbnail-candidates/` from videos that have been complete for >10 days and have a valid `source.mp4`. This is safe because the viewer only falls back to HLS when `source.mp4` is absent. Code: `src/lib/cleanup.ts`.

## Viewer

The playback page at `/:slug` checks `data/<id>/derivatives/source.mp4` on each request. If present, the Vidstack `<media-player>` `src` points to `/:slug/raw/source.mp4` and the `poster` attribute is set to `/:slug/poster.jpg` when the thumbnail also exists. If absent, the page falls back to `/:slug/stream/stream.m3u8` (the HLS playlist) with no poster. An embed variant at `/:slug/embed` provides a chromeless player for iframe use.

The check is per-request with no state tracked client-side: a freshly-stopped recording serves HLS for a second or two, then upgrades to MP4 on the next page load. A recording still healing stays on HLS for as long as healing takes and upgrades once derivatives land.

UUIDs never appear in viewer-facing URLs. All media is served under the slug namespace — `/:slug/raw/*` for MP4 derivatives, `/:slug/stream/*` for HLS segments, `/:slug/poster.jpg` for the thumbnail. The slug-to-id lookup happens per request (indexed, fast). See [Server Routes & API](server-routes-and-api.md) for the full route reference.

## Corner cases worth knowing about

- **`.orphaned` sidecar.** Only written when the server returns 404 — meaning the video record was deleted upstream (e.g. user cancelled, someone pruned `data/`). Prevents HealAgent from retrying a ghost forever. If a recording *should* be healed and has `.orphaned`, delete the sidecar by hand.
- **Idempotent PUT.** `PUT /api/videos/:id/segments/:filename` overwrites bytes and rebuilds the playlist from the directory listing — so double-uploads, out-of-order arrivals, and late heal uploads all converge to the correct state.
- **Server restart mid-recording.** The video record lives in SQLite so it's already durable — no rehydration step needed. The client's next PUT for that video id succeeds rather than 404ing, and the recording can continue.
- **Empty `missing` from a heal preflight.** Means the server already has everything. The code treats local flags as stale and flips them — otherwise the next startup scan would pointlessly re-trigger a heal that has nothing to do.
- **Init segment.** `init.mp4` is never in `timeline.segments` (the timeline only tracks media segments). The server's diff adds it implicitly — a missing `init.mp4` would break playback silently otherwise.
- **Heal is idempotent.** Running the same heal twice is safe. Every HTTP call the heal makes is designed to be replayable.

## Where the code lives (quick map)

- Live upload queue and `/complete` call: `app/LoomClone/Pipeline/UploadActor.swift`
- Heal work (both entry points + the core loop): `app/LoomClone/Pipeline/HealAgent.swift`
- Transcription (WhisperKit inference, SRT gen, upload): `app/LoomClone/Pipeline/TranscribeAgent.swift` — see [Transcription](transcription.md)
- Transcription model status (observable, gates all transcription): `app/LoomClone/Helpers/TranscriptionModelStatus.swift`
- Timeline schema: `app/LoomClone/Models/RecordingTimeline.swift`
- Segment / complete / delete / transcript routes: `server/src/routes/api/videos.ts`
- Video record persistence (DB-backed): `server/src/lib/store.ts`, schema in `server/src/db/schema.ts`
- SRT parsing: `server/src/lib/srt.ts`
- Playlist builder: `server/src/lib/playlist.ts`
- Derivative generation (recipes, promise cache, ffmpeg): `server/src/lib/derivatives.ts`
- Viewer page (MP4-vs-HLS selection, captions): `server/src/routes/videos/page.tsx`
- Media serving (raw, stream, poster, captions): `server/src/routes/videos/media.ts`
- URL builders: `server/src/lib/url.ts`
