# Task: Recording pipeline resilience

Findings from the PiP position feature investigation (2026-04-26). Three issues surfaced during test recordings that are not caused by the PiP changes but warrant attention:

1. **camera.mp4 raw writer failures** — AVAssetWriter enters `.failed` state under multi-encoder resource pressure, leaving the file without a moov atom (unplayable). Seen 3 times across 2 days, out of ~20 recordings. Currently no timeline event or metadata captures this — the only trace is a console `print()`.
2. **Composition stall at stop time** — the metronome's final `CIRenderTask` races against the stop flow and occasionally exceeds the 2s timeout. The recovery path works (rebuild succeeds, recording completes), but it produces a `gpu_wobble` health flag on the server admin page for what is essentially a harmless edge case.
3. **Diagnostic gaps** — several failure modes leave no trace in `recording.json`, making it harder to correlate server-side health flags with client-side events after the fact.

## Evidence

### camera.mp4 failures

| Recording | camera.mp4 | Size | Mode switches | Notes |
|---|---|---|---|---|
| 84b552f2 (today) | BROKEN | 3.6 MB (should be ~96 MB) | 3 | Writer failed early |
| 73896f34 (today) | BROKEN | 95.8 MB | 3 | Writer failed at `finishWriting()` |
| fd08eaed (yesterday) | BROKEN | 10.7 MB | 1 | Documented in AV sync task as "transient writer issue" |
| 28054d61 (today) | OK | 109.9 MB | 2 | Clean — no pip changes, late mode switches |
| 17cc0002 (yesterday) | OK | 27 MB | 1 | Clean |
| 1ee01de8 (yesterday) | OK | 44 MB | 2 | Clean |
| All 5 pure-cameraOnly | OK | 18-34 MB | 0 | All clean |

All failures show "moov atom not found" via ffprobe — the `AVAssetWriter` entered `.failed` state before or during `finishWriting()`, so the moov atom (which MP4 writes last) was never flushed. The AV sync task doc (`docs/tasks-done/task-2026-04-25-1-av-sync-accuracy.md`, "Transient writer issue") already identified this as resource pressure: ProRes 4K screen + two H.264 encodes + multiple AAC encoders saturating the hardware media engine.

The broken recordings tend to be longer (64-72s) and/or have more mode switches, but `fd08eaed` (37s, 1 mode switch) breaks the pattern — it's not strictly correlated with any single factor. The common thread is multi-stream load: all broken recordings had screen + camera + mic active simultaneously.

### Composition stall at stop time

Both stalls in today's recordings occurred within 1ms of `recording.stopped`:

```
84b552f2: stopped at t=64.174760s, composition.failed at t=64.175535s
73896f34: stopped at t=72.100s, composition.failed at t=72.100s
```

The stop flow in `RecordingActor.stopRecording()` sets `isRecording = false` (line 212) before calling `cancelMetronome()` (line 222). The metronome loop checks both `Task.isCancelled` and `isRecording`, but if a `compositeFrame()` call is already in-flight when `isRecording` flips, the CIRenderTask is already submitted to the GPU. The 2s stall timeout fires, the context rebuilds successfully, and the recording completes — but the `compositionStats` get non-zero values, triggering the server's `gpu_wobble` flag.

This is cosmetically noisy but functionally harmless. The fix is to avoid submitting a render task that we know will be thrown away.

### Diagnostic gaps

Currently, when the camera.mp4 raw writer fails:
- A `print()` goes to the Xcode console (lost after the session)
- `recording.json` still populates `rawStreams.camera` with the file metadata — but reports the on-disk byte count of a truncated file with no indication that it's unplayable
- The server has no way to know the raw writer failed
- No timeline event is recorded

Similarly, the `AVAssetWriter.error` that caused the failure is lost — we log its `localizedDescription` but don't capture it in the timeline.

## Phases

### Phase 1: Record raw writer failures in the timeline

When a `RawStreamWriter` enters `.failed` state (detected at `finish()` time, line 213 of `RawStreamWriter.swift`), propagate that status back to the caller so it reaches the timeline.

**Changes:**

1. **`RawStreamWriter.finish()` returns a status.** Currently returns `Void`. Change to return an enum like `FinishResult { case ok, case failed(String) }` (or a simple `Bool` + optional error string). When the writer is in `.failed` state at finish time, return the failure with the error description.

2. **`RecordingActor.stopRecording()` records failures.** After the raw writer finish tasks complete (the join point at line 264), check each writer's result. For any that failed, emit a timeline event:
   ```
   kind: "raw.writer.failed"
   data: { "file": "camera.mp4", "error": "The operation could not be completed" }
   ```

3. **Mark `rawStreams` entries as failed.** Add an optional `failed: Bool` field to `RawStreams.VideoStream` and `RawStreams.AudioStream`. When the writer failed, set `failed = true` so consumers of `recording.json` can distinguish "file exists but is truncated" from "file is valid." The field should be omitted (nil) when the writer succeeded, keeping healthy recordings' JSON unchanged.

4. **Bump `RecordingTimeline.currentSchemaVersion` to 2.** The new `failed` field is additive (old consumers ignore it), but bumping the version signals that the schema has changed.

### Phase 2: Eliminate the stop-time composition stall

The metronome should not submit a render task it knows will be discarded. Two options (not mutually exclusive):

**Option A: Check `isRecording` before compositing.** In `emitMetronomeFrame()`, check `isRecording` at the top and return early if false. The stop flow sets `isRecording = false` before calling `cancelMetronome()`, so any tick that enters after the stop signal will bail immediately. This doesn't help if the tick is already past the check when the stop arrives, but it eliminates the common case where the final tick enters the function after `isRecording` flips but before `Task.isCancelled` propagates.

Currently `emitMetronomeFrame` doesn't check `isRecording` — it relies on the metronome loop's `while !Task.isCancelled, isRecording` guard. But `compositeFrame` is an `await` point, meaning the loop's guard was evaluated before the stop signal, and by the time the compositor returns, the stop has already fired.

**Option B: Skip the stall timeout during the stop flow.** Set a flag (e.g. `isStopping`) before `cancelMetronome()`. In `handleCompositionFailure`, if `isStopping` is true, skip the rebuild and just return — the context is about to be torn down anyway. This avoids the 2s wait, the rebuild, and the `compositionStats` bump.

**Recommendation:** Do both. Option A prevents the unnecessary GPU submission in most cases. Option B ensures that if a render is already in-flight when the stop arrives, we don't wait 2s for it and don't record a misleading composition failure.

**Verification:** After implementing, the two recordings that previously showed `gpu_wobble` (84b552f2, 73896f34) should be reproducible without the flag. Record a 60s+ multi-mode session, stop, verify `compositionStats` is absent from `recording.json`.

### Phase 3: Additional diagnostic improvements

Small additions that would have made this investigation faster.

**3a. Log `AVAssetWriter.error` when appending fails silently.** `RawStreamWriter.append()` (line 170) silently drops samples when `isReadyForMoreMediaData` is false. This is correct (back-pressure), but when the writer has entered `.failed` state, continued appends are pointless and the failure goes unnoticed until `finish()`. Add a check: if `writer?.status == .failed` and we haven't logged it yet, print the error once and stop appending. This gives an earlier signal in the console log for when the failure actually occurred (vs. when `finish()` discovers it).

**3b. Record the raw writer start time in the timeline.** Currently there's no way to know when the raw writers actually started writing vs. when they were configured. Adding a `raw.writer.started` event (or just a timestamp in the `rawStreams` metadata) would help correlate future failures with specific moments in the recording.

**3c. Capture `AVAssetWriter.status` transitions.** The writer can enter `.failed` at any point during recording — not just at `finish()`. Currently we only discover this at finish time. Periodic status checks (e.g., every segment emission) would surface failures earlier. This could be as simple as checking `cameraRawWriter?.writer?.status` in `handleSegment()` and emitting an event if it's `.failed`.

## Context

- **Raw writers are a safety net, not the primary output.** Viewers watch the HLS-derived `source.mp4`. The raw masters exist for manual recovery (FinalCut import) if the composited path fails. A broken `camera.mp4` is unfortunate but not catastrophic — `screen.mov` and `audio.m4a` (from the standalone mic session) survive independently.
- **The composition stall is functionally harmless.** The recording completes successfully, all HLS segments upload, the server generates correct derivatives. The `gpu_wobble` flag is the only visible artifact — it shows on the admin page and could alarm the user unnecessarily.
- **The CMIO -12743 errors are a separate, system-level issue.** They originate in Apple's `UVCAssistant` daemon (USB Video Class driver) when the ZV-1's first MJPEG frames fail to decode after stream start. They don't affect recording quality and can't be fixed in our code. Documented here for reference but not actionable.
