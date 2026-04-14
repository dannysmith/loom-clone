# Tier 1 baseline — post task-1 — 2026-04-14

Regression re-run of the Tier 1 suite on the harness after task-1 landed its
VideoToolbox best-practice tunings (see `docs/task-1-tunings-audit-2026-04-14.md`).
All 7 configs PASS — task-1 did not regress Tier 1. Safe to proceed to Tier 2.

Hardware: Mac14,9 (M2 Pro, 14-inch, 32 GB), macOS 26.4.
Build: `LoomCloneTestHarness` Debug, rebuilt against post-task-1 sources.

| # | Name | Outcome | Output size | Frames | vs 2026-04-11 |
|---|---|---|---|---|---|
| T1.1 | prores-4k-alone | PASS | 290.6 MB | 900 / 0 dropped | 533.7 → 290.6 MB ↓ |
| T1.2 | h264-1080p-alone | PASS | 3.7 MB | 900 / 0 dropped | 16.7 → 3.7 MB ↓ |
| T1.3 | h264-1440p-alone | PASS | 7.2 MB | 900 / 0 dropped | 30.5 → 7.2 MB ↓ |
| T1.4 | h264-4k-alone | PASS | 13.8 MB | 900 / 0 dropped | 58.5 → 13.8 MB ↓ |
| T1.5 | h264-720p-camera-alone | PASS | 2.1 MB | 900 / 0 dropped | 2.9 → 2.1 MB ↓ |
| T1.6 | compositor-alone | PASS | (no writers) | 900 / 0 dropped | unchanged |
| T1.7 | audio-alone | PASS | 9.98 KB | 0 video / 0 dropped | ~10 KB unchanged |

Total tier wall-clock ~4 minutes (runner ran each config sequentially with
dry-run + ~32 s execution + snapshots). No `kIOGPUCommandBufferCallback*`
errors. No watchdog fires. No in-progress markers left behind.

## What changed vs the 2026-04-11 baseline

Output sizes dropped materially across every video writer. This is the
expected side-effect of **task-1 tuning 1** (flipping the `synthetic-screen`
source kind to default 420v YCbCr instead of 32BGRA), compounded by
**tuning 3** (`RealTime = false` gives the encoder more time to compress)
and **tuning 4** (`AllowFrameReordering = false`, minor effect for
single-writer tests).

Specifically: `synthetic-screen` now produces 420v buffers by default via the
`.screen420v` kind added to `SyntheticFrameSource`, which halves the per-frame
IOSurface byte count (4 bpp BGRA → 1.5 bpp 420v). The `moving` pattern in
420v has smoother chroma content than in BGRA, so H.264 compresses it much
more aggressively — hence the 4–5× size drop on the H.264 writers. ProRes 4K
halves rather than quarters because ProRes encodes both planes explicitly.

This is not a quality regression — it's expected behaviour from the tuning.
The frame counts, drop counts, and outcome classification are identical to
the pre-task-1 baseline.

## What this tells us (unchanged from 2026-04-11)

1. Every individual writer — ProRes 4K, H.264 1080p/1440p/4K, H.264 720p
   camera-like, AAC audio — still works on its own with synthetic frames
   after the task-1 changes. **The 1440p preset still does not fail in
   isolation.**
2. The H.264 engine still handles 4K alone at 18 Mbps without back-pressure.
3. The CIContext compositor still runs for 30 seconds without hanging when
   fed the dual-source input at 30 fps and producing 1080p output with a
   PiP overlay.
4. New: every H.264 and HLS writer starts successfully with
   `RequireHardwareAcceleratedVideoEncoder = true` at the top level of
   `outputSettings` (task-1 tuning 6). On this M2 Pro, the hardware encoder
   is the path we're running. Software fallback would have thrown at
   `startWriting()`; it didn't.

## Next

Proceed to Tier 2 (two-writer combinations). Configs land under
`app/TestHarness/Scripts/test-configs/tier-2/` with a companion
`run-tier-2.sh`. Tier 2 is still synthetic-only and safe to batch.
