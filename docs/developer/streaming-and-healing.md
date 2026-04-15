# Streaming & Healing

## The big picture

A recording is a series of HLS segment files (`seg_000.m4s`, `seg_001.m4s`, …) plus an `init.mp4` header. The client emits one segment every ~4 seconds while recording, writes it to local disk as a safety net, and uploads it to the server. The server assembles a playlist (`stream.m3u8`) from whatever segments are on disk at any moment, and viewers stream it back.

If a segment fails to upload live — network blip, server restart, app crash — the server ends up with a gap. Stop-time reconciliation and startup healing close those gaps in the background so the user's share URL becomes complete over time without any manual intervention.

Two principles drive the design:

- **Never lose footage.** Every segment is written locally before the upload is attempted. The local copy is the audit trail of what was recorded; the server copy converges towards it.
- **Instant shareability.** The URL goes on the clipboard at stop. If the server is still missing segments at that moment, the video plays back as far as it goes and heals itself in the background — the user is never blocked waiting for uploads to finish.

## File inventory

### Client: `~/Library/Application Support/LoomClone/recordings/<video-id>/`

| File | Written when | Purpose |
|------|--------------|---------|
| `init.mp4` | First segment of a recording | HLS fMP4 header — single codec description for the whole stream |
| `seg_NNN.m4s` | Every ~4s during recording | Composited HLS media segment (what viewers watch) |
| `recording.json` | At stop, again after each heal | Structured timeline — session info, events, per-segment `uploaded` flag. Schema in `Models/RecordingTimeline.swift` |
| `screen.mov` | During recording if a display was selected | Raw screen master, ProRes 422 Proxy. Safety net for future re-composition |
| `camera.mp4` | During recording if a camera was selected | Raw camera master, H.264 native resolution |
| `audio.m4a` | During recording if a mic was selected | Raw mic master, AAC |
| `.orphaned` | When a heal attempt gets a 404 from the server | Sentinel — stops HealAgent from ever retrying this recording again |

### Server: `server/data/<video-id>/`

| File | Written when | Purpose |
|------|--------------|---------|
| `init.mp4`, `seg_NNN.m4s` | On each PUT | Mirror of the client's segments — what viewers stream |
| `video.json` | On every mutation (create, complete, heal) | The video record: `id`, `slug`, `status`, `createdAt`. `status` is one of `"recording"`, `"healing"`, `"complete"` |
| `segments.json` | On each media-segment PUT | Per-filename duration sidecar, used by the playlist builder |
| `stream.m3u8` | After each PUT and after `/complete` | The HLS playlist — rebuilt from the on-disk segment listing, sorted by filename |
| `recording.json` | On `/complete` (and re-`/complete` after heal) | Server-side copy of the client's timeline, authoritative post-upload |
| `derivatives/source.mp4` | Background task after each `complete` transition | Single-file MP4 stitched from the HLS segments with `-c copy` — the "download me" file, and what the viewer prefers over HLS when present |
| `derivatives/thumbnail.jpg` | Same pass as `source.mp4` | Single-frame JPEG (~1280px wide) sampled at `min(1s, duration/2)`. Used as the viewer page poster when present |

## End-to-end flow of a recording

1. **Create.** User hits record. Client POSTs `/api/videos`. Server creates a `video-id` and `slug`, writes an empty `video.json` with `status: "recording"`, returns both.
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

After every transition to `status: "complete"`, the server generates a set of derivative files in `data/<id>/derivatives/`. Today that's `source.mp4` (HLS segments stitched via `ffmpeg -c copy` with `+faststart`) and `thumbnail.jpg` (single frame ~1s in, scaled to 1280px wide). Generation is fire-and-forget from the `/complete` handler so the stop flow is never delayed.

A few properties worth keeping in mind:

- **Disk is truth.** Readiness of a derivative is the presence of its final file. No new fields in `video.json`.
- **Atomic writes.** Each recipe writes `<filename>.tmp` and renames to `<filename>` on success. A crash or ffmpeg failure leaves either a stale-but-complete final file or nothing — never a half-written final.
- **Per-video dedupe.** An in-memory `Map<videoId, Promise<void>>` collapses concurrent generations for the same video, so two back-to-back `/complete` calls mean one ffmpeg run per recipe.
- **Healed recordings regenerate cleanly.** A healing→complete transition re-triggers the whole pipeline; the rename overwrites the previous derivatives atomically.
- **Failures are independent.** If `source.mp4` fails, `thumbnail.jpg` still runs against whatever `source.mp4` exists (or fails quietly). Failures never surface to `/complete` and never invalidate the m3u8.
- **Recipe list is the extension point.** Future variants (`1080p.mp4`, `720p.mp4`, adaptive-bitrate master playlist) append to the recipe array in `server/src/lib/derivatives.ts`. No orchestrator changes, no directory reshuffling.

## Viewer

The playback page at `/v/:slug` checks `data/<id>/derivatives/source.mp4` on each request. If present, the Vidstack `<media-player>` `src` is the MP4 and the `poster` attribute is set to `thumbnail.jpg` when that's also present. If absent, the page falls back to the HLS playlist with no poster.

The check is per-request with no state tracked client-side: a freshly-stopped recording serves HLS for a second or two, then upgrades to MP4 on the next page load. A recording still healing stays on HLS for as long as healing takes and upgrades once derivatives land.

## Corner cases worth knowing about

- **`.orphaned` sidecar.** Only written when the server returns 404 — meaning the video record was deleted upstream (e.g. user cancelled, someone pruned `data/`). Prevents HealAgent from retrying a ghost forever. If a recording *should* be healed and has `.orphaned`, delete the sidecar by hand.
- **Idempotent PUT.** `PUT /api/videos/:id/segments/:filename` overwrites bytes and rebuilds the playlist from the directory listing — so double-uploads, out-of-order arrivals, and late heal uploads all converge to the correct state.
- **Server restart mid-recording.** The video record is persisted to `video.json` at every mutation. On startup, the server scans `data/` and rehydrates its in-memory state. The client's next PUT for that video id will succeed rather than 404ing, and the recording can continue.
- **Empty `missing` from a heal preflight.** Means the server already has everything. The code treats local flags as stale and flips them — otherwise the next startup scan would pointlessly re-trigger a heal that has nothing to do.
- **Init segment.** `init.mp4` is never in `timeline.segments` (the timeline only tracks media segments). The server's diff adds it implicitly — a missing `init.mp4` would break playback silently otherwise.
- **Heal is idempotent.** Running the same heal twice is safe. Every HTTP call the heal makes is designed to be replayable.

## Where the code lives (quick map)

- Live upload queue and `/complete` call: `app/LoomClone/Pipeline/UploadActor.swift`
- Heal work (both entry points + the core loop): `app/LoomClone/Pipeline/HealAgent.swift`
- Timeline schema: `app/LoomClone/Models/RecordingTimeline.swift`
- Segment / complete / delete routes: `server/src/routes/videos.ts`
- Video record persistence: `server/src/lib/store.ts`
- Playlist builder: `server/src/lib/playlist.ts`
- Derivative generation (recipes, promise cache, ffmpeg): `server/src/lib/derivatives.ts`
- Viewer page (MP4-vs-HLS selection): `server/src/routes/playback.ts`
