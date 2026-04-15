# Task 1 — Upload Resilience & Reconciliation

Make the recording → upload → playback pipeline resilient to temporary network drops and server restarts, and ensure no emitted HLS segment is ever silently lost. Split into three phases, each independently shippable, layered from foundational server hygiene up to live in-recording resilience.

**Phase 1** makes the server's segment handling idempotent and filesystem-driven, and adds a cheap on-disk persistence layer that survives restarts. This is the foundation — it decouples playlist correctness from request ordering and means re-uploading a segment is always safe.

**Phase 2** adds a stop-time reconciliation handshake: on `/complete`, the server diffs the client's segment manifest against what's on disk, the client re-uploads anything missing, and healing happens silently in the background so the shareable URL is available immediately.

**Phase 3** replaces the current 3-retry / ~6s-total retry policy with reachability-gated exponential backoff that rides out routine network blips without losing segments. After this lands, Phase 2's reconciliation should rarely have work to do.

---

## Context

Today's failure modes (traced in `app/LoomClone/Pipeline/UploadActor.swift` and `server/src/routes/videos.ts`):

- **`UploadActor.uploadSegment`** gives up after 3 attempts with linear backoff (1s, 2s, 3s). Total tolerated outage: ~6 seconds. A 10-second Wi-Fi blip silently drops a segment permanently. The `onUploadResult` callback fires `success=false`, `recording.json` records `uploaded: false`, and nothing ever retries.
- **`videos.ts` PUT handler** appends to `video.segments` in request-arrival order (`store.ts:46-54`). `buildPlaylist` iterates that array. So a missed middle segment produces a permanently gapped playlist — even though the client's later segments arrive fine.
- **`store.ts`** keeps all state in an in-memory `Map`. A server restart mid-recording destroys the video record; the next PUT 404s and the rest of the recording falls on the floor.
- **Local disk is already ground truth.** Every segment is written to `~/Library/Application Support/LoomClone/recordings/<id>/` in `RecordingActor.handleSegment` (line 1081), alongside the raw masters (`screen.mov`, `camera.mp4`, `audio.m4a`) and a `recording.json` that enumerates the expected segments with per-segment `uploaded` flags. Recovery material exists; we just don't use it.

The architectural goal is: **the HLS on the server should converge on the HLS that was emitted on the client, even across drops and restarts, without ever blocking the user's "stop → URL on clipboard" flow.**

---

## Phase 1 — Server hygiene: idempotent PUTs, filesystem-driven playlist, cheap persistence

### Goal

Make the server safe to re-upload into and resilient to restarts, without changing client behaviour. Foundation for everything else.

### Why this matters

Every higher-layer strategy — reconciliation, silent healing, retry-forever — assumes that re-uploading a segment is a no-op when the server already has it, and that segments arriving out of order still produce a correct playlist. Today neither is true. Fixing this layer is small but unlocks everything else.

### Behaviour after this lands

- `PUT /api/videos/:id/segments/:filename` is idempotent: the same filename twice produces the same final state (latest bytes overwrite, single entry in the playlist, 200 response either way).
- The playlist is built by sorting segments by filename (`seg_000.m4s`, `seg_001.m4s`, …) rather than by arrival order. Out-of-order arrivals, duplicates, and late re-uploads all produce the correct playlist.
- The server persists video records to a JSON file per video (e.g. `data/<id>/video.json`) at every mutation. On startup, the server scans `data/` and rehydrates the in-memory `videos` Map from those files. A server restart mid-recording no longer loses the video record.
- The persistence layer is shaped like a row-per-video table: one "record" per file, mutations rewrite the whole file (cheap at this scale). Migrating to SQLite later is a like-for-like swap behind the same `store` functions.

### Implementation outline

**`server/src/lib/store.ts`**

- Keep `VideoRecord` and the `videos` Map as the live state.
- Add a tiny persistence helper: `persistVideo(record)` writes `data/<id>/video.json` with the record's fields (no segments — segments come from the filesystem now; see below). `loadAllVideos()` scans `data/*/video.json` at startup and populates the Map + slug index.
- `addSegment` still exists, but its role shrinks — see below.
- Every mutation (`createVideo`, `completeVideo`, `deleteVideo`, slug changes) awaits `persistVideo` before returning.

**Segment list: filesystem as source of truth**

- Drop the append-order `segments: SegmentRecord[]` array from the persisted record. Instead, build the list on demand from the contents of `data/<id>/*.m4s` sorted by filename.
- Durations still need to come from somewhere — the client sends `x-segment-duration` on every PUT. Store durations in a small sidecar: `data/<id>/segments.json` keyed by filename (e.g. `{"seg_000.m4s": 3.95, "seg_001.m4s": 3.998}`). Updated atomically on each PUT; rebuilt from headers on conflict.
- `buildPlaylist` reads the sidecar + directory listing, sorts by filename, emits the m3u8.

**`server/src/routes/videos.ts`**

- `PUT /api/videos/:id/segments/:filename` writes the file, updates the duration sidecar, and rebuilds the playlist. No in-memory array manipulation. Idempotent by construction (writing the same filename twice overwrites cleanly).
- `POST /api/videos/:id/complete` is unchanged in its external contract but now reads segments from the filesystem when building the final playlist. Timeline JSON still persists to `recording.json` as today.
- `DELETE /api/videos/:id` continues to remove `data/<id>/` and drop the record.

**Server startup**

- In `server/src/index.ts`, call `loadAllVideos()` before serving traffic. Log the count restored.

### Why this shape (not SQLite yet)

The durable-store contract looks identical to what SQLite will give us later: one record per video, primary-key lookups, persistence on every mutation. When we swap in SQLite + Drizzle as part of `task-x2-proper-server-api.md`, the change is scoped to the inside of `store.ts`; routes and higher layers don't care. The JSON-on-disk stopgap buys durability now without locking in a schema we'll rewrite.

### Validation

- **Happy path**: a normal recording produces the same playlist and the same on-disk layout as before.
- **Out-of-order PUT**: manually PUT `seg_002.m4s` before `seg_001.m4s` via curl; confirm the playlist built after both arrive lists them in the right order.
- **Duplicate PUT**: PUT the same segment twice; confirm one entry in the playlist, no errors.
- **Server restart mid-recording**: start a recording, kill the server after 2–3 segments have uploaded, restart, let the recording continue (with Phase 3 this will heal automatically; for Phase 1 validation it's fine if the client gives up — we just want the server to have the earlier segments after restart and be able to accept a new PUT for the same video ID without 404ing).

### Exit criteria

- [ ] `PUT /api/videos/:id/segments/:filename` is idempotent — same filename twice leaves the server in the same state as once, response 200 both times
- [ ] Playlist is built by sorting segment filenames, not by arrival order
- [ ] Out-of-order segment PUTs produce a correctly-ordered playlist
- [ ] `data/<id>/video.json` exists for every video and is written on every mutation
- [ ] Server startup scans `data/` and rehydrates in-memory state
- [ ] Server restart mid-recording does not 404 on subsequent PUTs for that video
- [ ] `store.ts`'s external API (`createVideo`, `getVideo`, `getVideoBySlug`, `completeVideo`, `deleteVideo`) is unchanged in shape so the SQLite migration in task-x2 is a drop-in replacement
- [ ] Existing happy-path recording produces an indistinguishable playlist and on-disk layout to pre-change baseline

---

## Phase 2 — Stop-time reconciliation with background healing

### Goal

On `/complete`, diff the client's expected segment list against what the server has. If anything's missing, the client re-uploads from its local recordings directory in the background. The shareable URL returns immediately — the video heals silently without blocking the user.

### Why this matters

Phase 1 makes re-uploading safe. Phase 2 actually uses that safety to close the gap between "what the client emitted" and "what the server has." Combined with the user's core principle of **instant shareability**, we resolve the tension by shipping a URL that works as far as it goes, and fixing it up in the background.

### Behaviour after this lands

- `POST /api/videos/:id/complete` body includes the client's full segment manifest (already present — it's inside the timeline JSON). Server diffs against the filesystem and responds with both the working URL *and* a list of missing segments (possibly empty).
- If the missing list is non-empty, the client kicks off a background upload task that re-reads the missing segments from the local recording dir and PUTs them. When all are confirmed, it calls `/complete` once more to trigger a final playlist rebuild and mark the video fully-healed. This all happens after `stopRecording` returns and the URL is on the user's clipboard.
- Segments in `recording.json` get their `uploaded: true` flag updated as the background uploads succeed. The local file becomes the audit trail of actual delivery.
- The server's playlist is rebuilt after every PUT (already true from Phase 1), so viewers see the video get more complete over time with no manual intervention.
- If the background healing fails permanently (e.g. app quit mid-heal), the next launch inspects `recording.json` for any videos with `uploaded: false` segments and resumes healing. (Pragmatic boundary: we do this for the last N recordings or the last 24 hours, not for the whole history.)

### Implementation outline

**Server: `POST /api/videos/:id/complete`**

- Parse timeline from the body as today.
- Extract the expected segment filename list from `timeline.segments[*].filename`.
- Diff against `data/<id>/*.m4s`.
- Response shape: `{ url, slug, missing: ["seg_004.m4s", ...] }`. Empty `missing` means fully healed.
- Marking `status: "complete"` in `video.json` happens only when `missing` is empty. While healing is in progress the record sits at `status: "healing"` (or similar). Viewers can still play the video — the playlist is always rebuilt from what's on disk — but admin UI can show the healing state.
- `POST /complete` is idempotent. Calling it again re-diffs and responds with whatever's still missing. Final call with nothing missing transitions `healing` → `complete`.

**Client: `UploadActor.complete`**

- Existing call returns the URL as today. The user sees no change in timing.
- Parse `missing` from the response. If non-empty, spawn a detached `Task` that:
  1. Reads each missing segment from `localSavePath`.
  2. Enqueues them via the existing `enqueue` path (or a dedicated heal path — see below).
  3. On each success, updates the `recording.json`'s segment `uploaded` flag and rewrites the file.
  4. After all missing segments succeed, re-POSTs `/complete` with the same timeline to trigger final playlist rebuild.
- The heal task logs progress but does not surface errors to the user unless the whole recording ends up unhealable (e.g. all local segments gone). Silent by design.

**Client: `RecordingActor` startup-time heal**

- On app launch, `RecordingCoordinator` (or a new `HealAgent` actor) scans `~/Library/Application Support/LoomClone/recordings/` for `recording.json` files where at least one segment has `uploaded: false` AND the recording ended within the last 3 days.
- For each, re-run the heal flow: call `/complete` to get the `missing` list, upload what's needed, re-complete. Silent unless the server 404s (record gone) in which case mark the local recording as "orphaned" and move on.

**Client: dedicated heal path vs. reusing `UploadActor`**

- Reusing `UploadActor.enqueue` is the cheaper option — the existing upload queue and Phase 3's new retry policy apply automatically. The only subtle thing is that heal-time uploads read `Data` from disk rather than from memory, so the enqueue path needs to accept either a `Data` payload or a file URL. The simplest change is to make `VideoSegment.data` a lazy load: store a `URL` and load on upload attempt, dropping the in-memory retention for queued-forever segments.
- A dedicated heal path exists mainly if we want healing to be lower-priority than live uploads. Not needed for v1.

### Validation

- **Clean recording**: a recording with no network drops completes with `missing: []` on the first `/complete`; heal task is never spawned.
- **Induced mid-recording drop**: temporarily drop network for ~20 seconds mid-recording (more than Phase 3's retry ceiling). Some segments should fail to upload live. On stop: URL returns immediately; heal task runs in the background and completes the video within a minute or so of network recovery. Viewer loading the URL during healing sees a partial playlist that grows over time.
- **App quit during heal**: start a recording, induce drop, stop, then quit the app before healing completes. Re-launch; heal resumes from `recording.json`. Video ends up healed.
- **Orphaned local record**: start a recording, stop, manually delete the server-side video, then re-launch the client. The startup heal should log "orphaned" and move on without retrying endlessly.

### Exit criteria

- [ ] `POST /complete` returns `{ url, slug, missing }` with the URL always usable
- [ ] Server persists `status: "healing"` for partial videos; transitions to `"complete"` only when `missing` is empty
- [ ] Client re-reads missing segments from the local recordings dir and uploads them in a detached background task
- [ ] `recording.json` `uploaded` flags are updated as heal-time uploads succeed
- [ ] On app launch, unhealed recordings within the last 7 days are resumed automatically
- [ ] Final re-POST of `/complete` triggers the final playlist rebuild and status transition
- [ ] No user-visible delay between "stop" and "URL on clipboard" — healing is fully background
- [ ] Orphaned local records (server 404) are detected once and not retried forever

---

## Phase 3 — In-recording resilience: reachability-gated retry, unbounded patience

### Goal

While a recording is live, never give up on a segment. Ride out routine connectivity blips invisibly so Phase 2's reconciliation rarely has work to do.

### Why this matters

A 10-second Wi-Fi drop should be completely invisible to the user and to the viewer — the segments upload a few seconds late and the live playlist catches up. Today that same drop loses segments permanently. Phase 2 will catch them at stop-time, but the better outcome is that there's nothing to catch.

### Behaviour after this lands

- Upload retry uses exponential backoff with a ceiling (suggested: 1s, 2s, 4s, 8s, 16s, 30s, 30s, …) and no hard retry cap while the recording is active or healing.
- A `NWPathMonitor` gate pauses upload attempts entirely while the network is `.unsatisfied`. When connectivity returns the queue drains immediately (no backoff countdown to wait through).
- Segments queue without holding their `Data` payload in memory indefinitely. Queued segments reference the local file and load bytes on each upload attempt. Memory doesn't grow unboundedly during a long outage.
- A "connection status" signal is exposed from `UploadActor` to `RecordingCoordinator` so the menu bar UI can optionally show an "offline — will catch up" indicator. Non-blocking; purely informational.
- When `stopRecording` is called while the queue is non-empty, the existing `drainQueue()` behaviour still applies — it waits for every segment to either succeed or be deferred to the heal path. The stop flow does not block indefinitely on an offline network: after a reasonable grace period (suggested: 10s), unsent segments are marked for Phase 2 reconciliation and `/complete` is called.

### Implementation outline

**`UploadActor.uploadSegment`**

- Replace the `attempt < 3` cap with exponential backoff and no cap while the recording is active.
- The retry loop reads the current reachability state; while offline, sleep until the reachability callback fires `.satisfied` rather than running a backoff timer.
- On each attempt, re-read the segment bytes from local disk (see below) rather than holding them in memory across retries.

**Reachability gate**

- New `ReachabilityMonitor` helper wrapping `NWPathMonitor`. Exposes an async sequence of path states.
- `UploadActor` observes this and uses a semaphore / async condition to pause/resume uploads. Pausing affects only *new* attempts; an in-flight request is allowed to fail naturally.

**Lazy segment bytes**

- Change `VideoSegment` so the queued struct references a `URL` or a closure that loads data on demand. The in-memory `Data` is retained only for the first upload attempt and released if it fails.
- `handleSegment` in `RecordingActor` writes to local disk first, then enqueues a reference to that file.

**Stop-flow grace period**

- `drainQueue()` gains an optional timeout (e.g. 10s) used only from the stop-flow path. Segments not uploaded within that window are left queued for Phase 2 to reconcile.
- The stop flow calls `/complete` regardless. Phase 2 handles the gap.

### Validation

- **Short drop (5–10s)**: trigger offline for 5–10 seconds mid-recording via Network Link Conditioner or `ifconfig en0 down`. Recording continues. No segments lost. `recording.json` shows all segments `uploaded: true`. No heal task runs.
- **Long drop (2 minutes)**: trigger offline for 2 minutes. Recording continues. On stop: `drainQueue` waits briefly, then `/complete` is called. Most segments already uploaded; any that weren't are picked up by Phase 2.
- **Long drop with stop during offline**: trigger offline, stop the recording while still offline, then restore network 30 seconds later. URL is on the clipboard immediately. Heal runs silently when network returns. Video becomes whole.
- **Memory under long drop**: verify that a 5-minute offline stretch during recording does not balloon app memory (segment `Data` should be released between attempts, not accumulated).

### Exit criteria

- [ ] `UploadActor` retries with exponential backoff up to a 30s ceiling, no hard retry cap during active recording or heal
- [ ] `NWPathMonitor` gates upload attempts; offline periods don't burn retries
- [ ] Queued segments reference local files rather than holding `Data` in memory across retries
- [ ] `drainQueue` supports an optional grace timeout used by the stop flow
- [ ] Stop flow never blocks on offline network — URL appears on clipboard immediately even if uploads are pending
- [ ] Short-drop scenario (<= 30s) heals entirely via live retry with no work for Phase 2
- [ ] Long-drop scenario completes cleanly via stop-flow + Phase 2 reconciliation
- [ ] Memory stays flat during extended offline periods

---

## Sequencing

1. **Read the context** files listed in the briefing below.
2. **Implement Phase 1** and validate against its exit criteria. This is pure server work and should not change client behaviour at all.
3. **Commit Phase 1.**
4. **Implement Phase 2.** New `/complete` response shape and client heal task. Requires Phase 1's idempotent PUT to be in place.
5. **Commit Phase 2.**
6. **Implement Phase 3.** Replaces the retry policy and adds reachability. Requires Phase 2 to be in place so that stop-time grace handoff has a receiver.
7. **Commit Phase 3.**
8. **Update** `docs/tasks-todo/task-0-scratchpad.md` if any related items exist there.

Each phase must leave the app and server in a shippable state so we can pause between phases if priorities change.

## Follow-ups not in this task

- **Proper SQLite + Drizzle migration.** Handled by `task-x2-proper-server-api.md`. Phase 1's `store.ts` contract is shaped so that migration is a swap of the persistence backend, not a reshape of the call sites.
- **Raw-file fallback upload.** If many segments are missing and the heal path can't close the gap (e.g. local HLS files were deleted), the client could upload the raw masters (`screen.mov` / `camera.mp4` / `audio.m4a`) and have the server re-composite. Genuinely the "ultimate never-lose-footage guarantee" — but deliberately out of scope here; the layered approach in this task should make that path unreachable in practice.
- **Server-side authentication and session handshake.** The reconciliation endpoint currently trusts the client. Auth is part of task-x2.
- **Viewer UX for healing-in-progress videos.** A playlist that grows as heal progresses works today, but there's no visual signal to a viewer that the video is still healing. Could be a future polish item, probably not worth building until we have evidence that anyone notices.
- **Telemetry on heal frequency.** Once Phase 3 is in, it would be interesting to know how often the heal path actually fires. A simple counter in `recording.json` (`healSegmentsUploaded`, `droppedDuringRecording`) would do. Low priority.

## Briefing for the implementing session

If running this task with a subagent, the briefing should include:

1. **Read these files in this order:**
   - `docs/requirements.md` (full — especially the "Never Lose Footage" and "Instant Shareability" principles, which this task is the concrete realisation of)
   - `docs/tasks-todo/task-1-upload-resilience-and-reconciliation.md` (this doc, in full)
   - `server/src/routes/videos.ts` and `server/src/lib/store.ts` (the files Phase 1 rewrites)
   - `server/src/lib/playlist.ts` (playlist builder — Phase 1 changes how it's called)
   - `app/LoomClone/Pipeline/UploadActor.swift` (rewritten in Phase 3, extended in Phase 2)
   - `app/LoomClone/Pipeline/RecordingActor.swift` — in particular `handleSegment` (line ~1064) and the stop flow (`stopRecording`, line ~520) — Phase 2 adds the heal-task spawn after `/complete`
   - `app/LoomClone/Models/` (the `VideoSegment` and timeline types that Phase 3 modifies to reference local file URLs)
   - A sample `recording.json` from `~/Library/Application Support/LoomClone/recordings/` to internalise the current shape

2. **Do Phase 1 first, end-to-end, commit, validate.** Don't interleave phases — each builds on the previous being solid.

3. **Validation preference: real app, not the harness.** Consistent with task-5's finding that the harness's synthetic capture doesn't reliably reproduce main-app behaviour. Use Network Link Conditioner or `ifconfig en0 down` for inducing drops; use `kill -9` on the server process for restart tests.
