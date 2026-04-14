# Tier 3 baseline — 2026-04-14

Three-writer combination tier on the post-task-1 harness with the split
screen-side routing. **All 6 configs PASS on synthetic sources, including
T3.2 — the exact writer shape that hung the Mac on 2026-04-11 at 13:32.**

This is the single most important Tier 3 finding: **failure mode 4 does
not reproduce on synthetic content even at the peak-pressure configuration**.
The trigger must therefore be a property of real-capture content
(`SCStream` + `AVCaptureSession`) that the synthetic harness doesn't
emulate. Tier 4 (real-capture replacement) becomes the critical path.

Hardware: Mac14,9 (M2 Pro, 14-inch, 32 GB), macOS 26.4.
Build: post-task-1, split-routing harness.

## Results

| # | Name | Outcome | Frames | HLS bytes | Raw output |
|---|---|---|---|---|---|
| T3.1 | Phase 2 1080p stable baseline | PASS | 900 / 0 dropped | 6.3 MB | ProRes 4K 290.6 MB · camera 2.1 MB |
| T3.2 | Phase 2b 1440p known-hang | **PASS** | 900 / 0 dropped | 9.8 MB | ProRes 4K 290.6 MB · camera 2.1 MB |
| T3.3 | 1440p, ProRes at display-res (1080p) | PASS | 900 / 0 dropped | 7.8 MB | ProRes 1080p 73.0 MB · camera 2.1 MB |
| T3.4 | 1440p, ProRes at mid-res (1440p) | PASS | 900 / 0 dropped | 7.4 MB | ProRes 1440p 129.2 MB · camera 2.1 MB |
| T3.5 | 1440p without raw camera writer | PASS | 900 / 0 dropped | 9.8 MB | ProRes 4K 290.6 MB |
| T3.6 | 1440p with BGRA screen source | PASS | 900 / 0 dropped | 12.1 MB | ProRes 4K 533.7 MB · camera 2.1 MB |

HLS segment durations for every run: `[4, 4, 4, 4, 4, 4, 4, 2]`. Zero
interior drift. No `kIOGPUCommandBufferCallback*` errors. No watchdog
fires. No in-progress markers left behind.

Every run completed in ~32 s wall-clock (30 s metronome + snapshots).

## Headline finding — T3.2 does not reproduce the hang on synthetic

T3.2 is the literal reconstruction of the configuration that triggered
the 2026-04-11 13:32 `WindowServer` watchdog hang documented as
failure mode 4 in `docs/m2-pro-video-pipeline-failures.md`:
- ProRes 4K raw screen writer
- Composited HLS at 1440p @ 10 Mbps
- Raw H.264 720p camera writer
- CIContext compositor with camera overlay

Ran it against synthetic sources. **Zero dropped frames, zero GPU errors,
HLS cadence perfect, ProRes + camera output sizes matched their
single-writer isolation baselines exactly.**

Implication: the writer *shape* is not the trigger for failure mode 4.
Something about **real capture content** is the missing ingredient.

## Per-config observations

### T3.1 vs T3.2 — 1080p vs 1440p, both pass

The 1080p "stable" and 1440p "known-hang" configurations have identical
outcomes on synthetic. HLS 1080p produces 6.3 MB @ 6 Mbps target (28%
achieved bitrate); HLS 1440p produces 9.8 MB @ 10 Mbps target (26%).
Per-frame IOSurface deltas between the two (compositor output 1920×1080
vs 2560×1440, ~1.8× more bytes per composited frame at 1440p) don't
manifest as any stability difference on synthetic content.

### T3.3, T3.4 — ProRes resolution sweep

Linear scaling of ProRes output with screen-source pixel count:
- T3.3 (1080p): 73.0 MB
- T3.4 (1440p): 129.2 MB
- T3.2 (4K): 290.6 MB

Each size is within 5% of what you'd get running the ProRes writer in
isolation at that resolution (Tier 1 values). No degradation from the
concurrent H.264 + HLS work. No cliff in stability between any of the
three resolutions.

### T3.5 — no raw camera writer, camera overlay preserved

Removing the raw H.264 camera writer while keeping the camera in the
compositor overlay: still PASS. This compares against:
- T2.5 (camera entirely removed — no source, no overlay, no writer): PASS
- T3.2 (camera everywhere — source + overlay + raw writer): PASS
- T3.5 (camera in source + overlay but no raw writer): PASS

On synthetic, the second concurrent H.264 encode session for the camera
is not the critical factor. If failure mode 4 holds for real capture, the
"drop the raw camera writer" task-4 Path C hypothesis needs Tier 4
validation.

### T3.6 — BGRA reverse-sweep (task-1 tuning 1)

Same writers as T3.2 but the screen source is 32BGRA instead of
post-task-1 420v default. BGRA is 2.67× the bytes per pixel, so the
per-frame screen IOSurface goes from ~9 MB (420v 4K) to ~33 MB (BGRA 4K).
ProRes output 533.7 MB matches the pre-task-1 Tier 1 baseline exactly,
confirming the source pipeline is producing genuine BGRA all the way to
the writer.

Despite the 2.67× per-frame pressure: **PASS with zero dropped frames**.
On synthetic content, the 420v pixel format was not load-bearing for
stability at 1440p. This is a weak signal — synthetic H.264 achieved
bitrates are 20–32% of target across the board, so there's a lot of
headroom hiding what would otherwise be a pressure difference. Tier 4
should include a BGRA sweep on real capture if T3.2 reproduces the hang
there.

## Achieved HLS bitrates (all well below target)

| config | HLS target | achieved | ratio |
|---|---|---|---|
| T3.1 (1080p) | 6 Mbps | 1.68 Mbps | 28% |
| T3.2 (1440p) | 10 Mbps | 2.61 Mbps | 26% |
| T3.3 (1440p, 1080p src upscaled) | 10 Mbps | 2.08 Mbps | 21% |
| T3.4 (1440p) | 10 Mbps | 1.97 Mbps | 20% |
| T3.5 (1440p) | 10 Mbps | 2.61 Mbps | 26% |
| T3.6 (1440p, BGRA src) | 10 Mbps | 3.23 Mbps | 32% |

T3.6's slightly higher bitrate (32% vs 26% for T3.2) likely reflects more
compression-resistant synthetic content when the source is BGRA rather
than 420v — the chroma subsampling in 420v smooths out content that H.264
would otherwise spend more bits encoding.

The same caveat as Tier 2 applies, now stronger: real `SCStream` output
has significantly more entropy than the synthetic `moving` pattern.
Real-capture achieved bitrates will be much closer to target, meaning
the encoder will work harder, and that's where failure mode 4 may be
hiding.

## What this hands to the next tier and to task-4

### Tier 4 is now the critical path

With T3.2 demonstrably stable on synthetic, there is **no useful Tier 5
parameter sweep that can run on synthetic content** to pin down failure
mode 4 — nothing can flip pass to fail on content that passes everywhere.
The actionable path is:

1. Implement `real-screen` (`SCStream`) and `real-camera`
   (`AVCaptureSession`) source kinds in the harness.
2. Run T4.2 (real-capture reproduction of T3.2). If it PASSES, the
   failure mode is intermittent and something else we haven't isolated
   (display configuration, specific content, thermal state, etc.). If it
   FAILS, we have a reproducible real-capture hang to work from.
3. Then run T4-new configs mirroring T3.3 / T3.5 / T3.6 on real capture
   to find the critical variable.
4. Tier 5 parameter sweeps then run on the real-capture configuration
   that's on the failure boundary.

### Open questions the harness so far can't answer

From `docs/m2-pro-video-pipeline-failures.md` / research doc § 6, these
questions remain open after Tier 3 because synthetic doesn't reach the
failure region:

- **Q2** (what conditions cause IOGPU deadlock) — Tier 3 eliminated
  writer shape as the sole cause. Remaining candidates (real-capture
  buffer provenance, WindowServer IOSurface pool interaction, capture
  callback concurrency pattern, SCStream dirty-rect metadata) all
  require Tier 4.
- **Q3** (VT session properties affecting IOGPUFamily) — no sweep is
  useful until a reproducing config exists.
- **Q5** (IOSurface pool sizing) — same.
- **Q7** (warm-up preventing allocation stalls) — same.
- **Q8** (footprint cliff) — needs `footprint` polling during a
  reproducing run.

### For task-4 specifically

The decision framework in `docs/tasks-todo/task-2-run-test-harness-tests.md`
§ "Decision framework" paths B / C / D all depend on Tier 4 evidence
before they can be actioned. **Do not make task-4 decisions based on
Tier 3 alone** — synthetic results tell us the writer shape is safe, but
that doesn't licence any main-app change because the trigger is elsewhere.

## Next

Implement real-capture source kinds in the harness. Re-use the main-app
`ScreenCaptureManager` / `CameraCaptureManager` shape (copying ~100 lines
per the task doc; keep the harness standalone). Then Tier 4.
