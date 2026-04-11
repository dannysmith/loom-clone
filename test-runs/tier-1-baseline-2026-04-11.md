# Tier 1 baseline results — 2026-04-11

First clean run of the isolation harness Tier 1 suite on the M2 Pro
development machine. Synthetic frame sources, no real capture, no
concurrent writers. Per task-0C: "Any Tier 1 failure means we have a
fundamental problem that's not about concurrency." All seven configs
passed, so the baseline single-component assumptions hold.

Hardware: Mac14,9 (M2 Pro, 14-inch, 32 GB), macOS 26.4.
Build: LoomCloneTestHarness Debug, synthetic pattern fill via
`memset_pattern4`.

| # | Name | Outcome | Output size | Frames |
|---|---|---|---|---|
| T1.1 | prores-4k-alone | PASS | 533.7 MB | 900 / 0 dropped |
| T1.2 | h264-1080p-alone | PASS | 16.7 MB | 900 / 0 dropped |
| T1.3 | h264-1440p-alone | PASS | 30.5 MB | 900 / 0 dropped |
| T1.4 | h264-4k-alone | PASS | 58.5 MB | 900 / 0 dropped |
| T1.5 | h264-720p-camera-alone | PASS | 2.9 MB | 900 / 0 dropped |
| T1.6 | compositor-alone | PASS | (no writers) | 900 / 0 dropped |
| T1.7 | audio-alone | PASS | 10 KB | 0 video / 0 dropped |

Each run took ~35 s wall-clock (30 s metronome + ~2 s pre-snapshot
+ ~3 s post-snapshot + finish writing). Total tier wall-clock ~4.5
minutes.

No `kIOGPUCommandBufferCallback*` errors observed.
No watchdog fires.
No in-progress markers left behind.

What this tells us:

1. Every individual writer — ProRes 4K, H.264 1080p/1440p/4K, H.264
   720p camera-like, AAC audio — works on its own with synthetic
   frames. **The 1440p preset does not fail in isolation.**
2. The H.264 engine handles 4K alone at 18 Mbps without back-pressure
   (no dropped frames, segment cadence is fine). Failure mode 3 is
   therefore specifically about *concurrent* H.264 sessions, not 4K
   H.264 in the absolute sense.
3. The CIContext compositor runs for 30 seconds without hanging when
   fed 4K BGRA + 720p YCbCr sources at 30 fps and producing 1080p
   BGRA output with a PiP overlay. In isolation it is fine.
4. The pattern fill performance scales roughly linearly with pixel
   count once using `memset_pattern4`: 4K BGRA fills in microseconds,
   not tens of milliseconds. This matters for keeping synthetic
   frame generation a non-confound at high resolutions.

Tier 2 (two-writer combinations) and Tier 3 (three-writer combinations,
which includes the known-hang config T3.2) are not yet implemented in
this task. Tier 3 must not be run until the safety scaffolding has
been exercised end-to-end with a deliberate dry-run of the exact
known-hang config first.
