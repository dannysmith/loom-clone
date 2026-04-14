# Task 4 — Recording Pipeline Stabilisation

Originally framed as "apply task-2's empirical findings to the main-app pipeline and remove the 1440p footgun currently sitting on `main`." In the end the work was resolved upstream: task-1's VideoToolbox best-practice tunings appear to have fixed failure mode 4 in practice, and the separate "is 1440p safe on main" gate that this task was structured around was closed by a direct validation run on 2026-04-14.

## How this resolved

1. **Task-1** (`docs/archive/task-1-tunings-audit-2026-04-14.md`) applied five VideoToolbox tunings — `420v` pixel format, writer warm-up reordering, `RealTime = false`, `AllowFrameReordering = false`, hardware-encoder enforcement — to both the main app and the test harness.
2. **Task-2** (`docs/archive/task-2-harness-findings-2026-04-14.md`) ran the harness against synthetic content through Tiers 1–3. All 19 configs passed, including T3.2 — the literal reconstruction of the configuration that hung the Mac on 2026-04-11 13:32. This established that the writer *shape* was not the sole trigger. Tier 4 (real capture) didn't land because the harness itself developed a back-pressure bug in the real-screen delivery path; task-2 closed without that evidence.
3. **Main-app validation on 2026-04-14**: two recordings on the post-task-1 main app on the same M2 Pro / Sony ZV-1 / BenQ EW2780U 4K display that was attached during the 2026-04-11 hang. One at 1080p preset (~71 s, 4 mode switches), one at 1440p preset (~62 s, 3 mode switches). Both clean — no hangs, no `kIOGPUCommandBufferCallback*` errors, HLS segments on healthy cadence, all segments uploaded and played back in the web viewer. SCStream delivered ~28 fps under the full Phase 2b writer load. The 1440p footgun is gone.

The only measurable quality trade-off from this whole episode is that the raw ProRes screen master is now sourced from 4:2:0 YUV (via SCStream `420v`) rather than the previous 4:4:4 BGRA. For typical screen content this is imperceptible and matches what every comparable production screen recorder on macOS ships. Full detail in `docs/m2-pro-video-pipeline-failures.md` § Resolution.

## What did not happen

None of the fallback paths that this task originally enumerated (reduce raw screen capture resolution, drop the raw camera writer at 1440p+, revert Phase 2b, match Cap's two-writer recipe) were needed. The research-informed tunings from task-1 were sufficient on their own to move the pipeline from "hangs reliably at 1440p" to "records cleanly at 1440p" on the target hardware.

Tier 5 parameter sweeps (which would have identified *which specific* tuning is load-bearing) were not run because they required a reproducing Tier 4 real-capture configuration that the harness couldn't produce. This remains the open question on failure mode 4 — the pipeline works but we can't attribute the fix to a single knob.

## Follow-ups deferred out of this task

- **Longer-duration 1440p validation.** The 2026-04-14 main-app validation recorded ~60 s at each preset. Real use cases include 10–30 minute recordings (product demos, longer tutorials — see `docs/requirements.md`). If a long recording at 1440p surfaces a new failure (thermal-induced hang, slow IOSurface leak, late-emerging segment cadence drift), that becomes a new task using the evidence trail in `docs/m2-pro-video-pipeline-failures.md` as starting material.
- **Harness real-capture bug.** `app/TestHarness/README.md` § "Active limitations" documents this. Fixing it would re-enable Tier 5 reverse-sweeps and let us isolate which of task-1's tunings carries the stability weight. Worth doing if the hang ever reappears; not worth doing if the fix keeps holding.

## Cross-references

- `docs/m2-pro-video-pipeline-failures.md` — the full incident record and resolution narrative.
- `docs/archive/task-1-tunings-audit-2026-04-14.md` — per-tuning audit.
- `docs/archive/task-2-harness-findings-2026-04-14.md` — harness work close-out.
- `docs/tasks-done/task-2026-04-14-1-videotoolbox-best-practice-tunings.md` — task-1.
- `docs/tasks-done/task-2026-04-14-2-run-test-harness-tests.md` — task-2.
