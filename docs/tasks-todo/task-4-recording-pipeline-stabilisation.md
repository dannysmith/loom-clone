# Task 4 — Recording Pipeline Stabilisation

Validate that the 1440p preset is actually safe on the post-task-1 main app, and decide what to do based on what the real app shows. This is a placeholder until that validation happens — the content below will be rewritten once we have empirical data.

## Current status

Three things have landed since the 2026-04-11 13:32 kernel-level hang (failure mode 4 in `docs/m2-pro-video-pipeline-failures.md`):

- **Task-1 applied VideoToolbox best-practice tunings** to both the main app and the harness. See `docs/task-1-tunings-audit-2026-04-14.md`. Seven tunings considered, five applied (420v, warm-up reorder, `RealTime = false`, `AllowFrameReordering = false`, hardware-encoder enforcement), two deferred (`MaxFrameDelayCount`, `PixelBufferPoolIsShared`) because they're not reachable through `AVAssetWriter`.
- **Task-2 ran the harness on synthetic content.** Tiers 1/2/3 all PASS, including T3.2 — the literal reconstruction of the configuration that hung the Mac on 2026-04-11. On synthetic the writer shape is not the trigger. See `docs/task-2-harness-findings-2026-04-14.md`. The real-capture path in the harness didn't land, so Tier 4 evidence isn't available.
- **`main` has not been tested at 1440p since task-1 shipped.** The Phase 2b 1440p preset is exposed in the UI and the app will attempt to use it.

## ⚠️ `main` is unvalidated at 1440p

The last time anyone recorded at 1440p, the Mac hung. That was before task-1. Circumstantial evidence says task-1 probably fixed it (T3.2 passes on synthetic after task-1), but nothing has actually proven the main app is safe at 1440p on this hardware. Until this task closes, treat 1440p as unvalidated — use 1080p for anything you care about.

## The only next step

**Manual validation on the main app at 1440p.** Stage-test protocol:

1. Record 30 s at 1080p — sanity check that task-1's changes didn't regress the known-stable baseline.
2. Record 30 s at 1440p. Watch for hangs, `kIOGPUCommandBufferCallback*` errors in `log stream --predicate 'subsystem CONTAINS "Metal"'`, dropped frames, stretched HLS segments.
3. If 30 s is clean: 1 min at 1440p.
4. If 1 min is clean: ≥ 5 min at 1440p.

Record outcome in `docs/m2-pro-video-pipeline-failures.md` failure mode 4's "what we now know" footnotes regardless of result.

## Outcomes — each updates this doc

This task stays open until one of these lands:

- **Clean at 5+ min at 1440p.** Task-1's tunings resolved failure mode 4 in practice. Update the failures doc, close this task. Rewriting of task-4 isn't needed — it just goes to `tasks-done/`.
- **Hangs or recovers to kernel-level wedge.** Failure mode 4 still reproduces. Reopen investigation from the material in the three docs (`m2-pro-video-pipeline-failures.md`, `task-1-tunings-audit-2026-04-14.md`, `task-2-harness-findings-2026-04-14.md`). The harness's real-capture bug is the first blocker to fix; once fixed, the bisection plan in the harness README's "Active limitations" section applies. Task-4 content gets rewritten then.
- **Userspace-recoverable degradation** (dropped frames, stretched segments, `kIOGPUCommandBufferCallback*` errors but no hang). Partial fix from task-1. Decide whether the degradation is acceptable. If not, rewrite this task with whichever of the fallback paths below fits — none are yet warranted without main-app evidence.

## Fallback paths (not committed to)

Listed only so the toolbox is visible. None of these gets adopted without main-app evidence that the 1440p config genuinely can't pass.

- **Reduce raw screen capture resolution** (task-4 Path B in the pre-rewrite version). `ScreenCaptureManager` configures `SCStreamConfiguration` at display-points rather than native pixels. Reduces IOGPU pressure; costs raw master fidelity.
- **Drop the raw camera writer at 1440p+** (Path C). `RecordingActor.prepareRecording` skips the `RawStreamWriter.videoH264` camera writer above 1080p preset. Viewers still see the camera in the composited HLS stream. Loses the raw camera master above 1080p.
- **Revert Phase 2b** (Path D). Remove the 1440p preset from `OutputPreset` and the UI. Ship 1080p-max. Safe fallback.
- **Match Cap's two-writer recipe** (Path F; research doc H11). Remove ProRes from the live pipeline entirely, generate raw screen master post-recording or drop it. Architectural change to the raw master story.

## Exit criteria

- [ ] `main` has been stage-tested at 1440p on M2 Pro — either it works clean for ≥ 5 min, or we have specific observed failure evidence that motivates a chosen fallback path.
- [ ] `docs/m2-pro-video-pipeline-failures.md` failure mode 4 has "what we now know" footnotes reflecting the outcome.
- [ ] Either 1440p ships (validated), or the `OutputPreset` / `RecordingCoordinator` gating for 1440p is removed so the footgun is gone.

## Cross-references

- `docs/m2-pro-video-pipeline-failures.md` — the four failure modes, particularly #4.
- `docs/task-1-tunings-audit-2026-04-14.md` — the tunings applied to main and harness.
- `docs/task-2-harness-findings-2026-04-14.md` — what the harness did and didn't tell us.
- `docs/tasks-done/task-2026-04-11-0A-encoder-contention-and-camera-pipeline.md` — the historical Phase 1/2/2b record.
- `app/TestHarness/README.md` § "Active limitations" — the real-capture bug that blocks Tier 4 if we go back to the harness.
- `docs/tasks-todo/task-5-compositor-error-handling-and-camera-adjustments.md` — picks up once the pipeline is stable.

Once the validation run happens, this doc gets rewritten to match whatever outcome landed. That's the plan.
