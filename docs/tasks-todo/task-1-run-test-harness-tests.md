# Task 1 — Run Test Harness Tests

Use the isolation test harness (built in task-0C, lives at `app/TestHarness/`) to empirically map out which AVFoundation / VideoToolbox / CIContext configurations are stable on this M2 Pro Mac and which are not. The goal is to replace speculation about the failure modes with data, so that task-0A (the recording pipeline rework) can unblock Phases 3 and 4 with evidence instead of guesses, and so that `docs/m2-pro-video-pipeline-failures.md` can be updated from "what we don't know" to "what we now know" footnotes.

This is an execution task, not a coding task. The harness already exists and is working — this task runs tests in it and records what happens.

## Context

Before starting, read:

- `docs/m2-pro-video-pipeline-failures.md` — institutional memory of the four failure modes observed to date. Failure mode 4 (the 1440p-preset kernel-level IOGPUFamily deadlock, 2026-04-11 13:32) is the headline problem this test plan exists to diagnose.
- `app/TestHarness/README.md` — how the harness works, how to build it, how to run a single config or a whole tier, how to recover after a hang, and how to write a new test config.
- `docs/tasks-todo/task-0B-video-pipeline-research.md` — the research task running alongside this work. It produces concrete hypotheses that should feed into Tier 5 parameter sweeps.
- `docs/tasks-todo/task-0A-encoder-contention-and-camera-pipeline.md` — the task this execution work unblocks. Don't modify the main app's pipeline as part of this task; findings get written up and handed back to task-0A.

## Current state

- **Tier 1 has been run** (2026-04-11). All 7 configs PASSED on the dev M2 Pro. Baseline recorded at `test-runs/tier-1-baseline-2026-04-11.md`. This already tells us that the 1440p preset and 4K H.264 work fine in isolation — failure modes 3 and 4 are specifically about concurrent sessions, not the absolute resolution of any individual writer.
- Tiers 2–5 are not yet populated. Configs and runner scripts land as part of this task.

## Hard constraints (repeat from task-0C — still load-bearing)

- **Do not run a Tier 3+ configuration without dry-running it first.** The safety scaffolding (watchdog, last-known-good marker) is not a substitute for reading the config. Every new Tier 3+ config gets `--dry-run`'d before it's run for real, and gets run alone, not batched with other Tier 3 configs.
- **Do not batch Tier 3 runs.** The runner script already stops on the first `fail-killed` result; do not pass `--continue-on-fail` to it for Tier 3.
- **Do not modify the main LoomClone recording pipeline as part of this task.** If a finding suggests a main-app change, write it up and hand it back to task-0A.
- **After any hang, follow the recovery procedure in `app/TestHarness/README.md` before running anything else.** In particular, check for `test-runs/_in-progress.json`, record the dangerous config somewhere durable, and move the marker aside (don't delete it).

## Test plan

Each tier listed below should have:
1. One JSON config file per test under `app/TestHarness/Scripts/test-configs/tier-<N>/`.
2. A runner script at `app/TestHarness/Scripts/run-tier-<N>.sh` (can be a copy of `run-tier-1.sh` pointed at a different config directory).
3. A tier baseline markdown summary committed to `test-runs/tier-<N>-baseline-<date>.md` after the tier is run.

### Tier 1 — Baseline components in isolation (COMPLETE)

Goal: prove each component works on its own before combining them. Any Tier 1 failure means a fundamental single-component problem that's not about concurrency.

All Tier 1 tests use synthetic frames, 30-second duration, no real capture.

| # | Name | Config | Status |
|---|---|---|---|
| T1.1 | ProRes 4K alone | ProRes writer at 3840×2160, synthetic screen-like BGRA source. | **PASS** |
| T1.2 | H.264 1080p alone | H.264 writer at 1920×1080 @ 6 Mbps, synthetic BGRA source. | **PASS** |
| T1.3 | H.264 1440p alone | H.264 writer at 2560×1440 @ 10 Mbps, synthetic BGRA source. | **PASS** |
| T1.4 | H.264 4K alone | H.264 writer at 3840×2160 @ 18 Mbps, synthetic BGRA source. | **PASS** |
| T1.5 | H.264 720p camera alone | H.264 writer at 1280×720 @ 12 Mbps, synthetic YCbCr source. | **PASS** |
| T1.6 | CIContext compositor alone | Compositor with both sources, no writers attached. | **PASS** |
| T1.7 | AAC audio alone | Audio writer, synthetic PCM source. | **PASS** |

### Tier 2 — Two-writer combinations

Goal: find out if two simultaneous writers cause any observable issues. If these all pass, single-writer concurrency isn't the trigger.

All Tier 2 tests use synthetic frames, 30-second duration.

| # | Name | Config |
|---|---|---|
| T2.1 | 2×H.264 at 1080p + 720p | HLS 1080p @ 6 Mbps + raw H.264 720p @ 12 Mbps. Matches the Phase 2 stable config minus ProRes. |
| T2.2 | 2×H.264 at 1440p + 720p | HLS 1440p @ 10 Mbps + raw H.264 720p @ 12 Mbps. Does 1440p HLS by itself (no ProRes, no compositor) trigger the failure? |
| T2.3 | 2×H.264 at 4K + 720p | HLS 4K @ 18 Mbps + raw H.264 720p @ 12 Mbps. Expected to back-pressure (failure mode 3 analogue) but not deadlock. |
| T2.4 | ProRes 4K + H.264 1080p HLS | Confirms the ProRes-plus-one-H.264 base case works. |
| T2.5 | ProRes 4K + H.264 1440p HLS | **Critical.** "Like Phase 2b but without the raw camera writer." Does removing the raw camera writer fix failure mode 4, or is it still triggered? |
| T2.6 | ProRes 4K + H.264 4K HLS | Hostile configuration — both streams at 4K. Expected to fail. |

### Tier 3 — Three-writer combinations (the failure region)

Goal: find the exact tipping point. Includes the known-hang configuration from failure mode 4. **Run Tier 3 tests one at a time. Do not batch them. Use the last-known-good marker.**

| # | Name | Config |
|---|---|---|
| T3.1 | Phase 2 1080p stable baseline | HLS H.264 1080p @ 6 Mbps + raw H.264 720p camera + ProRes 4K screen + compositor. **Expected to PASS** (reproduces the proven-stable Stage 2 config). |
| T3.2 | Phase 2b 1440p known-hang | HLS H.264 1440p @ 10 Mbps + raw H.264 720p camera + ProRes 4K screen + compositor. **Expected to FAIL (killed)** — this is the configuration that hung the Mac on 2026-04-11 at 13:32. The watchdog should catch it. |
| T3.3 | 1440p with ProRes at display res | Same as T3.2 but ProRes screen writer at display-points resolution (1920×1080 from a Retina display) instead of native 3840×2160. Tests the hypothesis that reducing raw screen resolution relieves IOGPU pressure. |
| T3.4 | 1440p with ProRes at mid res | Same as T3.2 but ProRes screen writer at 2560×1440 (same as the HLS output). Midpoint between native and display-points. |
| T3.5 | 1440p without raw camera writer | HLS H.264 1440p + ProRes 4K screen + compositor (no raw camera writer). Does removing one H.264 session avoid failure mode 4? This is the "what if we split the 2 H.264 engine load differently" test. |
| T3.6 | 1440p with BGRA→420v screen | Like T3.2 but synthetic screen source delivers 420v YCbCr instead of BGRA. Reduces per-frame IOSurface by half. |

### Tier 4 — Real capture replacement

Goal: verify that findings from Tiers 1–3 (which use synthetic frames) hold up when `ScreenCaptureKit` and `AVCaptureSession` are in the pipeline. Run the most interesting Tier 3 configs again with real capture.

Only run Tier 4 after Tier 3 has produced clear results. Requires implementing the `real-screen` and `real-camera` source kinds in the harness first — they currently bail at setup time.

| # | Name | Config |
|---|---|---|
| T4.1 | Real-capture Phase 2 1080p | T3.1 with real `SCStream` + `AVCaptureSession`. Sanity check that real capture doesn't change the baseline. |
| T4.2 | Real-capture known-hang 1440p | T3.2 with real capture. Confirms the failure reproduces with real capture too (expected yes). |
| T4.3 | Real-capture best-performing Tier 3 variant | Whichever Tier 3 variant looked most promising, now with real capture. |

### Tier 5 — Parameter sweeps

Goal: take the most interesting configuration from Tiers 3–4 and vary individual tuning parameters (from task-0B research) to see which ones move the needle.

Structure: take the most interesting configuration, run it N times with one parameter changed per run. Examples of parameters to sweep (the concrete list comes from task-0B):

- `kVTCompressionPropertyKey_RealTime` — true vs false on all writers
- `kVTCompressionPropertyKey_MaxFrameDelayCount` — 0, 1, 2, 4
- `kVTCompressionPropertyKey_MaximizePowerEfficiency` — on vs off
- `kVTCompressionPropertyKey_AllowFrameReordering` — on vs off
- Pixel buffer pool sizes (`kCVPixelBufferPoolMinimumBufferCountKey`, `kCVPixelBufferPoolMaximumBufferAgeKey`)
- `VTCompressionSessionPrepareToEncodeFrames` called before first frame vs not
- `SCStreamConfiguration.queueDepth`
- `SCStreamConfiguration.pixelFormat` (BGRA, 420v, 420f)
- `SCStreamConfiguration.width` / `height` (sub-native-resolution screen capture)

This tier is where the harness pays off: an automated sweep of 10–20 configurations running overnight while the developer works on something else is dramatically more efficient than manual testing. New tuning knobs are added to the harness's writer `configure()` methods as task-0B surfaces them — the dict lives under `tunings` on each writer config. See `app/TestHarness/README.md` § "Writer tunings" for the currently-supported keys.

Most Tier 5 sweeps can be expressed as multiple JSON files in `test-configs/tier-5/` that differ only in one `tunings` key. The tier runner picks them up in order and stops on the first fail like any other tier.

## Decision framework — what to do with the results

Once we have real data from the harness, we can make informed decisions about task-0A. A rough flow:

- **If T3.1 passes and T3.2 fails as expected**, the harness is working and the failure is reproducible in an isolated context. Good baseline.
- **If T3.3 (display-res ProRes) passes**, the fix for task-0A Phase 2b is to reduce the raw screen capture resolution. Write it up as a recommendation, weigh the quality tradeoff, and decide whether to ship it.
- **If T3.5 (no raw camera) passes**, the fix might be to drop the raw camera writer on this hardware or move camera elsewhere. Less desirable because it loses a feature.
- **If T3.6 (YCbCr screen source) passes**, the fix is a one-line `SCStreamConfiguration` change. Best-case outcome.
- **If none of T3.3–T3.6 pass**, the harness has proven that the 1440p preset is fundamentally incompatible with the full writer set on this hardware, and we should revert Phase 2b to ship 1080p only. Accept the loss of 1440p and move on.
- **If a Tier 5 sweep finds a specific `VTCompressionSession` property setting that flips failure to success**, we've identified both a fix and a deeper understanding of what's happening.

Whatever the result, the output of this task is concrete evidence that informs the next step of task-0A. Leave this task with "we ran X and it PASSED/FAILED, here's the data", not "I think we should try X".

## Deliverable

1. **Tier 2 configs, runner script, baseline summary** committed to the repo. Summary lives at `test-runs/tier-2-baseline-<date>.md` and records per-config outcomes, interesting observations, and links to the runs that produced them. Run directories themselves stay gitignored.
2. **Tier 3 configs, runner script, baseline summary**, run one config at a time per the safety constraints above. The known-hang T3.2 is the single most important data point in this tier — it's the reference point everything else is compared against.
3. **Tier 4 configs** (if real-capture support lands in the harness as part of this task) and baseline summary.
4. **Tier 5 parameter sweep configs and summaries** for whatever subset of task-0B hypotheses have landed by the time Tier 3 results are in hand.
5. **Updates to `docs/m2-pro-video-pipeline-failures.md`** — the empirical evidence the harness produces should flow back into the failure modes doc as "what we now know" footnotes, particularly in the "What we don't know" subsections. This is the single most valuable long-term artefact of this task.
6. **A findings hand-off note to task-0A** summarising which harness-validated approach Phase 3 and 4 should take, and why. Either add it as a new section in `task-0A-encoder-contention-and-camera-pipeline.md` or link to it from there.

## Handoff

This task's outputs are consumed by two places:

1. **Task-0A (recording pipeline rework).** Phases 3 and 4 of task-0A are currently blocked on "what actually works on this hardware". The baseline summaries from this task provide the answer. When task-0A resumes, any change that touches the recording pipeline should be validated in the harness first — don't reopen the "change the main app, run a real recording, hope for the best" loop.
2. **`docs/m2-pro-video-pipeline-failures.md`.** Harness findings update the "What we don't know" subsections of each failure mode with concrete answers. This is how the institutional memory stays current as we learn more.

## Adding new tests mid-task

task-0B research is running alongside this work and will surface new hypotheses that weren't in the original plan. Fold those in by adding new JSON configs to the appropriate tier directory — the harness is designed to make this cheap. If a new hypothesis doesn't obviously belong in an existing tier, add it to the tier that matches its risk level (Tier 2 for two-writer tests, Tier 3 for three-writer, Tier 5 for parameter sweeps on an existing config).
