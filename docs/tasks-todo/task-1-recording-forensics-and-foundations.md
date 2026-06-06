# Task 1: Recording forensics & foundations

https://github.com/dannysmith/loom-clone/issues/44

First of four ordered tasks spun out of #44. This one is the foundation: make recording failures **diagnosable after the fact** without changing anything on the recording hot path, plus a couple of low-hanging-fruit cleanups. It deliberately does **not** add live warnings or attempt to fix the underlying CMIO/encoder failures — those are tasks 2 and 3, and both depend on the diagnostics this task lays down.

The framing that drives the whole task: **log capture here is a retrieval problem, not a capture problem.** The app already emits structured unified logs (`OSLog`, subsystem `is.danny.LoomClone`, all `.public` — see `Helpers/Logging.swift`), and macOS already persists them to the unified log store. The errors that actually matter during a bad recording (`-12743` CMIO synchronizer floods) are **Apple's**, from a CoreMediaIO subsystem, not ours. So the job is to *pull the right window of the existing store*, including Apple subsystems — which is a `log show` predicate, not new app logging.

And the hard constraint, straight from #3: **log volume itself causes the failure we're hunting.** #3's resolution proved that hundreds of CMIO lines/sec create I/O back-pressure on the capture dispatch queues, dropping frames and worsening AV desync. So we must **never** add synchronous disk logging to the recording hot path. All log capture here is **post-stop extraction** from the OS store — zero cost while recording.

## Current state (what already exists)

- **Unified logging.** `Helpers/Logging.swift` — `LoomLogger` wraps `os.Logger`, subsystem `is.danny.LoomClone`, ~22 categories, all messages `.public`. Already retrievable via `log show --predicate 'subsystem == "is.danny.LoomClone"'`.
- **Per-recording local bundle.** `AppEnvironment.recordingsDirectory.appendingPathComponent(session.id)` (`Pipeline/RecordingActor+Prepare.swift:106`) → `~/Library/Application Support/LoomClone[-Debug]/recordings/<id>/`. Already holds `recording.json`, `diagnostics.json`, and the raw masters.
- **Stop-time artifact writes.** `recording.json` is written in the stop flow (`Pipeline/RecordingActor+Stop.swift`); `diagnostics.json` via `writeDiagnosticsDump(sessionID:)` (`Pipeline/RecordingActor+Diagnostics.swift:639`). The new log dump slots in alongside these.
- **Raw-writer error capture (partial).** `RawStreamWriter.captureFailure()` (`Pipeline/RawStreamWriter.swift:210`) snapshots `AVAssetWriter.error` into `WriterFailure { description, code, domain }` (`:319`). PR #35 wired this through to the `raw.writer.failed` timeline event. **Gap:** it reads only the *top-level* `NSError` — which on the 2026-06-03 repro was the generic `-11800 AVErrorUnknown`. The real VideoToolbox/CMIO cause lives in `userInfo[NSUnderlyingErrorKey]`, which we never traverse.
- **Camera format metadata.** `advertisedFormatsForRecordingJson()` (`:329`) and `selectedFormatForRecordingJson()` (`:358`) already capture advertised vs selected format + whether the target rate locked — but only into `recording.json` at stop. Nothing surfaces it **before** recording, in the preview pane, where it would let the user catch a wrong-resolution/wrong-framerate device before committing.
- **Recordings management UI.** `UI/RecordingsSettingsTab.swift` lists past recordings and can reveal `recording.json` — a natural home for a "reveal logs" affordance.

## What this task adds

### Part 1 — Post-stop log extraction (the core)

A **script** plus a **post-stop task** that calls it. No hot-path logging.

**The script** (`app/Scripts/` or `scripts/` — match repo convention; the test harness already keeps scripts under `app/TestHarness/Scripts/`). A small shell/zsh wrapper around `log show` that, given a start time, end time, and PID, dumps the relevant slice of the unified log store to a file. It must pull **both** our subsystem and the Apple media subsystems:

- `is.danny.LoomClone` (ours — the `health`, `camera`, `raw-writer`, `recording`, etc. categories).
- The CoreMediaIO / CoreMedia / VideoToolbox subsystems that emit the `-12743` floods and encoder errors. **Confirm the exact subsystem/category strings during implementation** — candidates are `com.apple.cmio`, `com.apple.coremedia`, `com.apple.videotoolbox`. Verify by reproducing a flood and inspecting `log stream --debug --predicate '...'` so the predicate actually catches the lines from #3/#30 (`CMIOSampleBuffer.c`, `CMIO_Unit_Synchronizer_Video.cpp`, `RepeatPreviousFrame ... -12743`).

Predicate shape (illustrative — pin exactly at impl time):

```
log show --start "<ISO>" --end "<ISO>" --style ndjson \
  --predicate 'subsystem == "is.danny.LoomClone" OR subsystem BEGINSWITH "com.apple.cmio" OR subsystem BEGINSWITH "com.apple.coremedia"'
```

Notes / decisions to make at impl time:
- **Time window from the recording, not wall clock.** Use `recording.json`'s start/end wall-clock fields (already present — "start/end wall-clock" in the timeline) padded by a few seconds each side. The script takes them as args.
- **PID filtering is best-effort.** `log show` can filter by process, but the recording PID is the app itself; subsystem filtering is the primary selector. Consider adding `process == "LoomClone"` to scope ours, but Apple's CMIO logs may be emitted from a daemon (`cmiodalassistants`/`coremediad`) under a *different* process — so do **not** over-constrain on process or we'll drop exactly the Apple lines we want. Validate against a real flood.
- **Output format.** `--style ndjson` (or `syslog`) into `cmio-log.ndjson` (or `.log`) in the recording bundle. Keep it greppable.
- **Size guard.** A `-12743` flood can be tens of thousands of lines. That's *fine* on disk post-hoc (it's the whole point), but cap pathological cases — e.g. `--last`/window bounding already limits it; optionally truncate with a recorded "truncated at N lines" marker rather than writing an unbounded file.

**The post-stop task.** After `recording.json`/`diagnostics.json` are written in the stop flow (`RecordingActor+Stop.swift`), kick off a **detached, low-priority** task that shells out to the script (via `Process`) and writes the log dump into the recording bundle. Constraints:
- **Fire-and-forget, off the actor, after stop completes** — it must not delay stop, block the clipboard URL, or touch the recording pipeline. The recording is already finished; this is pure post-processing.
- **Debug vs release.** Decide whether to run it always or only in DEBUG. Leaning: **run in both** but make it cheap — production failures are exactly when we'll want it (#44 explicitly asks for production log access). The bundle is local-only and never uploaded, so there's no privacy/transport cost.
- **Failure-tolerant.** If `log show` isn't available or returns nothing, log a line and move on. Never throw out of the post-stop path.

**Dev convenience.** Also expose the script as a standalone command (a `make` target, e.g. `make logs SESSION=<id>`, or a flag) so we can re-extract logs for any past recording on demand — #44's "persistent place for Xcode development logs to stay locally." This satisfies the dev-log-capture ask **without any app code change at all** — it reads the OS store retroactively.

**UI affordance (small).** In `UI/RecordingsSettingsTab.swift`, add a "Reveal logs" button next to the existing "Reveal recording.json", and/or a "Re-extract logs" action that runs the script for that session. Optional but cheap.

### Part 2 — Walk the `NSUnderlyingError` chain (#30 step 0)

In `RawStreamWriter.captureFailure()` (`:210`), the current `WriterFailure` snapshot stops at the top-level `NSError`. Extend it to **recursively walk `userInfo[NSUnderlyingErrorKey]`** (and `userInfo[NSMultipleUnderlyingErrorsKey]` / `underlyingErrors` where present) and record the deepest/most-specific `domain` + `code`, plus `localizedFailureReason`. Surface this in the `raw.writer.failed` timeline event data (additive fields — don't break the existing `code`/`domain`).

This is what turns the useless generic `-11800 AVErrorUnknown` into the actual `-12909`/`-12903`-class VideoToolbox/CMIO code that #30 has been hunting since it was filed. It's a few lines, it's the cheapest possible enabler for task 3, and it belongs in the foundations task.

Mirror the same walk in the stop-time path (`recordRawWriterFailures` in `RecordingActor+Stop.swift:178`) and in `checkRawWriterStatus` so both detection sites carry the enriched error.

### Part 3 — Surface camera metadata in the pre-recording pane

The preview pane shows the camera feed so the user can confirm it looks right before recording. We already capture the *facts* needed to flag a misconfigured device (advertised formats, selected format, actual vs target framerate, did-lock-rate) — but only at stop, in `recording.json`. Surface a condensed version **live in the preview pane**:

- **Actual delivered resolution & framerate** of the live preview feed (read from the `AVCaptureDevice.activeFormat` / sample buffers in `Helpers/CameraPreviewManager.swift`), shown unobtrusively (e.g. "1920×1080 · 30fps").
- **A gentle flag when reported ≠ requested** — e.g. the Cam Link upscale case from #30 (asked 4K, got upscaled 1080p), or a PAL camera delivering 25fps when 30 was requested. This is *information*, not a blocking warning.

Keep this **display-only**. Live *health* monitoring of the preview (detecting a `-12743` stutter in the preview cadence before recording) is **task 2's** job — it shares the cadence-detection logic with the in-recording quality warning, so it lands there, not here. This part is purely "show the user what the device is actually doing."

Honest limitation to document (don't build around it): there is **no clean app-level API to reset a wedged USB/CMIO device.** The realistic recovery options are rebuild-the-`AVCaptureSession` (the preview watchdog in `CameraPreviewManager` already does this) or physically unplug/replug. We surface info and let the user decide; we don't promise a device reset macOS won't grant. Relates to #3.

### Part 4 — Fix the stale developer doc + low-hanging fruit

- **`docs/developer/recording-pipeline.md` is wrong about source failures.** The "Source failure behaviour" section says source-level failures "are not handled" and points at `docs/tasks-todo/task-2-source-failure-handling.md` as planned — but that work shipped (`docs/tasks-done/task-2026-05-05-2-source-failure-handling.md`) and the code is live in `RecordingActor+SourceHealth.swift` (staleness detection, capture-error handlers, audio failover, HLS-writer terminal escalation, the warning-pill UI). Rewrite the section to describe what actually exists, and document the new log-extraction artifact + the `NSUnderlyingError` enrichment.
- Sweep `AGENTS.md` / `app/LoomClone/CLAUDE.md` for any other stale "not handled" claims about source health.
- Document the new `cmio-log.ndjson` (or chosen name) artifact alongside `recording.json`/`diagnostics.json` in the timeline section of the doc.

## Explicitly out of scope (later tasks)

- **Live in-recording quality warnings** driven by metronome reject/no-source counters → **task 2**.
- **Live preview health/cadence monitoring** → **task 2**.
- **Diagnosing or fixing the H.264-contention / CMIO-corruption root cause** → **task 3** (which consumes this task's enriched errors + extracted logs).
- **Test-recording / warmup validation** → **task 4**.

## Files likely touched

| Concern | File |
|---|---|
| Log-extraction script | `app/Scripts/` (new) or repo-convention scripts dir; `app/Makefile` target |
| Post-stop log dump task | `Pipeline/RecordingActor+Stop.swift` (kick off after artifact writes) |
| `NSUnderlyingError` walk | `Pipeline/RawStreamWriter.swift` (`captureFailure`, `WriterFailure`), `Pipeline/RecordingActor+Stop.swift` (`recordRawWriterFailures`, `checkRawWriterStatus`) |
| Enriched event fields | `Models/RecordingTimeline.swift` / `Models/RecordingTimelineBuilder.swift` (`recordRawWriterFailed`) |
| Live camera metadata in preview | `Helpers/CameraPreviewManager.swift`, the popover preview pane view in `UI/` |
| Logs/reveal affordance | `UI/RecordingsSettingsTab.swift` |
| Doc fixes | `docs/developer/recording-pipeline.md`, `AGENTS.md`, `app/LoomClone/CLAUDE.md` |
