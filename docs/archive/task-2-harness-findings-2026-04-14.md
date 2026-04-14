# Task-2 harness findings — 2026-04-14

This note closes out `docs/tasks-todo/task-2-run-test-harness-tests.md`. It records what the isolation test harness did and didn't produce, and what that leaves us with going into main-app validation. Future readers asking "what did the harness actually tell us?" should find the answer here.

Designed to slot directly into a future combined narrative alongside `docs/m2-pro-video-pipeline-failures.md` (what broke) and `docs/archive/task-1-tunings-audit-2026-04-14.md` (what we did). This doc is the "what we learned" piece.

## Summary

- Tiers 1, 2, 3 landed on synthetic frame sources. Every config in all three tiers PASSES on the post-task-1 harness. Baselines at `test-runs/tier-1-baseline-post-task-1-2026-04-14.md`, `tier-2-baseline-2026-04-14.md`, `tier-3-baseline-2026-04-14.md`.
- **Headline finding.** T3.2 is the literal reconstruction of the configuration that wedged the Mac on 2026-04-11 13:32 — ProRes 4K + composited HLS 1440p + raw H.264 720p camera + CIContext compositor. On the post-task-1 harness with synthetic content, T3.2 PASSES clean: zero dropped frames, perfect HLS segment cadence, no GPU errors, no watchdog fire.
- **This does not prove the hang is fixed.** Synthetic content is ~20–30% of real SCStream entropy and compresses much more efficiently than real capture, so the synthetic encoder load is materially lower than the production load. What it proves is that the writer *shape* is not the sole trigger for failure mode 4.
- **Tier 4 real-capture work did not complete.** The harness's `real-screen` (`SCStream`) path is broken when writers are attached — SCStream's delegate fires at ~30 fps with no writers but collapses to ~0.4 fps as soon as any writer is attached, for reasons we didn't isolate. Three fixes were attempted and none changed the delivery rate. Task-2 closed without Tier 4 evidence rather than continue to debug the harness indefinitely.

## What the tiered synthetic work tells us

The three synthetic baselines, read together, sketch a clear picture:

**Writer shape is not the trigger.** Failure mode 4 requires something the synthetic harness doesn't emulate. The shape of the pipeline that was blamed on 2026-04-11 (three concurrent writers + compositor + 1440p HLS) runs cleanly on synthetic content on the exact same machine. Candidate real-capture-specific causes — untested in the harness because real capture didn't land — remain:

- Real `SCStream` buffer provenance (vended from WindowServer's IOSurface pool, not a local `CVPixelBufferPool`).
- Real `AVCaptureSession` buffer delivery pattern and callback concurrency.
- Real content entropy driving the H.264 engine closer to saturation.
- `SCStream` dirty-rect metadata and how CIContext handles it.
- Display configuration state (we were on Retina 4K native vs display-points) at time of hang.

**Task-1 tunings are doing real work, even if we can't say which one is load-bearing.** The tunings are on the main-app and harness code paths. T3.2 was designed to crash and didn't. The reasonable interpretation is that the combination of `420v`, warmed-up writers before `SCStream.startCapture()`, `RealTime = false`, `AllowFrameReordering = false`, and `RequireHardwareAcceleratedVideoEncoder = true` has moved the pipeline from "hung at 1440p" to "didn't hang at peak synthetic pressure." We can't attribute it to a single tuning without the Tier 5 reverse-sweeps that were gated on a reproducing config.

**Achieved bitrate tells the whole caveat.** Across all synthetic HLS configs the achieved bitrate was 18–32% of the configured target because the `moving` pattern in 420v compresses very aggressively. Real `SCStream` content will drive the encoder much harder. Tier 3's "every config passes" result has a synthetic-content ceiling on how much it licences.

## What broke in Tier 4

Real-capture source kinds (`real-screen`, `real-camera`) were implemented in `app/TestHarness/Sources/CapturedFrameSource.swift` alongside a `--list-devices` flag and the device-selection fields on `SourceConfig` (`displayID`, `displayName`, `deviceUniqueID`, `deviceName`, `maxHeight`). The camera path works — delivers at the ZV-1's declared 25 fps consistently. The screen path does not.

**Symptom.** With no writers or compositor attached, `SCStream` delivers ~30 fps as expected (verified by `T4.0-real-screen-only-diagnostic`: 288 accepted / 6 rejected over 10 s). As soon as the writers from T4.1/T4.2 (ProRes 4K + composited HLS + raw H.264 camera) are attached, `SCStream` delivers only ~13 frames over 30 s — two orders of magnitude below its idle rate, even with zero writer-drop events (i.e. the writers aren't back-pressuring through `isReadyForMoreMediaData`).

**What we tried.** Three fixes, each plausible, none effective:

1. Store the full `CMSampleBuffer` instead of the extracted `CVPixelBuffer`, on the theory that the pixel buffer's IOSurface reference was tied to the sample buffer's retention chain and we were leaving stale handles. No change.
2. Add a generation counter to `HarnessFrameSource` so the metronome only feeds raw-screen / raw-camera writers when the source has produced a genuinely new buffer, rather than hammering them with 30 copies of one frame per second. No change.
3. Extend the generation-based dedup to the compositor + HLS path, so the compositor only runs when the screen source is fresh (matching what the main app actually does — compositor driven by SCStream delivery, not a synthetic metronome). No change.

Each fix was reasoned, shipped, and measured. None moved the screen delivery rate off ~0.4 fps. The working hypothesis that consumer-side GPU load was contending with SCStream looks wrong, or at least not the whole story.

**What we didn't try.** A systematic bisection (one writer at a time, with vs without compositor, with vs without `startWriting()` called) was outlined as the next step but not executed. If Tier 4 gets picked up again, that's the right starting point rather than another fix attempt.

## What this hands to main-app validation

The open question the harness didn't close is: **does failure mode 4 still reproduce on the real app with task-1's tunings applied?**

Suggested validation protocol on the main app:
1. Record at the 1080p preset for 2 minutes (the known-stable Phase 2 baseline). Confirm no degradation.
2. Switch to the 1440p preset and record for 2 minutes. This is the exact configuration that wedged the Mac on 2026-04-11. With task-1 tunings in place, either:
   - **No hang, no dropped frames, clean HLS cadence** → tunings have fixed failure mode 4 in practice. Keep them. Harness work closed.
   - **Hang reproduces** → task-1 tunings were insufficient; new investigation starts, with this note + `task-1-tunings-audit-2026-04-14.md` + `m2-pro-video-pipeline-failures.md` as the starting material. Task-2 reopens; first step is fixing the harness's real-capture path.
   - **Degradation without hang** (dropped frames, stretched HLS segments) → partial fix; need to decide whether degradation is acceptable or dig further.
3. Run `./app/TestHarness/Scripts/run-tier-1.sh` (and `run-tier-3.sh` for critical configs) on any future code change to the recording pipeline as a synthetic regression gate. Tier 1/2/3 synthetic baselines are the durable asset from this work.

## What the harness is good for going forward

Even with the real-capture path broken, the harness produced durable assets:

- **Synthetic regression check.** Tier 1 post-task-1 baseline is a 4-minute "is the writer pipeline still structurally sound?" check that catches any refactor that breaks a writer. Run it before any main-app recording-pipeline change.
- **Tier 2 / Tier 3 configs.** Reproducible pressure tests for multi-writer combinations. Still useful for pre-validating main-app changes on synthetic content before real-app testing.
- **Shape fidelity.** The harness's split routing (raw-prores gets raw screen, composited-hls gets compositor output) mirrors main-app Phase 2 exactly; any future Tier 4 work inherits that.
- **Safety scaffolding.** Watchdog + in-progress marker + one-at-a-time Tier 3/4 runners — these work and should be reused when real capture is fixed.

## Where the baseline data lives

- `test-runs/tier-1-baseline-post-task-1-2026-04-14.md` — 7/7 PASS, per-config output sizes, task-1 output-size deltas vs pre-task-1 (2–5× smaller on video writers because of the 420v default and `RealTime = false`).
- `test-runs/tier-2-baseline-2026-04-14.md` — 6/6 PASS including T2.5 (ProRes 4K + HLS 1440p without camera writer), HLS achieved-vs-target bitrate table.
- `test-runs/tier-3-baseline-2026-04-14.md` — 6/6 PASS including T3.2 (the 2026-04-11 13:32 reconstruction), full analysis of the "writer shape is not the trigger" finding, per-variant ProRes and HLS sizes.

Individual run directories are gitignored and have been cleared — the baselines are the durable record.

## Commit trail (task-2 work only)

```
fe97260 task-2: Tier 4 configs + runner + SourceConfig decode fix + --list-devices formats
6f5bca6 task-2: fix real-capture buffer retention + add per-second delivery logging
6c373dd task-2: Tier 1 baseline re-run post task-1 — all 7 PASS
acb1edb task-2: split screen-side routing and add Tier 2 configs
42f9509 task-2: Tier 2 baseline — all 6 PASS
4388301 task-2: Tier 3 configs and single-config runner
4fee249 task-2: Tier 3 baseline — all 6 PASS, failure mode 4 does not reproduce on synthetic
80f9b88 task-2: real-capture source implementation + task doc progress update
```

Plus follow-up commits for the attempted real-capture fixes and this close-out note.
