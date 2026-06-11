# Task 2: Live quality-degradation warning

https://github.com/dannysmith/loom-clone/issues/44

> **Status: ✅ Completed 2026-06-09.** Both parts shipped on the `recording-reliability` branch and validated against three live ZV-1 recordings (two native-USB meltdowns + one clean HDMI→Cam Link baseline). See "Outcome" at the bottom for what was built, the one design refinement the real data forced, and the validation evidence.

Second of four tasks from #44. Depends on **task 1** (forensics & foundations) having landed — task 1's extracted CMIO logs + the labelled 2026-06-06 recording set are what let us *confirm* what a degraded recording actually looks like in the data, rather than guessing.

The core insight (see the #44 investigation comment): the existing source-health system catches the **clean** failures — a source going fully silent (`RecordingActor+SourceHealth.swift`: screen 2s / camera 1s / audio 2s staleness thresholds, plus capture-error and interruption handlers). But the failure that actually ruins recordings — the CMIO synchronizer meltdown from #30 — is **not** silence. The camera keeps delivering frames at ~25fps while feeding **corrupt, non-monotonic capture PTS** (frames arriving ~2s in the past; fabricated repeat-frames). Because frames never stop for a full second, the camera-stale watchdog barely fires. The user gets no signal, records for 40 minutes, and discovers the A/V desync afterwards. **That is the exact frustration #44 is about, and the current warnings are blind to it.**

This task makes that failure **visible** while it's happening, so the user can pause, stop, or carry on. It does **not** fix the meltdown — that's task 3.

## The framing that drives the design (read this first)

> **Don't curve-fit a detector to five recordings. Detect the broken invariant.**
>
> An earlier pass at this task (and #44's original wording) proposed firing on a *spike in metronome reject counters* (`rejectMonotonicity` / `rejectNegElapsed`) and treated **calibrating thresholds against the 2026-06-06 set as the centre of gravity**. A calibration session (2026-06-09) **refuted that approach** against the real data — see "What the data actually showed" below. The reject counters do not track the meltdown, and tuning window-lengths / cluster-counts to a handful of *intermittent* samples is fitting noise.
>
> Instead, key on the **one invariant the entire recording rests on**. From the pipeline design (and confirmed as the exact failure mechanism on #30):
>
> > Video PTS = the camera frame's hardware **capture time**. Audio PTS = the mic's. A/V sync is *defined* by trusting that camera capture-PTS timeline.
>
> The meltdown is precisely a **violation of that invariant**: the camera's capture-PTS stops advancing monotonically (jumps backward, or repeats). A garbage video timeline against a clean audio timeline *is* the desync. So the signal is a direct question, asked at the source:
>
> > **Is the camera's capture-PTS timeline still sane — i.e. does each frame's capture PTS advance from the last?**

### Why this is the right signal (robust to *any* camera, not just the ZV-1)

- **Rate-agnostic / VFR-safe.** A camera at 24, 25, 29.97, 30, 60fps, or honest VFR all produce *forward-advancing, monotonic* capture PTS. The check is blind to the rate — it only sees direction and plausibility. This satisfies the re-scope's hard requirement: **"below-target-but-steady is fine; *destabilising* is the signal."** A healthy ZV-1 at 24fps (the expected state once task 3 lands) cannot trip it.
- **Dropped frames don't trip it.** A slow / stuttering camera produces *large forward* gaps — not flagged. Only *non-advancing* (≤ ~1ms, which covers backward jumps and duplicate/fabricated PTS) gaps count. A drop is not a corruption.
- **Mode-independent and mode-switch-proof.** It is measured at **raw camera frame arrival** (`handleCameraFrame`), which is one continuous stream across the whole recording — the camera `AVCaptureSession` starts once in `prepare` and stops only at `stop`; `switchMode` just flips a flag. So there is **no FIFO-drain / mode-switch confound** (the thing that made the metronome-counter approach noisy) and **no grace window is needed**.
- **It catches the cause, not a mode-specific effect.** It flags both `cameraOnly` meltdowns *and* `screenAndCamera` ones (where the screen drives output so the metronome looks healthy, but the camera PiP / sync is still rotting). A downstream "output collapsed" proxy only sees the `cameraOnly` half.
- **The data confirms it; it does not define it.** The boundary is *categorical*, not a tuned line: a healthy camera produces **exactly zero** non-advancing frames; corruption produces some. That is why we don't need a finely-calibrated threshold — only a small debounce so a single fluke doesn't fire.

This is the same predicate task 3 should use to *enforce* the invariant (drop non-monotonic frames before they kill the raw writer / desync output). Task 2 **observes** the violation; task 3 **enforces** the invariant. See `task-3-camera-frame-rate-fix.md`.

## What the data actually showed (2026-06-09 calibration session)

Five labelled recordings: four ZV-1 meltdowns (`-12743` counts **4,314 / 11,217 / 22,932 / 28,428**) + one clean FaceTime baseline (**0**). All have `recording.json` + `diagnostics.json` + `os-log.ndjson` in `~/Library/Application Support/LoomClone[-Debug]/recordings/<id>/`. Findings:

1. **The metronome reject counters do *not* detect the meltdown — hypothesis refuted.** `rejectMonotonicity`+`rejectNegElapsed` rate: clean **0.2%** vs meltdowns **0.2%–2.9%**. The killer counterexample is `cb202438` — a severe meltdown (22,932 `-12743`) with `mono=0` and the *same* reject rate as the clean baseline. **Why:** post-#21, the source-PTS freshness gate (`skipStale`) absorbs corrupt frames *before* they reach the encoder-level monotonicity guard, so the meltdown never shows up as a reject. Any plan built on "reject-rate spike" is dead on arrival.
2. **`skipsStale` is *not* a clean signal either** — it conflates the `cameraOnly` meltdown case with the entirely-benign `screenAndCamera` static-screen case (both set `cameraBranch = "skipStale"`), and it spikes harmlessly right after every mode switch (FIFO drain). Confounded by mode; do not key on it.
3. **The clean baseline has a perfectly regular, monotonic camera cadence** — 100% of inter-frame capture-PTS gaps in the 30–35ms bucket, **zero** gaps below 5ms across the entire 917-frame recording.
4. **Every meltdown violates capture-PTS monotonicity at the source** — sub-5ms / backward gaps appear in all four (physically impossible for a real camera at any rate; these are CMIO fabrication / `RepeatPreviousFrame`). The os-log corroborates: `monotonicity.rejected` frames arriving ~2s in the past.

So the data's role is to **confirm the shape** (healthy = monotonic; corruption = non-monotonic) and to serve as a sanity-check / regression reference — *not* to source numeric thresholds. With only a handful of intermittent samples, fitting thresholds to them would be fragile. Keep the five recordings as the labelled reference set; cross-check the warning's firing windows against task 1's extracted `-12743` floods for the same sessions (it should light up where the flood is and stay dark on the clean baseline).

## Design

### Part 1 — In-recording quality-degradation warning

**The detector (shared, simple).** A small pure type — e.g. `Helpers/CameraCadenceMonitor.swift`, `Sendable`, unit-tested — ingests one camera capture-PTS per frame and answers "is the feed healthy?":

- Track the previous frame's capture PTS. A new frame whose gap from it is **≤ ~1ms (covering backward, zero, and duplicate/fabricated PTS)** is a *non-monotonic event* — the invariant violation.
- Keep a short trailing window of recent non-monotonic events. Report **degraded** when the count within the window crosses a small debounce threshold; report **recovered** after a quiet period with none.

The exact numbers (window length, count threshold) are **debounce / fluke-protection on a categorical signal**, not calibrated discriminators — pick conservative defaults (e.g. a few events within a few seconds), document them as such with a pointer to this section, and lean on the instrumentation below to confirm/adjust against real recordings. Do **not** present them as tuned science.

**Wiring.** Feed the monitor from `recordCameraFrameForDiagnostics` (`RecordingActor+FrameDiagnostics.swift`), which already computes the camera inter-frame gap via `lastCameraCapturePTS` — the measurement point is free. Evaluate health from the existing ~2Hz health timer (the same one that drives `checkSourceHealth`), in a new `checkQualityHealth()` (a `RecordingActor+QualityHealth.swift` extension, or folded into `+SourceHealth`). Fire a single `.qualityDegraded` warning and clear it on recovery, mirroring the existing stale/recover dispatch (`fireWarning`/`clearWarning`, `activeSourceWarnings` dedup, fire-once → auto-clear → re-fire).

**Severity & copy.** `.warning`, not `.critical` — the recording is still producing output, just degraded; the user's call whether to pause/stop/continue (matches #44: "subtly warn… gives the user the opportunity to either pause… stop… or carry on"). Message along the lines of "Recording quality may be degraded — check your camera."

**Timeline.** Record `quality.degraded` / `quality.recovered` events (`RecordingTimeline` / `RecordingTimelineBuilder`) carrying the windowed metrics in `data` (non-monotonic count, measured camera fps) for post-hoc forensics.

### Part 2 — Pre-recording preview cadence/health monitoring

#44 reasons (correctly) that the preview uses the same device + CMIO path as the real recording, so a stuttering preview predicts a stuttering recording — far better to catch it *before* hitting record. `CameraPreviewManager` already measures delivered frame rate per sample buffer (task-1 Part 3) and has a first-frame watchdog. Feed its sample-buffer capture PTS into the **same `CameraCadenceMonitor`** and surface a gentle pre-record note in the popover preview pane ("Camera feed looks unstable — try reconnecting / see logs") when it reports degraded. This is the "factor the common piece so preview and recording share one notion of healthy" the task wants — and now that the notion is one predicate, the sharing is trivial.

Per the picker-flood memory, keep any high-frequency observable reads in a **leaf subview**, not a parent hosting `NativePopUpPicker`.

Pairs with task-1 Part 3's metadata badge (actual vs reported resolution/fps): that shows the *static facts*; this adds the *stability* dimension on top. Same honest caveat as task 1: there is **no clean app-level API to reset a wedged USB/CMIO device** — offer "rebuild the preview session" (the watchdog already does this) and "unplug/replug," not a magic reset. Relates to #3.

### Instrumentation (for forensic validation, not tuning)

Add a lightweight `cameraNonMonotonicPTS` counter to `MetronomeDiagnostics` (incremented at the same measurement point) and into `PeriodicSnapshot`, so the *next* real recordings carry the live signal into `recording.json` / `diagnostics.json`. This lets us confirm the detector fired where the `-12743` flood actually was (cross-referenced with task 1's `os-log.ndjson`) and adjust the debounce if real-world data ever shows a need — the categorical separation means that should be rare.

## Out of scope

- **Fixing the underlying meltdown** (the rate-lock / CMIO corruption) — **task 3**. This task makes it *visible*, not *gone*. (Task 3 should *enforce* the same invariant this task observes — drop non-monotonic camera frames before they kill the raw writer / desync output. See task 3.)
- **Any change to the metronome's frame-handling / emit logic** — we only *read* the camera capture PTS at arrival.
- **Test-recording / warmup probe** — **task 4**.

## Sequencing note

If task 3 lands first (likely — it fixes the user's main workflow), the ZV-1 mostly stops melting down, so this warning's job narrows to catching *other* / residual mid-recording degradation (a different flaky camera, a USB hiccup, a condition task 3 doesn't fully cover). Still worth building — it's the safety net, and because it keys on the invariant rather than the ZV-1 specifically, it covers cases we haven't seen yet. Bias toward **zero false positives over catching every mild burst**: the warning only earns trust if it never cries wolf.

## Files likely touched

| Concern | File |
|---|---|
| Shared cadence/PTS-health detector (pure, unit-tested) | `Helpers/CameraCadenceMonitor.swift` (new) |
| Feed the monitor from camera arrival + evaluate health | `Pipeline/RecordingActor+FrameDiagnostics.swift` (measurement point), `Pipeline/RecordingActor+QualityHealth.swift` (new) or `+SourceHealth` |
| New warning kind + fire/clear | `Models/RecordingWarning.swift` (`.qualityDegraded`), reusing `fireWarning`/`clearWarning` |
| New timeline events | `Models/RecordingTimeline.swift` / `RecordingTimelineBuilder.swift` (`quality.degraded` / `quality.recovered`) |
| Forensic instrumentation | `Pipeline/RecordingActor+Diagnostics.swift` (`cameraNonMonotonicPTS` counter + `PeriodicSnapshot`) |
| Preview cadence health + UI note | `Helpers/CameraPreviewManager.swift`; popover preview pane view in `UI/` (leaf subview) |
| Tests | `LoomCloneTests/` — `CameraCadenceMonitor` unit tests (boil the lake: monotonic/VFR/dropped-frame = healthy; backward/duplicate = degraded; debounce; recover) |
| Doc update | `docs/developer/recording-pipeline.md` (document the quality warning + the invariant it keys on) |

## Outcome (completed 2026-06-09)

Both parts shipped as designed. Files landed:

- **`Helpers/CameraCadenceMonitor.swift`** (new) — the shared, pure, `Sendable`, unit-tested predicate.
- **`Pipeline/RecordingActor+QualityHealth.swift`** (new) — `checkQualityHealth()`, evaluated from the existing ~2Hz health timer; fires/clears a single `.qualityDegraded` `.warning` pill via the existing `fireWarning`/`clearWarning` dispatch (made internal so the new extension can reuse them). Clears cleanly if the mode switches away from the camera mid-recording.
- Fed from **`RecordingActor+FrameDiagnostics.swift`** (the free camera measurement point); `.qualityDegraded` added to **`RecordingWarning.swift`**; `quality.degraded` / `quality.recovered` events (with windowed non-monotonic count + measured fps) in **`RecordingTimelineBuilder.swift`**; forensic `cameraNonMonotonicPTS` counter in **`RecordingActor+Diagnostics.swift`** (counters, `PeriodicSnapshot`, summary line).
- **Part 2:** `CameraPreviewManager` feeds the same monitor and publishes `previewFeedUnstable` on transition; surfaced as the leaf `CameraFeedStabilityNote` in the popover preview pane (`UI/MenuView.swift`), keeping the high-frequency read out of the `NativePopUpPicker` parent.
- Docs updated in `docs/developer/recording-pipeline.md`; 19 `CameraCadenceMonitor` unit tests.

### Design refinement the real data forced: high-water mark, not previous-frame

The original design said "does each frame's capture PTS advance **from the last** [frame]?" Validating against a real ZV-1 meltdown (`2dee88cf`) refuted the *previous-frame* reading: the meltdown's severe form is a **sustained backward shift** — the timeline jumps ~4s into the past, then runs *forward* at the normal interval. Against the previous frame those catch-up frames look healthy (+33ms); a 32-frame flood registered as a **single** event and never fired. The fix: judge each frame against the **high-water mark** (highest PTS seen so far), which is the same comparison the encoder's own monotonicity guard uses. All the original properties hold (zero violations on monotonic / VFR / dropped-frame feeds), but the sustained shift now flags every catch-up frame. Two regression tests lock it in.

### Validation (three live ZV-1 recordings)

| Recording | Path | `-12743` | `nonMonoPTS` | Warning | Notes |
|---|---|---|---|---|---|
| `2dee88cf` | native USB | 7,842 | 9 | fired t=8.8→12.3 (cameraOnly) | exposed the previous-frame miss → high-water fix |
| `cd798c48` | native USB | 7,017 | 15 | fired t=22.9→30.0 (**screenAndCamera**) | the hard case; user saw the pill on screen and narrated it in the transcript — confirms the UI renders, not just the timeline |
| `ee52f73a` | HDMI → Cam Link 4K | 0 | 0 | never fired | clean baseline; zero false positives |

The `screenAndCamera` fire on `cd798c48` is the key proof: the screen drives output cadence so the metronome looks healthy while the camera PiP timeline rots — exactly the case a metronome-counter or "output collapsed" proxy would miss, and the capture-PTS invariant caught it. The Cam Link baseline (same camera, HDMI path, no meltdown) confirms zero false positives and seeded a comment on #30 noting the meltdown is specific to the ZV-1's native USB/UVC streaming.

### Carried forward to task 3

Task 3 should *enforce* the same invariant this task observes — drop / hold non-monotonic camera frames (judged against the high-water mark) before they reach the raw writer / desync output. The `CameraCadenceMonitor` predicate and the `cameraNonMonotonicPTS` instrumentation are the shared foundation.
