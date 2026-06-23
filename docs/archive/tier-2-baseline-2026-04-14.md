# Tier 2 baseline — 2026-04-14

First run of the two-writer combination tier on the post-task-1 harness.
All 6 configs PASS on synthetic frame sources. Zero dropped frames, HLS
segments perfectly on-cadence across every run.

Hardware: Mac14,9 (M2 Pro, 14-inch, 32 GB), macOS 26.4.
Build: `LoomCloneTestHarness` Debug, post-task-1 with the Tier 2 routing
split (raw-prores takes raw screen; composited-hls takes compositor output).

## Results

| # | Name | Outcome | Frames | HLS bytes | Raw output |
|---|---|---|---|---|---|
| T2.1 | 2×H.264 1080p + 720p camera | PASS | 900 / 0 dropped | 6.3 MB | camera 2.1 MB |
| T2.2 | 2×H.264 1440p + 720p camera | PASS | 900 / 0 dropped | 9.8 MB | camera 2.1 MB |
| T2.3 | 2×H.264 4K + 720p camera | PASS | 900 / 0 dropped | 14.6 MB | camera 2.1 MB |
| T2.4 | ProRes 4K + HLS 1080p | PASS | 900 / 0 dropped | 4.9 MB | ProRes 290.6 MB |
| T2.5 | ProRes 4K + HLS 1440p (no raw camera) | PASS | 900 / 0 dropped | 7.9 MB | ProRes 290.6 MB |
| T2.6 | ProRes 4K + HLS 4K @ 18 Mbps | PASS | 900 / 0 dropped | 12.4 MB | ProRes 290.6 MB |

HLS segment durations for every run: `[4, 4, 4, 4, 4, 4, 4, 2]`. Seven
perfect 4-second segments plus a 2-second tail (30 s runtime ÷ 4 s interval
= 7.5 segments). Zero interior drift.

No `kIOGPUCommandBufferCallback*` errors. No watchdog fires. No in-progress
markers left behind. Total tier wall-clock ~3.5 minutes.

## Notable findings

### T2.5 — the critical data point

**ProRes 4K + composited HLS at 1440p with CIContext, no raw camera writer
→ PASS with zero dropped frames.**

This is Phase 2b minus the raw camera writer. The combination of
`ProRes engine + H.264 engine + CIContext` at 1440p is **not sufficient on
its own** to trigger failure mode 4 on synthetic content. If this result
holds up under real capture in Tier 4, it strongly suggests the raw camera
writer (a second concurrent H.264 encode session) is load-bearing in the
kernel wedge we observed at Phase 2b.

If true, task-4 Path C — drop the raw camera writer at 1440p+ and rely on
post-recording extraction from the composited HLS output — becomes a viable
fix.

### T2.6 — upper bound higher than the task doc predicted

The hostile configuration (ProRes 4K + composited HLS at 4K @ 18 Mbps on
the same native screen resolution) was predicted to back-pressure or fail.
On synthetic content it **passed clean** with zero dropped frames and
perfect segment cadence. That's new data about the M2 Pro ceiling — at
least for content that compresses efficiently.

### HLS bitrate well below target

Achieved bitrates vs configured targets:

| config | target | achieved | ratio |
|---|---|---|---|
| T2.1 (1080p) | 6 Mbps | 1.68 Mbps | 28% |
| T2.2 (1440p) | 10 Mbps | 2.61 Mbps | 26% |
| T2.3 (4K) | 18 Mbps | 3.89 Mbps | 22% |
| T2.4 (1080p) | 6 Mbps | 1.31 Mbps | 22% |
| T2.5 (1440p) | 10 Mbps | 2.11 Mbps | 21% |
| T2.6 (4K) | 18 Mbps | 3.31 Mbps | 18% |

The encoder is writing well below the average-bitrate target because the
synthetic `moving` pattern in 420v has extremely smooth chroma and
predictable motion — H.264 compresses it aggressively. This is the same
phenomenon observed in the Tier 1 post-task-1 re-run.

**This is the biggest caveat of the entire Tier 2 result.** Real
`SCStream` content has substantially more high-frequency detail and
unpredictable motion. If Tier 4 reproduces T2.5 and T2.6 at real-capture
load and still passes, that's a genuine signal. If they fail under real
capture, the Tier 2 pass is a synthetic-content artefact and doesn't
licence any change to task-4's plan.

## Classifier fix applied mid-tier

First run of Tier 2 (15:33–15:36) marked all 6 configs as DEGRADED because
`HarnessRunner.cadenceDrift` was counting the final (tail) 2 s segment as
drift. Fix: `.dropFirst().dropLast()` so only interior segments contribute
to the drift calculation. The Tier 2 runs in this baseline (15:43–15:46)
are the post-fix re-run. The bug didn't surface in Tier 1 because no Tier 1
config uses a `composited-hls` writer.

## What this tells us

1. The task-1 tunings and the Tier 2 routing split together carry the
   pipeline cleanly through every two-writer combination, including the
   ProRes+HLS+1440p combo that was specifically designed to probe failure
   mode 4 without a camera writer.
2. On synthetic content, the M2 Pro can sustain ProRes 4K + HLS 4K @ 18 Mbps
   concurrently without back-pressure. The failure mode 3 "4K back-pressure
   cascade" described in `docs/m2-pro-video-pipeline-failures.md` is
   therefore specific to real-capture content characteristics, not the raw
   pixel throughput.
3. The synthetic-vs-real gap (visible in the 18–28% bitrate ratios above)
   means Tier 2 passes have a ceiling on how much they can license. Tier 4
   is where these results are either confirmed or contradicted.

## What this hands to the next tier(s)

**Tier 3** — three-writer combinations, still synthetic. Worth running to
map where synthetic content *does* start stressing the pipeline. T3.2
(Phase 2b 1440p known-hang reproduction) is especially interesting given
T2.5's clean pass: if T3.2 also passes on synthetic, the raw camera writer
hypothesis gets weaker; if T3.2 fails on synthetic, it gets stronger.

**Tier 4** — real-capture replacement. This is where the Tier 2 results
actually become actionable. Priority targets:
- T4.1 (real-capture T3.1) — baseline sanity.
- T4.2 (real-capture T3.2) — does the hang reproduce under real capture?
- T4-new (real-capture T2.5) — the critical test. If this passes under
  real capture, task-4 Path C is evidence-backed.

## Next

Draft Tier 3 configs. Dry-run each one. Run T3.1 first (expected stable
baseline reproduction). Then T3.2 (known-hang) alone — watch the Mac
carefully and follow the `_in-progress.json` recovery flow if it wedges.
