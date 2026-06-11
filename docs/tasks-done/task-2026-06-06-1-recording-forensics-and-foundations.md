# Task 1: Recording forensics & foundations

https://github.com/dannysmith/loom-clone/issues/44

First of four ordered tasks spun out of #44. This one is the foundation: make recording failures **diagnosable after the fact** without changing anything on the recording hot path, plus a couple of low-hanging-fruit cleanups. It deliberately does **not** add live warnings or attempt to fix the underlying CMIO/encoder failures — those are tasks 2 and 3, and both depend on the diagnostics this task lays down.

The framing that drives the whole task: **log capture here is a retrieval problem, not a capture problem.** The app already emits structured unified logs (`OSLog`, subsystem `is.danny.LoomClone`, all `.public` — see `Helpers/Logging.swift`), and macOS already persists them to the unified log store. The errors that actually matter during a bad recording (`-12743` CMIO synchronizer floods) are **Apple's**, from a CoreMediaIO subsystem, not ours. So the job is to *pull the right window of the existing store*, including Apple subsystems.

And the hard constraint, straight from #3: **log volume itself causes the failure we're hunting.** #3's resolution proved that hundreds of CMIO lines/sec create I/O back-pressure on the capture dispatch queues, dropping frames and worsening AV desync. So we must **never** add synchronous disk logging to the recording hot path. All log capture here is **post-stop extraction** from the OS store — zero cost while recording.

**Extraction lives in Swift, in the app binary — not a script on disk.** A shell script in the repo would not exist inside the bundled production `.app`, so shelling out to a repo path would silently no-op in production. Two facts about how this app is built make a clean in-binary approach possible: it is **not sandboxed** (`LoomClone.entitlements` declares only `com.apple.security.device.camera` + `audio-input` — no `app-sandbox` key), and it runs as the user's **admin** account. Under those two conditions, `OSLogStore(scope: .system)` can read the **whole** persisted store in-process, including other processes' and Apple-daemon subsystem entries — the private `com.apple.logging.local-store` entitlement (ungettable by third parties) is **not** required when running as admin. (Sandboxed apps are restricted to `.currentProcessIdentifier`, which only sees our own current launch — that restriction does not apply here.)

## Current state (what already exists)

- **Unified logging.** `Helpers/Logging.swift` — `LoomLogger` wraps `os.Logger`, subsystem `is.danny.LoomClone`, ~22 categories, all messages `.public`. Already retrievable via `log show --predicate 'subsystem == "is.danny.LoomClone"'`.
- **Per-recording local bundle.** `AppEnvironment.recordingsDirectory.appendingPathComponent(session.id)` (`Pipeline/RecordingActor+Prepare.swift:106`) → `~/Library/Application Support/LoomClone[-Debug]/recordings/<id>/`. Already holds `recording.json`, `diagnostics.json`, and the raw masters.
- **Stop-time artifact writes.** `recording.json` is written in the stop flow (`Pipeline/RecordingActor+Stop.swift`); `diagnostics.json` via `writeDiagnosticsDump(sessionID:)` (`Pipeline/RecordingActor+Diagnostics.swift:639`). The new log dump slots in alongside these.
- **Raw-writer error capture (partial).** `RawStreamWriter.captureFailure()` (`Pipeline/RawStreamWriter.swift:210`) snapshots `AVAssetWriter.error` into `WriterFailure { description, code, domain }` (`:319`). PR #35 wired this through to the `raw.writer.failed` timeline event. **Gap:** it reads only the *top-level* `NSError` — which on the 2026-06-03 repro was the generic `-11800 AVErrorUnknown`. The real VideoToolbox/CMIO cause lives in `userInfo[NSUnderlyingErrorKey]`, which we never traverse.
- **Camera format metadata.** `advertisedFormatsForRecordingJson()` (`:329`) and `selectedFormatForRecordingJson()` (`:358`) already capture advertised vs selected format + whether the target rate locked — but only into `recording.json` at stop. Nothing surfaces it **before** recording, in the preview pane, where it would let the user catch a wrong-resolution/wrong-framerate device before committing.
- **Recordings management UI.** `UI/RecordingsSettingsTab.swift` lists past recordings and can reveal `recording.json` — a natural home for a "reveal logs" affordance.

## What this task adds

### Part 1 — Post-stop log extraction (the core)

> **Status (landed):** `Helpers/LogExtractor.swift` (`OSLogStore(scope: .system)`, window from `recording.json`, NDJSON → `os-log.ndjson`, stream + cap + admin fallback), the detached post-stop call in `RecordingActor+Stop.swift`, the "Reveal Logs" / "Re-extract Logs" affordances in `RecordingsSettingsTab.swift`, and `LogExtractorTests` (window parsing). A standalone probe on the dev Mac confirmed `.system` scope opens as admin with no entitlement and that `com.apple.cmio` + `com.apple.coremedia` are live, matched subsystems — so the predicate routing is correct. **Still to confirm against a real `-12743` flood:** that those specific lines are persisted at `error`/`notice` level (not memory-only `debug`), which is the go/no-go for whether post-stop extraction catches them.
>
> **Parts 2, 3, and 4 also landed. Validated and closed out 2026-06-06.** Five test recordings (4 debug/Xcode + 1 detached Release build) confirmed all three parts end-to-end:
> - **Part 1:** `os-log.ndjson` written on every recording with `scope=system`, `cmioCaptured=true`; the CMIO `-12743` lines are captured at **`error` level** (persisted, not memory-only debug) — the open go/no-go is answered YES. Flood counts tracked reality: 4,314 / 11,217 / 22,932 / 28,428 on the ZV-1 recordings vs **0** on the clean FaceTime one.
> - **Part 2:** every ZV-1 `raw.writer.failed` now carries the real underlying `NSOSStatusErrorDomain -16364` instead of the bare generic `-11800` — data #30 had been blocked on for months.
> - **Part 3:** the preview badge showed `1280×720 · 24.4fps` in orange (below the 30 target) and *predicted the meltdown before recording started*.
>
> The tests also produced the actual diagnosis (ZV-1 USB-streaming locked-rate CMIO meltdown causing AV desync in both debug **and** production) — driven to #30 for the task-3 fix.

A small **Swift log-extractor type** plus a **post-stop task** that calls it. No hot-path logging, no on-disk script — it's all in the app binary via the `OSLog` framework's `OSLogStore`.

**Primary approach — `OSLogStore(scope: .system)`.** A new type (e.g. `Helpers/LogExtractor.swift`) that, given a time window, reads the persisted unified-log store in-process and writes the matching slice into the recording bundle. Shape:

1. `let store = try OSLogStore(scope: .system)` — `.system` (not `.currentProcessIdentifier`) is what reaches the Apple CMIO daemon entries; available because the app is non-sandboxed + admin (see header).
2. `let position = store.position(date: recordingStartMinusPad)` — anchor enumeration near the recording window so we don't scan the entire store.
3. Enumerate `store.getEntries(at: position, matching: predicate)`, filter to `OSLogEntryLog`, **stop** once entries pass the recording end (+pad).
4. Predicate selects **both** our subsystem and the Apple media subsystems:
   - `is.danny.LoomClone` (ours — `health`, `camera`, `raw-writer`, `recording`, etc.).
   - The CoreMediaIO / CoreMedia / VideoToolbox subsystems that emit the `-12743` floods + encoder errors. **Confirm the exact subsystem strings at impl time** — candidates `com.apple.cmio`, `com.apple.coremedia`, `com.apple.videotoolbox`. Verify by reproducing a flood (`log stream --predicate ...` in Terminal) so the predicate actually catches the #3/#30 lines (`CMIOSampleBuffer.c`, `CMIO_Unit_Synchronizer_Video.cpp`, `RepeatPreviousFrame ... -12743`). `NSPredicate(format: "subsystem == %@ OR subsystem BEGINSWITH %@ OR ...", ...)`.
5. Serialize each `OSLogEntryLog` (`date`, `subsystem`, `category`, `level`, `process`, `processIdentifier`, `composedMessage`) as NDJSON lines into `cmio-log.ndjson` (or similar) in the recording bundle, next to `recording.json`/`diagnostics.json`.

Implementation constraints / decisions:
- **Window from the recording, not wall clock.** Use `recording.json`'s start/end wall-clock fields (already present), padded a few seconds each side.
- **Do NOT over-constrain on process.** Apple's CMIO logs come from daemons (`cmiodalassistants`/`coremediad`), a *different* process than ours — subsystem is the selector; filtering to our PID would drop exactly the Apple lines we want.
- **Stream + cap (memory discipline).** Even post-stop, a `-12743` flood is tens of thousands of entries — don't build one giant in-memory array (this project has an OOM history). Enumerate lazily, write incrementally, and cap at N entries with a recorded `"truncated at N"` marker rather than an unbounded file.
- **Persistence level caveat.** `OSLogStore` reads the *persisted* store: `error`/`fault`/`notice` are persisted; `debug` and most `info` are memory-only and may be gone by stop. The `-12743` lines read as error-level so should be present — confirm at impl time, and accept that debug-level context is lost (capturing it live would require `log stream` *during* recording, reintroducing the #3 back-pressure we're avoiding).

**Fallback approach (documented, only if needed).** If `.system` enumeration proves too slow/heavy on a busy store, spawn `/usr/bin/log show --start … --end … --predicate … --style ndjson` via `Process` and capture stdout. `/usr/bin/log` is a stable Apple-signed system binary (no repo file, no bundling) and spawning it is permitted (the app isn't sandboxed; hardened runtime doesn't block Apple-signed binaries). Out-of-process, so it doesn't bloat our heap — the trade is parsing text instead of structured entries. Keep this in the back pocket; default to `OSLogStore`.

**The post-stop task.** After `recording.json`/`diagnostics.json` are written in the stop flow (`RecordingActor+Stop.swift`), kick off a **detached, low-priority** task that runs the extractor and writes the dump into the recording bundle. Constraints:
- **Fire-and-forget, off the actor, after stop completes** — must not delay stop, block the clipboard URL, or touch the recording pipeline. Recording is already finished; this is pure post-processing.
- **Graceful degradation if not admin.** `OSLogStore(scope: .system)` requires admin. If it throws (or a future non-admin run), fall back to `.currentProcessIdentifier` to at least capture our own `is.danny.LoomClone` entries, and write a marker noting CMIO capture was skipped. Never throw out of the post-stop path.
- **Debug vs release.** Run in **both** — production failures are exactly when we'll want it (#44 explicitly asks for production log access). The bundle is local-only, never uploaded, so no privacy/transport cost.

**Dev + re-extraction convenience.** Because extraction is a pure function of a time window, expose a way to **re-run it for any past recording on demand** — an action in `UI/RecordingsSettingsTab.swift` (which already lists past recordings). That covers #44's "persistent place for Xcode development logs to stay locally" without a separate tool; the OS store is read retroactively. (For pure ad-hoc dev use, `log show` in Terminal remains available too — but that's a convenience, not something we build.)

**UI affordance (small).** In `UI/RecordingsSettingsTab.swift`, add a "Reveal logs" button next to the existing "Reveal recording.json", plus the "Re-extract logs" action above. Optional but cheap.

### Part 2 — Walk the `NSUnderlyingError` chain (#30 step 0)

> **Status (landed):** `RawStreamWriter.makeFailure(from:)` + `deepestUnderlyingError(_:)` walk the `NSUnderlyingError` / `NSMultipleUnderlyingErrors` chain (hop-bounded); `WriterFailure` gained `underlyingCode`/`underlyingDomain`/`underlyingDescription`; both stop-flow sites (`recordRawWriterFailures`, `checkRawWriterStatus`) and `recordRawWriterFailed` carry the new fields into the `raw.writer.failed` event. Covered by `RawStreamWriterErrorTests`.

In `RawStreamWriter.captureFailure()` (`:210`), the current `WriterFailure` snapshot stops at the top-level `NSError`. Extend it to **recursively walk `userInfo[NSUnderlyingErrorKey]`** (and `userInfo[NSMultipleUnderlyingErrorsKey]` / `underlyingErrors` where present) and record the deepest/most-specific `domain` + `code`, plus `localizedFailureReason`. Surface this in the `raw.writer.failed` timeline event data (additive fields — don't break the existing `code`/`domain`).

This is what turns the useless generic `-11800 AVErrorUnknown` into the actual `-12909`/`-12903`-class VideoToolbox/CMIO code that #30 has been hunting since it was filed. It's a few lines, it's the cheapest possible enabler for task 3, and it belongs in the foundations task.

Mirror the same walk in the stop-time path (`recordRawWriterFailures` in `RecordingActor+Stop.swift:178`) and in `checkRawWriterStatus` so both detection sites carry the enriched error.

### Part 3 — Surface camera metadata in the pre-recording pane

> **Status (landed):** `CameraPreviewManager` now publishes `previewMetadata` (delivered resolution from `device.activeFormat` + advertised max fps + a frame rate measured from delivered buffers over a rolling ~1s window). `MenuView`'s preview shows a subtle "W×H · fps" badge that turns orange when the camera's rate falls below the selected target's `minAcceptableRate` (e.g. a 25fps PAL camera against a 30fps target). Display-only, as scoped — live cadence/health monitoring stays in task 2.

The preview pane shows the camera feed so the user can confirm it looks right before recording. We already capture the *facts* needed to flag a misconfigured device (advertised formats, selected format, actual vs target framerate, did-lock-rate) — but only at stop, in `recording.json`. Surface a condensed version **live in the preview pane**:

- **Actual delivered resolution & framerate** of the live preview feed (read from the `AVCaptureDevice.activeFormat` / sample buffers in `Helpers/CameraPreviewManager.swift`), shown unobtrusively (e.g. "1920×1080 · 30fps").
- **A gentle flag when reported ≠ requested** — e.g. the Cam Link upscale case from #30 (asked 4K, got upscaled 1080p), or a PAL camera delivering 25fps when 30 was requested. This is *information*, not a blocking warning.

Keep this **display-only**. Live *health* monitoring of the preview (detecting a `-12743` stutter in the preview cadence before recording) is **task 2's** job — it shares the cadence-detection logic with the in-recording quality warning, so it lands there, not here. This part is purely "show the user what the device is actually doing."

Honest limitation to document (don't build around it): there is **no clean app-level API to reset a wedged USB/CMIO device.** The realistic recovery options are rebuild-the-`AVCaptureSession` (the preview watchdog in `CameraPreviewManager` already does this) or physically unplug/replug. We surface info and let the user decide; we don't promise a device reset macOS won't grant. Relates to #3.

### Part 4 — Fix the stale developer doc + low-hanging fruit

> **Status (landed):** rewrote the `recording-pipeline.md` "Source failure behaviour" section to describe what's actually built (staleness watchdog + thresholds, capture-error handlers, audio failover, HLS terminal escalation, the warning-pill UI), updated the timeline events list + raw-writer/HLS-health subsections for the underlying-error enrichment, documented the new `os-log.ndjson` artifact, added a preview-metadata note to the Coordinator/UI section, and added `RecordingActor+SourceHealth.swift` + `Helpers/LogExtractor.swift` to the code-location table. Swept `AGENTS.md` / `app/LoomClone/CLAUDE.md` and the other developer docs — no other stale "not handled" claims.

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
| `OSLogStore` extractor (Swift, in-binary) | `Helpers/LogExtractor.swift` (new) |
| Post-stop log dump task | `Pipeline/RecordingActor+Stop.swift` (kick off after artifact writes) |
| `NSUnderlyingError` walk | `Pipeline/RawStreamWriter.swift` (`captureFailure`, `WriterFailure`), `Pipeline/RecordingActor+Stop.swift` (`recordRawWriterFailures`, `checkRawWriterStatus`) |
| Enriched event fields | `Models/RecordingTimeline.swift` / `Models/RecordingTimelineBuilder.swift` (`recordRawWriterFailed`) |
| Live camera metadata in preview | `Helpers/CameraPreviewManager.swift`, the popover preview pane view in `UI/` |
| Logs/reveal affordance | `UI/RecordingsSettingsTab.swift` |
| Doc fixes | `docs/developer/recording-pipeline.md`, `AGENTS.md`, `app/LoomClone/CLAUDE.md` |
