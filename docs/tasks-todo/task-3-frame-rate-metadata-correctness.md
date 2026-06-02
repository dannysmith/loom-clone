# Task 3 — Frame-Rate Metadata Correctness

## Background

The forensic dig in [issue #40](https://github.com/dannysmith/loom-clone/issues/40) surfaced a bug **independent of the OOM**: recorded video declares the wrong frame rate in its container/stream metadata.

For the incident video, `source.mp4` (and the HLS init segment it's stitched from with `-c copy`) declares:

```
r_frame_rate  : 30/1                  ← declared
avg_frame_rate: 2923280/55251 ≈ 52.9  ← measured (60fps with occasional drops)
nb_frames     : 73082 over 1381.275 s = 52.91 fps actual
```

`recording.json` says `encoder.targetFPS: 60`. So the file genuinely carries ~60 fps content but declares 30 fps. The `-c copy` stitch carries that bad declaration straight through to `source.mp4`.

### Consequences

- **Variant re-encode produces broken output.** `generateVariants` (`derivatives.ts`, the `scale=-2:${height}` → `libx264` spawn, ~`:600`) runs with **no** `-r`/`-fps_mode`/`-vsync`, so it inherits the declared 30 fps. A full decode of the bad source yields **32,803 "non monotonically increasing dts to muxer"** errors — frames collide on the 30 fps timeline while the real PTS are ~60-fps-spaced. The 720p/1080p variants would stutter or drop frames. **This is the real, confirmed bug.**
- **Storyboard cue times — claim NOT verified; the code says it's probably fine.** The doc previously asserted "frame selection indexes by frame number, cue mapping uses the declared rate." Neither is true in the current code: `storyboard.ts` selects frames with `fps=1/${interval}` (a PTS/time-based filter, `:97`) and maps cues with `startTime = i * interval` seconds (`generateVtt`, `:51`) — both derived from wall-clock seconds (`interval`, `duration`), never from `r_frame_rate` or a frame index. Since `-c copy` preserves the correct PTS (the same reason browsers play `source.mp4` fine) and the incident's 73082 frames ÷ 1381 s ≈ 52.9 fps shows the PTS are correctly ~60-spaced, the `fps` filter and `-show_format` duration both see correct timing → storyboard cues should already be correct. **Action: reproduce on the retained `8c755ccf` source before touching storyboard. Expect no bug.** Do not "fix" storyboard timing on the strength of this doc alone.
- **Not a "won't play" bug.** Browsers and Vidstack are VFR-tolerant and use PTS directly, so `source.mp4` itself plays fine. The incident's "doesn't play" symptom was the OOM (no derivatives written), not this. This is a **derivative-quality** bug — it silently degrades every server-produced output.

### Correcting #40's diagnosis (important)

The issue comment proposes a "one-line fix — `AVVideoExpectedSourceFrameRateKey` set to 30 or unset." **That is wrong.** `H264Settings.swift:22` already sets `AVVideoExpectedSourceFrameRateKey: fps` with `fps` = the real target (60), and that key is only a *rate-control hint* to the encoder — it does **not** write the SPS/VUI timing that ffmpeg reads back as `r_frame_rate`. So the real cause lives elsewhere, and it is **not** a one-liner. Treat the root cause as genuinely open.

**Where to look — and where NOT to.** The incident numbers narrow this: 73082 frames ÷ 1381 s ≈ 52.9 fps means the **PTS cadence is already correct (~60)** — only the *declared* `r_frame_rate` is wrong. So the **metronome PTS is NOT the culprit** (`RecordingActor+Metronome.swift:100` builds PTS as `CMTime(value: tickIdx, timescale: targetFrameRate)`, which is correct at 60). The wrong declaration is written downstream of correct PTS — look at **`WriterActor`'s `AVAssetWriterInput` settings and the fMP4 track/media timescale**, i.e. the track's nominal frame-rate / timing the muxer records, not the frame timestamps themselves.

## Why this is its own task

The macOS frame production rate is **not** simply "the number the user picked." It depends on:

- the user's chosen streaming/target FPS (30 vs 60), **and**
- in some circumstances the **input source's actual deliverable FPS** — a camera or screen source that can't sustain the target, or that delivers variable-rate frames.

So the writer can legitimately be producing content whose true cadence differs from the nominal target, and "what `r_frame_rate` *should* the file declare?" is a real question, not a constant to hardcode. That needs investigation across the capture → metronome → writer path. The investigation is **self-contained**: it does not fundamentally change Task 2 or Task 4 (Task 4 already assumes header-only validation can't catch fps issues — see its note), so we keep the investigation inside this task and do it when we reach it.

## Investigation phase (run when this task starts)

- Read the prior cadence/fps work: `tasks-done/task-2026-05-11-21-output-frame-cadence-rework.md` and `task-2026-05-14-20-60fps-recording.md`, plus the `RecordingActor` timing. **Note:** `app/LoomClone/CLAUDE.md` still describes the metronome as a "30fps emit loop" — that's **stale** since the 60fps work; the rate is configurable via the `FrameRate` enum (`targetFrameRate`, default 30, set in `RecordingActor+Prepare.swift`). Don't be misled by it.
- Reproduce and survey: `ffprobe init.mp4` on recent recordings at both 30 and 60 target FPS; grep existing recordings on the server for the `r_frame_rate` vs `targetFPS` mismatch (the #40 comment expects it even on short, successfully-processed recordings).
- Pin down **where** the wrong declaration is written. Start at `WriterActor`'s `AVAssetWriterInput` configuration and the fMP4 media/track timescale (the metronome PTS is already correct — see above, don't re-litigate it). Then decide **how** `chosen-FPS × source-capable-FPS` should map to the declared rate (fixed CFR matching target? honest VFR signalling? clamp to source capability?).
- Decide the correct fix in light of the source-capability complexity before writing code.

## The two-sided fix

### (a) macOS — write correct frame-rate metadata

Based on the investigation, configure the HLS writer so the fMP4 segments (and therefore the stitched `source.mp4`) declare a frame rate consistent with the actual content — correct across the 30/60 settings and the source-capability edge cases. Fixes the problem at the source for all **future** recordings.

### (b) Server — defensive encode robust to wrong/VFR input

Independent of (a), and the **only** way to get correct derivatives from existing recordings whose bad metadata is already baked into their on-disk HLS/`source.mp4`:

- **Variant encode** (`generateVariants` in `derivatives.ts`, ~`:600`): add explicit frame-mode handling so libx264 doesn't collide DTS on a mis-declared or VFR input. **Default to `-fps_mode passthrough`** (honour the source PTS, let the muxer use them) — do **not** blindly force `-r 60`, which would duplicate frames on a genuinely-30fps recording. Only force a CFR `-r` if the investigation establishes the file should be CFR at a known rate.
- **Storyboard** (`storyboard.ts`): **verify there's actually a problem first** (see the corrected Consequences note — current cue mapping is time/PTS-based and the incident PTS are correct, so this is probably already fine). If reproduction shows a real mistiming, fix the cue mapping to derive from measured PTS; otherwise leave it and record that it was checked.

This makes the server produce correct derivatives **regardless of input metadata** — corrective for the existing library and defensive going forward.

## Relationship to Task 4

- Task 4's reprocessing of existing videos only yields *correct* derivatives once (b) exists — so **this task precedes Task 4**.
- Task 4's `isProbablyPlayable` check is header-only (no decode) and will **not** detect the fps/DTS problem (it only shows on full decode). That limitation is recorded in Task 4. Optionally, this task can add a cheap **fps-sanity heuristic** — compare declared `r_frame_rate` against `avg_frame_rate` (or `nb_frames ÷ duration`) and flag a gross mismatch — that Task 4's validation could adopt. Decide during implementation.

## Verification

- New recordings at 30 and 60 target FPS declare a correct `r_frame_rate`. Verify with a **full decode**: `ffmpeg -i source.mp4 -f null -` no longer spams non-monotonic-DTS errors. (Note: `-c copy -f null -` does **not** decode and so won't surface DTS problems — use the full-decode form.)
- Variants re-encoded from a known-bad-metadata source (e.g. the retained `8c755ccf` `source.mp4`) decode cleanly and play without stutter.
- Storyboard: confirmed correct on a 60 fps recording — either because reproduction showed it was never broken (expected), or after the cue-mapping fix if one proved necessary.
