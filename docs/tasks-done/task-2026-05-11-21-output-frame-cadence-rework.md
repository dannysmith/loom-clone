# Task 21: Output frame cadence rework — fix monotonicity-rejection bugs introduced by 30/60fps PR

## Status — 2026-05-11

Phases 1, 2, 3, 4, and 6 landed in [PR #29](https://github.com/dannysmith/loom-clone/pull/29). Phase 5 (investigate intermittent camera raw writer failure) split out to [issue #30](https://github.com/dannysmith/loom-clone/issues/30) as backlog — the cadence rework itself is done.

Detailed commit-by-commit narrative is in the PR. The plan below is preserved as a record of how the problem was understood and what trade-offs were made.

---

Follow-up to the work in [#25 / b4cbb21](https://github.com/dannysmith/loom-clone/pull/25) which closed [issue #20](https://github.com/dannysmith/loom-clone/issues/20). That PR exposed a class of metronome bugs that was masked at the old hardcoded 30fps and is now causing 30-50% drops in the composited HLS output across **every** mode.

Goal: get the composited output to honestly reflect whatever rate the sources actually deliver (e.g. 30fps if the camera is 30fps, ~22fps if the screen is mostly idle), with monotonic PTS, A/V sync preserved, and no silent frame loss. Do this without adding a separate code path per mode.

## Symptoms

User-visible: choppy composited HLS playback at 30fps target; even worse choppiness at 60fps target when the camera doesn't support 60fps natively. Raw `screen.mov` and (most of the time) `camera.mp4` are fine — the bug is in the composited HLS path.

## What the diagnostics show

Four diagnostic recordings captured with the `RecordingActor+Diagnostics.swift` instrumentation. Files:

- `a7288551-805f-4f62-ad89-7f51a114afa3` — cameraOnly @ 30fps, Opal
- `9c89eb62-0c8e-453d-8103-a7b02a4670b3` — screenOnly @ 30fps
- `1e8ff366-37db-449d-b0e1-a0cf4ef9897b` — screenAndCamera @ 30fps
- `d949568a-7d71-4fe1-b9eb-693abe2f0d46` — cameraOnly @ 60fps, Opal (no 60fps format)

| ID | Mode | Target | Output | Drop rate | Mono rejects | Rejection delta (mode) |
|---|---|---|---|---|---|---|
| a728… | cameraOnly | 30fps | **29.96fps** | 33.6% | 413 | 33-50ms (1× camera frame) |
| 9c89… | screenOnly | 30fps | **14.85fps** | 53.1% | 531 | 0-1ms (same frame re-read) |
| 1e8f… | screenAndCamera | 30fps | **23.9fps** | 37.9% | 458 | 0-1ms (same frame re-read) |
| d949… | cameraOnly | 60fps | **37.7fps** | 41.3% | 771 | 33-50ms + 50-100ms |

The Opal Tadpole advertises only 1080p30 and 720p30 — no 60fps. UI gate `is60fpsAvailable` lets through on display capability, so rec 4 fell back to `.high` preset and the camera ran at native 30fps.

Camera delivery is healthy at 30fps (882/889 frames in 30-35ms bucket in rec 1). Screen delivery varies wildly — in rec 2 (screenOnly) 25 frames had gaps >200ms, some >500ms — ScreenCaptureKit only delivers `.complete` frames on content change.

## Root cause analysis

There are **two distinct monotonicity-rejection patterns** with one shared root cause.

### Bug A — `cameraOnly` peek-with-repeat clock-mixing

`RecordingActor+FrameHandling.swift:182-208` (cameraOnly branch of `compositeForCurrentMode`):

```swift
} else if let last = lastPoppedCameraFrame {
    cameraBuffer = last.pixelBuffer
    sourcePTS = CMClockGetTime(CMClockGetHostTimeClock())  // ← Bug A
} ...
```

When the FIFO is empty, the repeat path stamps the synthetic frame with **host-clock-now** while the next real camera frame's `capturePTS` is from ~30-50ms ago (USB capture lag). The next pop's PTS is then < `lastEmittedVideoPTS` and the monotonicity guard at `RecordingActor+FrameHandling.swift:243` silently drops it. The trace shows this clearly: clusters of peek-with-repeat emits at 3-5ms intervals followed by 1-3 real camera frames being rejected with delta = 33-50ms (one camera frame duration).

PR review on #25 [flagged the original "stale capturePTS on repeats" bug](https://github.com/dannysmith/loom-clone/pull/25#discussion_r3206264214); the fix-commit swapped one PTS-ordering bug for another.

### Bug B — Screen-mode cache-staleness rejection

`RecordingActor+FrameHandling.swift:147-154` (`screenOnly`) and `:154-181` (`screenAndCamera`) both do:

```swift
guard let screen = latestScreenFrame else { return nil }
sourcePTS = screen.capturePTS
```

`latestScreenFrame` is a single-slot cache overwritten by the SCK callback. When the screen content is static, no new frames arrive, the cache `capturePTS` doesn't change, and consecutive metronome ticks read the **identical** `capturePTS`. The monotonicity guard rejects with delta = 0 (the trace confirms: all 531 rejections in rec 2 have delta < 1ms).

`screenAndCamera` mode is also Bug B (not Bug A) because it uses screen's capturePTS as the sourcePTS — see `RecordingActor+FrameHandling.swift:158-164`. The camera FIFO is wasted in this mode (944 evictions out of 952 received in rec 3, because we never pop).

### Shared root cause

The current design feeds **raw source PTS** through a strict-monotonic encoder gate, but the metronome ticks faster than source freshness guarantees a strictly-newer PTS each tick. The peek-with-repeat patch tried to solve "source slower than metronome" by injecting a synthetic host-clock PTS, which created Bug A. Screen modes have never had a peek-with-repeat equivalent so they hit Bug B unmitigated.

Both bugs disappear if we **stop rejecting at the encoder gate** and instead check **at the source-lookup step** whether the source has fresh content for this tick.

## Design principle

The user's stated intent: *"any 30fps or 60fps feed to just work at that (or whatever its actual rate is — eg 22 or 28.something fps), etc."*

Plus the architectural constraint: **all sources are captured concurrently** (raw writers always recording), and **the user can switch composition mode mid-recording** without restarting capture. The "mode" is a composition choice, not a pipeline choice.

So the design has to satisfy:

1. **Output rate tracks actual delivery rate** of the active mode's source. No artificial up-sampling; no host-clock invention.
2. **PTS comes from source capture time** (preserves A/V sync trivially — audio is also stamped with hardware capture PTS).
3. **Output is monotonic.** Always. The encoder requires this.
4. **Mode switching is seamless** — the metronome tick reads from whichever cache the active mode dictates; the output PTS continues to advance across mode boundaries.
5. **No dead-air in HLS segments** — if the source is genuinely static for a long time, emit a *keep-alive* (synthetic-PTS repeat) at low cadence so segment cutting stays well-formed.
6. **`targetFrameRate` becomes a capture hint + encoder hint, not a hard output cadence.** The metronome's tick interval is a *budget*, not a contract.

## Implementation plan

Phased. Each phase ships independently, is verifiable on its own, and builds toward the final state. The work below assumes the diagnostics infrastructure from this round (`RecordingActor+Diagnostics.swift`, the per-tick trace, the `diagnostics.json` writer, the camera format dump) stays in place — see Phase 6 for the cleanup-vs-keep decision.

### Phase 0 — Land PR #28 first

[PR #28](https://github.com/dannysmith/loom-clone/pull/28) is mergeable and orthogonal to this work. Cross-checked the diff (`/tmp/pr28.diff`, 3274 lines): touches the same files we'll modify (`RecordingActor+FrameHandling.swift`, `+Metronome.swift`, `+Prepare.swift`, `CameraCaptureManager.swift`) but **none of the changes touch the composite-and-emit decision logic**. Specifically:

- `Logging.swift` — new logging infrastructure. We'll use `Log.recording`, `Log.camera` etc. in this work instead of `print` to stay consistent.
- `RecordingActor+Metronome.swift` — adds an `if Task.isCancelled { return }` guard right after `await emitMetronomeFrame()`. Stop-flow correctness; orthogonal to our fix.
- `RecordingActor+Prepare.swift` — wraps `writer.startWriting()` in try/catch + records `recordHLSWriterFailed`. Orthogonal.
- `RecordingActor+FrameHandling.swift` — consolidates audio retiming through a `retimedCopy` helper. Audio-only; orthogonal to the video metronome bugs.
- `CameraCaptureManager.swift` — `print` → `Log.camera` swaps. Trivial conflicts with my new format-dump logs but easy to merge.

**Decision: merge #28 first.** Rationale:

- It's ready and reviewed.
- Lands the `Log` infrastructure we should use anyway.
- Picks up the cancellation guard which is independent value.
- Means our diff is smaller and clearer (no print/log thrash).

If #28 conflicts because of the diagnostic instrumentation already on `main`, rebase #28 on top of `main` rather than the other way around — the diagnostics is the smaller PR.

### Phase 1 — Fix Bug B: skip stale-source ticks in screen modes

Add a `lastEmittedSourcePTS: CMTime` instance property on `RecordingActor` (separate from `lastEmittedVideoPTS` which is in encoder PTS space). Initialise to `.invalid` and reset to `.invalid` in `resetPrepareState`.

In `compositeForCurrentMode`:

- `screenOnly`: if `lastEmittedSourcePTS.isValid` AND `latestScreenFrame.capturePTS <= lastEmittedSourcePTS`, return `nil` early (skip tick, no composition work). On successful emit, set `lastEmittedSourcePTS = screen.capturePTS`.
- `screenAndCamera`: same check on `screen.capturePTS` (screen drives the output cadence in this mode, by design).
- `cameraOnly`: handled in Phase 2.

**First-frame edge case**: the `lastEmittedSourcePTS.isValid` guard above means the very first emit of a recording (where `lastEmittedSourcePTS` is `.invalid`) always passes the freshness check. CMTime comparison against `.invalid` is otherwise undefined.

**Pause/resume interaction (critical)**: capture continues running during pause, so `cameraFrameQueue` accumulates frames captured *during* the pause and `latestScreenFrame` is also updated mid-pause. Without coordination, a frame captured at host=14s during a pause that ended at host=15s would pass the freshness check (14 > pre-pause `lastEmittedSourcePTS` of 10) but its encoder PTS — `primingOffset + (14 - start) - pauseAccumulator_new` — lands *behind* `lastEmittedVideoPTS`, triggering the encoder-level monotonicity safety net and producing a false-positive `monotonicity.rejected` event.

Fix: in `resume()` (`RecordingActor.swift:609`), after `pauseAccumulator` has been updated, bump `lastEmittedSourcePTS` forward so any pause-period frames are treated as stale:

```swift
// After updating pauseAccumulator, before startMetronome():
if lastEmittedSourcePTS.isValid {
    lastEmittedSourcePTS = max(lastEmittedSourcePTS, now)
}
```

This is the only place in the codebase that needs to know about the source-time-vs-pause coordination. The same `now` is already computed earlier in `resume()` for the pause-duration calculation — reuse it.

The monotonicity guard at `RecordingActor+FrameHandling.swift:243` becomes a **safety net** (never fires in normal operation). Keep it. After Phase 1 lands, any non-pause-related fire is a real bug — Phase 4 surfaces it via the `monotonicity.rejected` timeline event.

Effect: screen-mode rejections drop to ~0; screenOnly recording rate matches actual screen delivery rate. Pause/resume produces no spurious rejection events.

### Phase 2 — Fix Bug A: remove `cameraOnly` peek-with-repeat

In `compositeForCurrentMode`'s `cameraOnly` branch:

- Remove the **host-clock-PTS fallback** when FIFO is empty (the `else if let last = lastPoppedCameraFrame` branch's PTS computation that uses `CMClockGetTime(CMClockGetHostTimeClock())`).
- When the FIFO is empty, return `nil` (skip the tick).
- After popping a frame, apply the same freshness check as Phase 1: if `lastEmittedSourcePTS.isValid` AND `popped.capturePTS <= lastEmittedSourcePTS`, discard the frame (silently — it's older than something we already emitted) and treat the tick as a skip. If fresh, emit and set `lastEmittedSourcePTS = popped.capturePTS`.

**Keep `lastPoppedCameraFrame` as state.** Continue updating it on every successful pop. It's no longer used for PTS generation, but Phase 3's keep-alive needs it as the content to repeat during static cameraOnly periods (e.g. if the user covers the camera lens). Removing the property would break Phase 3.

**Mode-switch interaction**: when switching INTO cameraOnly from a screen mode, the camera FIFO contains frames captured before the switch with capturePTS values older than the most recent screen emit's. The freshness check correctly discards them one tick at a time, causing a ~100-300ms warm-up before the first fresh camera frame is emitted. This is acceptable — the viewer sees the last screen frame held for those few hundred ms, then the camera takes over.

If the warm-up turns out to be visually objectionable, add a one-liner to `switchMode` that drains the FIFO when transitioning INTO `cameraOnly`. Left as an optional refinement.

This restores pre-PR-#25 cameraOnly behaviour: every camera frame whose PTS is strictly newer than the last emit reaches the output exactly once.

Effect:

- 30fps target + 30fps camera → output ~30fps, near-zero drops.
- 60fps target + 30fps camera → output ~30fps (matches camera delivery, **NOT** 60fps).
- Removes the `cameraOnlyRepeatBranch` counter's reason-to-exist (counter stays in diagnostics for one release in case the path silently re-emerges; can be deleted later).

This intentionally undoes the "upsample to 60fps via repeats" feature from #25. Per design principle 1+6, that feature was the wrong mental model. The user can record at 60fps for the *screen* sections of a mode-switched recording and at 30fps for the *camera* sections, and the output will be VFR — which is fine for HLS playback (see "VFR output" discussion under "Out of scope" below).

`AVVideoExpectedSourceFrameRateKey` stays set to the user-picked target (a hint to VT for rate control). It can be wrong in fact and the encoder copes.

### Phase 3 — Keep-alive emit for long-static sources

Concern: in `screenOnly` with a static screen for >4 seconds, no emits happen during a whole HLS segment window. AVAssetWriter's 4-second auto-segmentation may produce empty or zero-duration segments. Player may freeze playback past the gap.

Mitigation: track `lastEmitHostTime`. In `emitMetronomeFrame`, if no fresh source content **AND** `(now - lastEmitHostTime) > keepAliveThreshold`, emit a synthetic-PTS repeat of the last cached source frame:

- Content: `latestScreenFrame.pixelBuffer` (or `lastPoppedCameraFrame` for cameraOnly, if we still track it).
- **PTS: `host_clock_now - recordingStartTime - pauseAccumulator + primingOffset`** — i.e. wall-clock-anchored, the same formula real frames use, just substituting the current host clock for the source capture time. The keep-alive's PTS tracks wall time so audio and video logical times stay aligned through the static section.
- Does **not** advance `lastEmittedSourcePTS` (so when a fresh frame finally arrives, it's still detected as fresh and emits at its real capturePTS).

Why this is **not** a reintroduction of Bug A: peek-with-repeat (the original Bug A) fired *every empty tick* (~16-33ms cadence), so the host_clock_now PTS values it produced were typically only a few ms ahead of the next-arriving real camera frame's capturePTS — within capture-lag range, so the next real frame got rejected. The Phase 3 keep-alive only fires after a **confirmed long stale period** (`keepAliveThreshold` ≥ 1s). By the time it fires, the source has been silent for at least 1s, so when a fresh source frame eventually arrives, its capturePTS has advanced ~1s past the keep-alive PTS — vastly more than the ~30-50ms capture lag could ever shift things. The next real emit is comfortably monotonic.

**Why not `lastEmittedVideoPTS + frameDuration`** (my original spec): that advances video PTS by *one frame's duration* per keep-alive emit, but keep-alives fire at *one-second wall-clock intervals*. After 10 seconds of static screen we'd emit 10 keep-alives whose PTS values span only ~333ms, while audio PTS advanced 10 seconds — a ~9.67s A/V desync that the next real frame would inherit. Wall-clock-anchored PTS avoids this entirely.

`keepAliveThreshold` candidates: 500ms or 1000ms. Aim is "much less than segment interval so segments never go empty, but much greater than tick interval so we don't continuously emit duplicates." 1000ms feels right.

A/V sync impact: viewer sees a frozen video frame for those static seconds with audio playing normally. Same as YouTube during a static screen. Not a regression.

### Phase 4 — Enrich `recording.json` (additive, no removals)

User explicitly wants useful debugging info preserved in `recording.json` even after this fix lands. Add the following blocks (all optional fields, no removals):

**Under `inputs.camera`** — extend `Inputs.Device` to optionally carry:
- `advertisedFormats: [AdvertisedFormat]` — list of `{ width, height, pixelFormat, minFrameRate, maxFrameRate }`. Trimmed compared to the full diagnostics dump — one entry per (width, height, maxFps) combination, not per format-descriptor.
- `selectedFormat: { width, height, pixelFormat, didLockRate, activeMinFrameDurationSeconds, activeMaxFrameDurationSeconds }`.

This is the cheap and small "what was the hardware actually doing" record. The full per-range detail stays in `diagnostics.json`.

**New top-level `runtime` block** on `RecordingTimeline`:
- `effectiveCameraFps: Double` — `(cameraFramesReceived - 1) / (lastCameraFrameHostTime - firstCameraFrameHostTime)` at stop time.
- `effectiveScreenFps: Double` — same for screen.
- `outputFps: Double` — `segments.totalFrames / durationSeconds`.
- `cameraIntervalP50Ms: Double`, `cameraIntervalP95Ms: Double` — median + 95th percentile of camera frame intervals (flat fields, not nested — easier to grep and chart).
- `screenIntervalP50Ms: Double`, `screenIntervalP95Ms: Double` — same for screen.
- `metronome: { iterations, emitOK, skipsStale, skipsKeepAlive, monoRejects }`.

`monoRejects` should be 0 after Phase 1+2 land. If non-zero in production, it surfaces a regression — see acceptance criteria for caveats.

**New timeline events** worth emitting (cheap, useful for forensics):
- `source.stale` when a source first goes stale post-commit (already exists in `+SourceHealth.swift` — verify still fires correctly).
- `keepalive.emitted` when Phase 3's keep-alive emits — once per static run (don't spam every tick). Carries `staleDurationSeconds`.
- `monotonicity.rejected` if the safety-net guard ever fires (it shouldn't post-Phase-1+2). Carries `deltaMs` (how far backward the rejected PTS was).

**Schema decision: bump `RecordingTimeline.currentSchemaVersion` from 2 to 3.** Adding a new top-level `runtime` block is a structural change, and an explicit bump gives future server-side version-aware code an unambiguous marker. New fields use `encodeIfPresent` so old consumers don't break; server side just stores `recording.json` as-is — see `server/src/lib/store.ts`. No server changes needed at this point.

### Phase 5 — Investigate intermittent camera raw writer failure

**Split out to [#30](https://github.com/dannysmith/loom-clone/issues/30)** so the cadence-rework PR can close cleanly. This phase is investigation-only — kept on the backlog until a clean reproduction is available. The detection infrastructure (`raw.writer.failed` timeline event) is already in place from prior work; the open question is *why* the raw camera writer intermittently fails, with H.264 engine contention against the composited writer being the leading hypothesis. See the issue for the full symptom log, hypotheses, reproduction strategy, and candidate remediations.

### Phase 6 — Diagnostic instrumentation policy

The user's stated preference: **keep diagnostics as a permanent local-only feature**. `diagnostics.json` stays gitignored, is never uploaded to the server, and is useful for any future debugging.

Concrete tidy-up:

1. **Keep**: aggregate counters, histograms, periodic snapshots, per-tick metronome trace (4000-tick ring buffer, ~400KB), camera frame trace (first 300 frames), screen frame trace (first 300), camera format dump, selected format details, the `[diag-summary]` one-line console log at stop, the `diagnostics.json` writer.
2. **Note on trace ring-buffer**: at 60fps a 4000-entry ring fills in ~67 seconds. Recordings longer than ~2 minutes (at 60fps) or ~2.2 minutes (at 30fps) will only retain the most-recent N ticks in the trace. Aggregate counters + histograms cover the whole recording regardless. Worth flagging in the diagnostics.json schema doc so future-readers don't expect to see iteration 0 in a 10-minute recording.
3. **Remove**: the `[diag] peek-with-repeat fire …` verbose log line — peek-with-repeat is gone after Phase 2.
4. **Fix bugs in the diagnostics writer that I noticed during this analysis**:
   - `MetronomeDiagnostics.summaryLine()` computes camera rate as `cameraFramesReceived / cameraTrace.last?.hostT`, but `cameraTrace` is capped at 300 entries — the divisor is the host time of the 300th frame, not the whole recording. Recompute from `(cameraFramesReceived - 1) / actual_recording_duration` at stop time.
   - `recordTickRejection()` in `+FrameHandling.swift:439-464` writes `decision.sourcePTS.seconds` (absolute capturePTS, e.g. 1,760,678s = days-since-boot) for rejection rows, while emit rows correctly write the source-relative-to-start value. Make both relative.
5. **Verify**: `diagnostics.json` is not in any server upload path. Spot-check `RecordingActor.swift` stop flow and `UploadActor` — the file is written locally only.
6. **`LOOMCLONE_DIAGNOSTICS_VERBOSE` env var**: after Phase 2 lands, its only remaining purpose is the safety-net mono-reject log line. Two options:
   - (Lean): remove the env var entirely. The aggregate `monoRejects` counter in `runtime` and the `monotonicity.rejected` timeline event already surface the same info post-stop.
   - (Keep): repurpose it to log other useful events live — keep-alive emits, mode-switch events, queue evictions over a threshold. Useful for live-monitoring during a stubborn-bug investigation.
   Recommend "remove" for the initial cleanup; re-add if/when there's a concrete reason.
7. **Update `docs/developer/recording-pipeline.md`** to mention `diagnostics.json` as a permanent local-only debugging artifact and link to its schema.

## PR #28 cross-check

Already covered in Phase 0. Summary:

- Files PR #28 touches that we'll also touch: `RecordingActor.swift`, `RecordingActor+Metronome.swift`, `RecordingActor+Prepare.swift`, `RecordingActor+FrameHandling.swift`, `CameraCaptureManager.swift`, `RawStreamWriter.swift`.
- Files PR #28 modifies but we won't: everything else (`AppDelegate.swift`, UI files, audio retiming, etc.).
- Hard conflicts expected: only the `print` → `Log.X.log` thrash in `CameraCaptureManager.swift`. Easy.

**Decision: merge PR #28 first**, then start Phase 1 of this work.

## Acceptance criteria

Each criterion is checkable by running the test matrix below with the instrumentation in place and inspecting `diagnostics.json`.

Per-mode at 30fps target:

| Mode | `outputFps` | `monoRejects` | `skipsStale` allowed |
|---|---|---|---|
| cameraOnly | within 1fps of camera native rate | 0 | ≤ 5% of iterations |
| screenOnly | within 2fps of screen delivery rate | 0 | high (screen is bursty); not a regression |
| screenAndCamera | within 2fps of screen delivery rate | 0 | as screenOnly |

At 60fps target:

| Mode | `outputFps` | `monoRejects` |
|---|---|---|
| cameraOnly with Opal (30fps camera) | within 1fps of 30 (matches camera) | 0 |
| cameraOnly with a 60fps-capable camera (if available) | within 2fps of 60 | 0 |
| screenOnly on 60Hz+ display | within 2fps of 60 | 0 |
| screenAndCamera | as screenOnly | 0 |

Plus:

- Mode switch mid-recording: PTS continues monotonically across the switch; one `recording.json` shows two sections at different rates if the sources differ. Mode switch into cameraOnly may show a brief (~100-300ms) warm-up before the first fresh camera frame emits — acceptable.
- Pause/resume: zero `monotonicity.rejected` events fired by the resume sequence (this is what Phase 1's `lastEmittedSourcePTS` bump on resume buys us).
- Long static screen (≥ 4 sec): no empty HLS segments; one `keepalive.emitted` event per static run; viewer-side playback shows a frozen frame with audio continuing.
- A/V sync regression test: lip-sync visually correct in a 30s talking-head recording.
- `monoRejects` is 0 across all four diagnostic recordings re-shot under the new code, **including across at least one pause/resume cycle per recording**. Anything > 0 means a missed case.

## Open questions

1. **Keep-alive threshold**: 500ms vs 1000ms vs configurable? Start at 1000ms; revisit if HLS segment shapes look wrong in testing.
2. **`is60fpsAvailable` UI gating**: currently passes if *display* supports 60Hz, even when camera is 30fps-only. With Phase 2's design ("output matches actual rate"), it's fine to offer 60fps in UI even with a 30fps camera — the user will just get 30fps output in cameraOnly sections. But the bitrate scaling (×1.4) might be wasted. Worth surfacing in the UI ("60fps not available on Opal — camera sections will record at 30fps")? Out of scope for this task.
3. **Camera FIFO capacity**: currently 8 (raised from 4 in #25 for the upsampling case). With Phase 2 we don't need the upsampling, so 4 might suffice. Leave at 8 — extra capacity is harmless and helps bursty USB delivery.
4. **`lastEmittedSourcePTS` across mode switches**: do we maintain a single global one (across all sources) or per-source? Single global is simpler and works correctly because both screen and camera capturePTSes reference the same host clock. Use single global.
5. **Raw camera writer failure (Phase 5)**: should the next attempt at reproducing include a deliberate stress run (1440p screen + 1080p camera + long duration)? Probably worth one targeted test once Phase 1-3 are in.
6. **Schema version of `recording.json`**: bump to 3 with the new optional fields, or leave at 2? Doesn't matter functionally; bump for clarity if server-side ever does version-aware rendering. Leave the decision to implementation time.

## Out of scope

- 60fps-capable cameras: we don't have one on hand; behaviour for a real 60fps camera in cameraOnly mode is correct by construction (Phase 2) but unverifiable until we have hardware.
- Variable-rate encoder hint: `AVVideoExpectedSourceFrameRateKey` stays set to the user-picked target. Not worth dynamically updating mid-recording.
- 4K, 120fps, ProMotion: as decided in #20, all out of scope.
- The pre-existing Opal UVC `1/30 ≠ minFrameDuration` quirk that causes `didLockRate=false`: documented but not fixed. Camera still delivers at native rate; harmless.

## Reference data

Diagnostic recordings (local-only, gitignored):

```
~/Library/Application Support/LoomClone-Debug/recordings/
  a7288551-805f-4f62-ad89-7f51a114afa3/diagnostics.json    # cameraOnly @ 30
  9c89eb62-0c8e-453d-8103-a7b02a4670b3/diagnostics.json    # screenOnly @ 30
  1e8ff366-37db-449d-b0e1-a0cf4ef9897b/diagnostics.json    # screenAndCamera @ 30
  d949568a-7d71-4fe1-b9eb-693abe2f0d46/diagnostics.json    # cameraOnly @ 60
```

Key code references for the implementation:

- `app/LoomClone/Pipeline/RecordingActor+FrameHandling.swift:142-219` — `compositeForCurrentMode`. Where Bug A lives.
- `app/LoomClone/Pipeline/RecordingActor+FrameHandling.swift:243` — the monotonicity guard. Becomes a safety net post-fix.
- `app/LoomClone/Pipeline/RecordingActor.swift` — `lastEmittedVideoPTS` (encoder space) + new `lastEmittedSourcePTS` (capture space).
- `app/LoomClone/Pipeline/RecordingActor+Metronome.swift:61-88` — the metronome loop. No structural change; only the `emitMetronomeFrame` contract changes.
- `app/LoomClone/Models/RecordingTimeline.swift` — extend with new optional fields per Phase 4.
- `app/LoomClone/Pipeline/RecordingActor+Diagnostics.swift` — minor bug fixes per Phase 6.
- `app/LoomClone/Capture/CameraCaptureManager.swift:113-152` — camera format selection. No change here, but the diagnostic format dump is useful — keep.

PR diff for #28: `/tmp/pr28.diff` (was generated during the investigation; regenerate with `gh pr diff 28` if stale).
