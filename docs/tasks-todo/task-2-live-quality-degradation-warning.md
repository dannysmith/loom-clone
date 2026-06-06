# Task 2: Live quality-degradation warning

https://github.com/dannysmith/loom-clone/issues/44

Second of four tasks from #44. Depends on **task 1** (forensics & foundations) having landed — task 1's extracted CMIO logs are what let us *confirm* that a counter-derived warning actually coincides with a real `-12743` meltdown rather than benign noise.

The core insight (see the #44 investigation comment): the existing source-health system catches the **clean** failures — a source going fully silent (`RecordingActor+SourceHealth.swift`: screen 2s / camera 1s / audio 2s staleness thresholds, plus capture-error and interruption handlers). But the failure that actually ruins recordings — the CMIO synchronizer meltdown from #30 — is **not** silence. The camera keeps delivering frames at ~25fps while feeding **corrupt, non-monotonic PTS**:

```
outputFps 22.7 (target 30) · effectiveCameraFps 25.5 · monoRejects 81 · neg 10 · noSrc 1076 · skipsStale 338
```

Because frames never stop for a full second, the camera-stale watchdog barely fires. The user gets no signal, records for 40 minutes, and discovers the AV desync afterwards. **That is the exact frustration #44 is about, and the current warnings are blind to it.**

The opportunity: **we already compute the signal.** The `MetronomeDiagnostics` counters on `RecordingActor` (`Pipeline/RecordingActor+Diagnostics.swift`) — `rejectMonotonicity`, `rejectNegElapsed`, `skipsStale`, `noSourceTicks`, `emitOK`, `iterations` — are incremented every metronome tick, live, and snapshotted every ~2s. They're only serialized at stop, into `recording.json`'s `runtime` block. Reading a **rolling window** of them mid-recording and firing a warning when the reject/no-source rate spikes catches the meltdown for almost nothing, reusing the entire existing `RecordingWarning` → `WarningBannerView` pipeline.

> **Update (2026-06-06) — re-scope in light of the task-1 findings + task 3.** Two things changed since this was first written:
>
> 1. **Don't fire on "camera slower than target" — that's normal, and it's the badge's job.** Task-1 Part 3 already ships a pre-recording badge that flags a sub-target camera (e.g. the ZV-1's honest ~24fps against a 30 target, shown in orange). And once **task 3** lands, an under-delivering camera running clean VFR is the *expected, healthy* state — a ZV-1 at 24fps must **not** trip this warning. So this warning must key on **degradation signatures** — a spike in `rejectMonotonicity`/`rejectNegElapsed` (the ~2s backward-PTS jumps the meltdown produces), or output collapsing *relative to the camera's own recent baseline* — **not** on "fps below the chosen target." Below-target-but-steady is fine; *destabilising* is the signal.
> 2. **A real calibration set now exists.** The five 2026-06-06 recordings (4 ZV-1 meltdowns + 1 clean FaceTime) plus their `os-log.ndjson` are a ready-made labelled dataset — `-12743` counts of 4,314 / 11,217 / 22,932 / 28,428 vs **0**, with matching `monoRejects`/`effectiveCameraFps`. Calibrate the threshold against these (see Part 2).
>
> Sequencing note: if task 3 lands first (likely — it fixes the user's main workflow), the ZV-1 will mostly stop melting down, so this warning's job narrows to catching *other*/residual mid-recording degradation. Still worth building — it's the safety net for any camera/condition task 3 doesn't fully cover.

## Current state (what we build on)

- **Live counters.** `MetronomeDiagnostics` (`RecordingActor+Diagnostics.swift`): per-tick `Int64` counters listed above, plus periodic snapshots (`PeriodicSnapshot`, pushed ~every 2s from the metronome loop) and the histograms. All live on the actor during recording.
- **Health-check cadence.** `checkSourceHealth()` (`RecordingActor+SourceHealth.swift:21`) already runs periodically (piggybacked on the metronome / a lightweight timer) and is the natural place to also evaluate a rolling reject-rate.
- **Warning model + UI.** `RecordingWarning` (`Models/RecordingWarning.swift`) with `.critical`/`.warning` severities and a `Kind` enum; `WarningBannerView`/`WarningPill` (`UI/`); `RecordingCoordinator.activeWarnings`; `fireWarning`/`clearWarning` dispatch (`RecordingActor+SourceHealth.swift:251`). Adding a warning is: one new `Kind` case + fire/clear logic.
- **Timeline events.** `recordSourceStale`/`recordSourceRecovered` etc. already exist; we add a `quality.degraded`/`quality.recovered` pair the same way.
- **Preview watchdog.** `Helpers/CameraPreviewManager.swift` already has a first-frame watchdog (1.5s × 2 retries). Part 2 extends it to cadence monitoring.

## Design

### Part 1 — In-recording quality-degradation warning

**The signal.** Maintain a short rolling window (suggest ~2–3s, i.e. the last N periodic snapshots or a small ring of per-tick deltas) and compute, over that window:

- reject rate = `(rejectMonotonicity + rejectNegElapsed) / iterations`
- no-source rate = `noSourceTicks / iterations`
- effective output fps vs target (we already derive `outputFps`/`effectiveCameraFps` at stop — compute the windowed version live)

Fire a single `.qualityDegraded` warning ("Recording quality may be degraded — check your camera") when the windowed signal crosses a threshold; clear it when the window recovers, mirroring the existing stale/recover pattern (fire-once, auto-clear on recovery, re-fire on a subsequent spike). Record `quality.degraded` / `quality.recovered` timeline events with the windowed metrics in `data` for post-hoc forensics.

**Severity.** `.warning`, not `.critical` — the recording is still producing output, just degraded. The user's call whether to pause/restart/continue. (Matches #44: "subtly warn… gives the user the opportunity to either pause… stop… or carry on.")

### Part 2 — Calibration is the actual work (don't guess thresholds)

The hard part is **not crying wolf.** Several benign things move these counters and must **not** trigger the warning:

- **`skipsStale` is normal** on a slow/VFR camera and on static screens — the freshness gate skipping is by-design (see the cadence-rework doc). Treat `skipsStale` as weak evidence at most; lean on `rejectMonotonicity`/`rejectNegElapsed` (which should be ~0 on healthy recordings per task-21) and the output-fps shortfall.
- **Mode-switch flurries** briefly spike rejects/no-source as the freshness gate walks carryover frames (documented in `recording-pipeline.md`, and #30's 2026-05-11 repro noted the failure within ~1s of two mode switches). Suppress evaluation for a short grace window after a `mode.switched` event.
- **Keep-alive / static-screen runs** legitimately produce no fresh source — `noSourceTicks` rises without anything being wrong. Don't count no-source against quality when keep-alive is active / in a screen mode with a static screen.
- **The brief cameraOnly warm-up** after switching into it (the freshness gate discarding pre-switch frames) is expected.

If the warning false-positives even occasionally, the user learns to ignore it and it becomes worthless — so **calibrate against real data, not intuition.** The 2026-06-06 test set is the labelled ground truth: four ZV-1 meltdowns (`recording.json` + `diagnostics.json` + `os-log.ndjson`, `-12743` counts 4,314 / 11,217 / 22,932 / 28,428, `monoRejects` 5–53, `effectiveCameraFps` ~21–24) and one clean FaceTime baseline (0 `-12743`, `monoRejects` 0, `skipsStale` 0). Crucially, the clean baseline and the *steady* parts of the meltdowns both run below/around target fps — so the separator can't be "fps < target"; it has to be the reject-spike / destabilisation. Also keep the older #30 sessions (e.g. `6a9f962f…`) as extra samples. Concretely:

1. Write a small offline analysis (a script, or a throwaway harness) that replays the periodic snapshots / counters from those JSONs and computes the candidate windowed signal over time.
2. Find a threshold (and window length, and required-consecutive-windows) that **clearly separates** the known-bad sessions from the healthy ones, including across mode switches and static runs.
3. Bake the chosen constants in with a comment pointing at the calibration data, the way the staleness thresholds are documented in `SourceHealth`.

This calibration step is the deliverable's center of gravity. Cross-check the firing windows against task 1's extracted CMIO logs for the same sessions — the warning should light up where the `-12743` flood is, and stay dark otherwise.

### Part 3 — Pre-recording preview cadence/health monitoring

#44 reasons (correctly) that the preview uses the same device and CMIO path as the real recording, so a stuttering preview predicts a stuttering recording — and it's far better to catch it *before* hitting record. Extend `CameraPreviewManager` beyond its first-frame watchdog to monitor **frame cadence** during preview:

- Track inter-frame intervals of preview sample buffers; if cadence is erratic / far below the device's advertised rate for a sustained window, surface a gentle pre-record warning in the popover ("Camera feed looks unstable — see logs / try reconnecting").
- This shares its detection logic with Part 1 (windowed cadence health) — factor the common piece so the preview and the recording use the same notion of "is this feed healthy."
- Pair with task 1 Part 3's metadata display (actual vs reported resolution/fps already shown there). Here we add the *health/stability* dimension on top of the *static facts*.

Same honest caveat as task 1: no clean device-reset API — offer "rebuild the preview session" (already what the watchdog does) and "unplug/replug," not a magic reset. Relates to #3.

## Out of scope

- Fixing the underlying meltdown (H.264 contention / CMIO corruption) — **task 3**. This task makes it *visible*, not *gone*.
- Any change to the metronome's actual frame-handling/emit logic — we only *read* its counters.
- Test-recording / warmup probe — **task 4**.

## Files likely touched

| Concern | File |
|---|---|
| Windowed signal + warning fire/clear | `Pipeline/RecordingActor+SourceHealth.swift` (or a new `+QualityHealth` extension), reading `Pipeline/RecordingActor+Diagnostics.swift` counters |
| New warning kind | `Models/RecordingWarning.swift` (`.qualityDegraded`) |
| New timeline events | `Models/RecordingTimeline.swift` / `Models/RecordingTimelineBuilder.swift` (`quality.degraded`/`quality.recovered`) |
| Preview cadence monitoring | `Helpers/CameraPreviewManager.swift`; popover preview pane view in `UI/` |
| Calibration analysis | throwaway script / harness against archived `recording.json` + `diagnostics.json` |
| Doc update | `docs/developer/recording-pipeline.md` (document the quality warning + thresholds) |
