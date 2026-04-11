# Task 4 — Recording Pipeline Stabilisation

Finish the recording-pipeline work that was started in task-0A. That task landed Phase 1 (Rec. 709 camera metadata) and Phase 2 (raw screen writer moved to ProRes 422 Proxy on the dedicated ProRes engine) cleanly, and then Phase 2b (replacing the 4K preset with a 1440p preset) triggered a kernel-level IOGPUFamily deadlock — failure mode 4 in `docs/m2-pro-video-pipeline-failures.md`. The Phase 2b code is still on `main` and recording at 1440p on the current build will hang the developer's Mac.

This task is about applying the empirical findings from task-2 (test harness execution) to the real main-app pipeline, shipping a stable state, and removing the 1440p footgun currently sitting on `main`.

## ⚠️ Current status — `main` is unsafe at 1440p

Until this task ships, **do not select the 1440p preset on a build of `main`**. The 1080p and 720p presets remain safe and are the only production-validated configurations on this hardware. See `docs/m2-pro-video-pipeline-failures.md` (failure mode 4) for the full incident report and the spindump evidence from 2026-04-11 at 13:32.

This task's exit criteria include either (a) making 1440p safe or (b) explicitly removing it, so that the footgun is gone either way.

## Dependencies

This task depends on **task-2 (Run Test Harness Tests)** having produced real data — specifically, Tier 3 results that tell us which variant of the 1440p configuration is stable on M2 Pro.

Task-2 in turn depends on **task-1 (VideoToolbox best-practice tunings)** having applied the high-confidence tunings (ScreenCaptureKit `420v`, `PrepareToEncodeFrames` warm-up, `RealTime = false`, `AllowFrameReordering = false`, `MaxFrameDelayCount` bounded, diagnostic safety nets) to both the main app and the harness writers. So by the time this task starts, the expected state is: main app is already on a best-practice baseline (task-1), the harness has empirically validated that baseline at 1080p and mapped the 1440p failure region at Tier 3 (task-2), and this task applies whatever additional shape or preset-level change task-2's data justifies.

Specifically, task-2 Tier 3 is expected to produce:

- **T3.1** (1080p baseline with all three writers + compositor) — expected PASS, confirms the harness reproduces the proven-stable config.
- **T3.2** (1440p with all three writers + compositor) — the single most important data point. If this **still fails** after task-1's best-practice tunings are in place, it confirms the hang is not something task-1's tunings alone can resolve and this task must ship a shape change. If this **passes** after task-1's tunings (an outcome none of us are betting on but would be welcome), this task collapses to "validate on the real app, ship it."
- **T3.3** (1440p with raw screen writer at display-points resolution) — pass/fail tells us whether reducing raw screen capture relieves the kernel arbiter (Path B).
- **T3.4** (1440p with raw screen writer at mid resolution, 2560×1440) — same question at a midpoint.
- **T3.5** (1440p without the raw camera writer) — pass/fail tells us whether two hardware video sessions + compositor is the actual ceiling (Path C).
- **T3.6** (1440p with 420v YCbCr synthetic screen source) — if task-1 already shipped `420v` as the main-app default, this tier test is now the "verify the task-1 default holds at 1440p" check rather than a novel test.
- Any **Tier 5 parameter sweeps** from task-2 that flipped a failing configuration to a passing one via a specific `VTCompressionSession` / `SCStreamConfiguration` / pool-sizing setting — those are Path A fodder.

If Tier 3 and Tier 5 produce no stable 1440p variant at all, the decision defaults to path (d) below: revert Phase 2b and ship 1080p-only.

Do not start implementation on this task until task-2 has at least completed Tier 3. Starting early means guessing — which is how we got into this mess in the first place.

**Task-3 slot is deliberately free.** If task-2 surfaces a finding that requires a new intermediate piece of work (e.g. a harness feature, a specific new diagnostic tool, a dependency that task-4 needs before it can start) which doesn't fit task-1, task-2, or task-4's scope, create it as task-3 and wire the dependency in here.

## Context

Read in this order:

- `docs/m2-pro-video-pipeline-failures.md` — the institutional memory of failure modes 1–4. Failure mode 4 is the one this task exists to resolve.
- `docs/tasks-done/task-2026-04-11-0A-encoder-contention-and-camera-pipeline.md` — the historical record of what was done in Phases 1, 2, and 2b, including the outcome blocks with real empirical data from the 2026-04-11 test sessions.
- `docs/tasks-todo/task-1-videotoolbox-best-practice-tunings.md` — the upstream tunings task. Read its audit notes to see which knobs were applied to the main app before this task starts.
- `docs/tasks-todo/task-2-run-test-harness-tests.md` — the test plan this task consumes the results of. Specifically the tier baseline summaries at `test-runs/tier-*-baseline-*.md`.
- `app/TestHarness/README.md` — the harness itself, in case you need to run a specific config by hand to verify a finding before applying it to the main pipeline.
- Current state of the main-app pipeline: `app/LoomClone/Pipeline/RecordingActor.swift`, `WriterActor.swift`, `RawStreamWriter.swift`, `CompositionActor.swift`, `Models/OutputPreset.swift`, `Capture/ScreenCaptureManager.swift`.

## Paths forward, ranked by preference

Which path to take is decided by the task-2 data (and the task-1 tunings that precede it). Don't commit to one ahead of time.

### Path A — A research-informed fix to 1440p

If a specific `VTCompressionSession` property, `SCStreamConfiguration` option, or pool-sizing tweak turns out in task-2's Tier 3 or Tier 5 data to flip the 1440p full-pipeline config from FAIL-KILLED to PASS, apply the same change to the main app. Note that the most obvious such changes are already shipped by task-1 — this path is about the *additional* tunings (the medium-confidence Tier 5 priorities 6 and 8, or a combination of task-1 defaults whose load-bearing subset task-2's reverse-sweeps identified) that weren't included in the task-1 high-confidence baseline.

Sketch:
- Identify the exact property and the writer / capture session / pool it applies to.
- Apply it in the minimal number of places in the main-app pipeline (avoid sprinkling tunings across unrelated code paths).
- Re-run the relevant harness config once with the fix applied in the harness to prove it's still passing.
- **Then** build the main-app change and test it on M2 Pro, following the staged-testing protocol from Phase 2's validation procedure (30 s → 1 min → longer) to avoid a third hard reboot.
- Update `docs/m2-pro-video-pipeline-failures.md` failure mode 4 with a "what we now know" footnote describing the fix.

Most desirable outcome. Ships the 1440p preset intact and teaches us something about how IOGPUFamily schedules resources on M2 Pro.

### Path A′ — 1440p works out-of-the-box after task-1 tunings

If task-2 T3.2 *passes* at 1440p on the post-task-1 harness baseline — i.e. the best-practice tunings from task-1 were by themselves sufficient to fix failure mode 4 — the remaining work is just to validate the main app at 1440p (which task-1 deliberately did not do, because 1440p was still hanging `main` when task-1 started). This is the easy outcome:

Sketch:
- Stage-test the main app at 1440p: 30 s → 1 min → ≥ 5 min, with zero `kIOGPUCommandBufferCallback*` errors and healthy 4 s segment cadence.
- Update `docs/m2-pro-video-pipeline-failures.md` failure mode 4 with a "what we now know" footnote that the combined task-1 tunings resolved it.
- Re-run the task-2 Tier 5 reverse-sweeps (if not already done by task-2) to identify which specific tuning is load-bearing at 1440p — useful for regression protection.

Second most desirable outcome after Path A (which would indicate we understood something new). Path A′ is "the research worked without further effort" — good for stability, but we should still do the reverse-sweeps so we know *which* tuning is doing the work.

### Path B — Reduce raw screen capture resolution

If T3.3 (raw screen writer at display-points resolution, e.g. 1920×1080 on a Retina display rather than native 3840×2160) passes in task-2, this is the fix: constrain `ScreenCaptureManager`'s `SCStreamConfiguration.width` / `height` and the raw screen writer's output dimensions to display-points resolution instead of native pixels.

Sketch:
- `ScreenCaptureManager.startCapture` currently requests the display's native resolution. Change it to request display-points resolution (or a task-2-validated intermediate).
- `RecordingActor.prepareRecording` passes the raw screen writer `(width, height)` based on the capture source — confirm it inherits the new smaller dimensions automatically.
- Do NOT change the composited HLS output resolution — the preset system still drives that. This change only affects the raw master file.
- Document the quality trade-off in `docs/requirements.md` under the Quality section. The user has previously indicated display-points raw masters are an acceptable trade-off as a last resort.
- Stage-test on M2 Pro: 30 s at 1440p preset, then 1 min, then longer, per Phase 2's validation protocol.

Ships the 1440p preset but at the cost of raw master fidelity.

### Path C — Remove the raw camera writer at 1440p

If T3.5 (1440p with ProRes screen + compositor, no raw camera writer) passes but paths A and B don't, the raw camera master gets dropped above 1080p preset.

Sketch:
- `RecordingActor.prepareRecording` already has the writer instantiation structure; skip instantiating the `RawStreamWriter.videoH264` camera writer when `preset.height > 1080`.
- The composited HLS writer still receives camera frames via the compositor — viewers still see the camera in the streamed output.
- `recording.json` `rawStreams` schema needs to handle the "no camera master" case gracefully. Either omit the `camera` block or write a marker indicating it was intentionally skipped.
- UI: if there's any surface that says "raw camera master is saved at preset X", update it.
- Stage-test on M2 Pro.

Less desirable — this is a feature regression at 1440p.

### Path D — Revert Phase 2b

If none of A / B / C work, revert Phase 2b entirely. Ship 1080p preset as the maximum streaming resolution. Raw screen master stays at native Retina, raw camera master stays H.264.

Sketch:
- Revert the parts of `71211eb` that introduced the 1440p preset: `OutputPreset.p4k` (or the current `.p1440`) removal, `RecordingCoordinator.is1440pAvailable` naming, the `MenuView` quality picker gating, any legacy UserDefaults fallthrough.
- Keep everything from Phase 1 and Phase 2 — those are working and load-bearing.
- Update `docs/requirements.md` to state that 1080p is the max streamed resolution on Apple Silicon Pro-class hardware.
- No hardware validation needed (1080p is already proven stable via Phase 2's Stage 1/2 runs), but smoke-test the revert on a 30 s recording to confirm nothing else broke.

Safest fallback. Ships a working product at the cost of the "higher-quality streaming" ambition.

### Path E — Revert Phases 2 and 2b both (avoid)

Going all the way back to pre-task state means three concurrent H.264 encoders again, which has documented degradation (failure mode 1). Not preferred. Only consider this if there's some undiscovered problem with Phase 2's ProRes offload that task-2 surfaces.

### Path F — Drop ProRes, match Cap's two-writer recipe (H11 from the research doc)

If paths A, A′, B, C all fail but the research doc's H11 is confirmed by task-2 (two H.264 writers + deferred compositing is stable at 1440p), this path ships the Cap recipe: two H.264 writers (composited HLS + raw camera), no ProRes anywhere in the live pipeline, all raw-screen compositing deferred to post-recording if we want a raw master at all.

Sketch:
- Remove the ProRes raw screen writer from the live pipeline entirely.
- Either drop the raw screen master feature, or generate it post-recording by re-encoding the composited HLS output (lower quality) or by running a separate ProRes pass after the live recording ends (more code, more complexity).
- Update `docs/requirements.md` Quality section to reflect the new raw-master story.
- Stage-test at 1440p with the two-writer shape.

This is more desirable than Path E because it preserves failure mode 1's fix (no three concurrent H.264 engines) while sidestepping the ProRes contention. Less desirable than Paths A / A′ / B / C because it's a larger architectural change to the raw-master story.

## Implementation protocol

Whichever path is chosen:

1. **Validate in the harness first.** Before touching main-app code, run the harness-level version of the chosen configuration and confirm it's stable. This removes "I changed the main app and hope it works" from the loop entirely.
2. **Stage-test on M2 Pro.** Every main-app validation follows the 30 s → 1 min → longer protocol from Phase 2. After any change touching the encode pipeline, the cost of one extra iterative test is much lower than the cost of a third WindowServer hang.
3. **Run `log stream --predicate 'subsystem CONTAINS "Metal"'`** during validation and watch for any `kIOGPUCommandBufferCallback*` errors. Expectation: zero.
4. **Keep Phase 1 and Phase 2 intact.** They both work. Don't refactor them as part of this task unless the chosen path requires it.
5. **Record the outcome** in `docs/m2-pro-video-pipeline-failures.md` under failure mode 4's "what we now know" footnotes.

## Exit criteria

- [ ] `main` is safe at every preset exposed in the UI. No runtime configuration can hang the Mac.
- [ ] If 1440p is shipped: it's been validated on M2 Pro via a ≥ 5 minute recording with the full writer set active, with zero `kIOGPUCommandBufferCallback*` errors and healthy 4 s segment cadence.
- [ ] If 1440p is removed: `OutputPreset` no longer exposes it, `RecordingCoordinator.is1440pAvailable` and the `MenuView` gating are gone, and legacy UserDefaults values fall through to `.default` (1080p) without errors.
- [ ] `docs/m2-pro-video-pipeline-failures.md` failure mode 4 has been updated from "what we don't know" to "what we now know" footnotes describing the resolution — whether that's a fix, a trade-off, or a revert.
- [ ] The relevant task-2 harness config that validated the fix has been left committed in the repo so future regressions can be caught with one command.

## Follow-ups not in this task

The following were noted in task-0A (now archived at `docs/tasks-done/task-2026-04-11-0A-encoder-contention-and-camera-pipeline.md`) as out of scope and remain out of scope here. They should move to `docs/tasks-todo/task-0-scratchpad.md` if they haven't already:

- **Metronome skipping CIContext in single-source modes.** In `cameraOnly` mode the compositor runs a full render every metronome tick even though there's no screen to composite. An optimisation would skip the render and feed the camera frame directly to the HLS writer. Small, unrelated to the instability fix.
- **Broader camera testing matrix.** Phase 1's format-introspection logging should eventually include data from Continuity Camera, Elgato Cam Link, and generic USB webcams. Not urgent; ZV-1 coverage is sufficient for shipping.

## Cross-task references

- `docs/m2-pro-video-pipeline-failures.md` — institutional memory of the failure modes this task exists to resolve.
- `docs/research/11-m2-pro-video-pipeline-deep-dive.md` — research doc with hypotheses H1–H12; H11 is the Path F recipe.
- `docs/tasks-todo/task-1-videotoolbox-best-practice-tunings.md` — upstream. Applies the best-practice tunings to the main app and the harness. This task starts from that baseline.
- `docs/tasks-todo/task-2-run-test-harness-tests.md` — the test plan whose findings drive this task's path selection.
- `docs/tasks-done/task-2026-04-11-0A-encoder-contention-and-camera-pipeline.md` — historical record of Phases 1, 2, and 2b.
- `docs/tasks-todo/task-5-compositor-error-handling-and-camera-adjustments.md` — picks up after this task lands. Phase 1 of that task (compositor error handling) is much more useful on a stable pipeline, and Phase 2 (camera adjustments) needs Phase 1's structured error path to land first.
- `docs/requirements.md` — product requirements, especially the Quality section. May need a paragraph update depending on which path is taken.
