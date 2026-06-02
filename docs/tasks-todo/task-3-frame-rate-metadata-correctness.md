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

- **Variant re-encode produces broken output.** `derivatives.ts:593` runs `-vf scale=-2:H` → `libx264` with **no** `-r`/`-fps_mode`/`-vsync`, so it inherits the declared 30 fps. A full decode of the bad source yields **32,803 "non monotonically increasing dts to muxer"** errors — frames collide on the 30 fps timeline. The 720p/1080p variants would stutter or drop frames.
- **Storyboard cue times land on the wrong frames.** Storyboard frame *selection* indexes by frame number so extracts correct frames, but the WebVTT time mapping is computed from the declared rate, so cues are mistimed in playback.
- **Not a "won't play" bug.** Browsers and Vidstack are VFR-tolerant and use PTS directly, so `source.mp4` itself plays fine. The incident's "doesn't play" symptom was the OOM (no derivatives written), not this. This is a **derivative-quality** bug — it silently degrades every server-produced output.

### Correcting #40's diagnosis (important)

The issue comment proposes a "one-line fix — `AVVideoExpectedSourceFrameRateKey` set to 30 or unset." **That is wrong.** `H264Settings.swift:21` already sets `AVVideoExpectedSourceFrameRateKey: fps` with `fps` = the real target (60), and that key is only a *rate-control hint* to the encoder — it does **not** write the SPS/VUI timing that ffmpeg reads back as `r_frame_rate`. So the real cause lives elsewhere in how the writer computes frame timing/timescale (AVAssetWriter media timescale, the frame durations the writer presents, or the compositor metronome's PTS cadence), and it is **not** a one-liner. Treat the root cause as genuinely open.

## Why this is its own task

The macOS frame production rate is **not** simply "the number the user picked." It depends on:

- the user's chosen streaming/target FPS (30 vs 60), **and**
- in some circumstances the **input source's actual deliverable FPS** — a camera or screen source that can't sustain the target, or that delivers variable-rate frames.

So the writer can legitimately be producing content whose true cadence differs from the nominal target, and "what `r_frame_rate` *should* the file declare?" is a real question, not a constant to hardcode. That needs investigation across the capture → metronome → writer path. The investigation is **self-contained**: it does not fundamentally change Task 2 or Task 4 (Task 4 already assumes header-only validation can't catch fps issues — see its note), so we keep the investigation inside this task and do it when we reach it.

## Investigation phase (run when this task starts)

- Read the prior cadence/fps work: `tasks-done/task-2026-05-11-21-output-frame-cadence-rework.md` and `task-2026-05-14-20-60fps-recording.md`, plus the compositor metronome and `RecordingActor` timing.
- Reproduce and survey: `ffprobe init.mp4` on recent recordings at both 30 and 60 target FPS; grep existing recordings on the server for the `r_frame_rate` vs `targetFPS` mismatch (the #40 comment expects it even on short, successfully-processed recordings).
- Pin down **where** the wrong declaration is written — AVAssetWriter media timescale, the presented frame durations, or the metronome PTS cadence — and **how** `chosen-FPS × source-capable-FPS` should map to the declared rate (fixed CFR matching target? honest VFR signalling? clamp to source capability?).
- Decide the correct fix in light of the source-capability complexity before writing code.

## The two-sided fix

### (a) macOS — write correct frame-rate metadata

Based on the investigation, configure the HLS writer so the fMP4 segments (and therefore the stitched `source.mp4`) declare a frame rate consistent with the actual content — correct across the 30/60 settings and the source-capability edge cases. Fixes the problem at the source for all **future** recordings.

### (b) Server — defensive encode robust to wrong/VFR input

Independent of (a), and the **only** way to get correct derivatives from existing recordings whose bad metadata is already baked into their on-disk HLS/`source.mp4`:

- **Variant encode** (`derivatives.ts:593`): add explicit `-fps_mode`/`-r`/`-vsync` handling so libx264 doesn't collide DTS on a mis-declared or VFR input.
- **Storyboard** (`storyboard.ts`): ensure cue-time mapping derives from actual PTS / measured fps, not the declared rate.

This makes the server produce correct derivatives **regardless of input metadata** — corrective for the existing library and defensive going forward.

## Relationship to Task 4

- Task 4's reprocessing of existing videos only yields *correct* derivatives once (b) exists — so **this task precedes Task 4**.
- Task 4's `isProbablyPlayable` check is header-only (no decode) and will **not** detect the fps/DTS problem (it only shows on full decode). That limitation is recorded in Task 4. Optionally, this task can add a cheap **fps-sanity heuristic** — compare declared `r_frame_rate` against `avg_frame_rate` (or `nb_frames ÷ duration`) and flag a gross mismatch — that Task 4's validation could adopt. Decide during implementation.

## Verification

- New recordings at 30 and 60 target FPS declare a correct `r_frame_rate`; `ffmpeg -i source.mp4 -c copy -f null -` stays clean **and** a full `-f null -` decode no longer spams non-monotonic-DTS errors.
- Variants re-encoded from a known-bad-metadata source (e.g. the retained `8c755ccf` `source.mp4`) decode cleanly and play without stutter.
- Storyboard cue times align with the correct frames on a 60 fps recording.
