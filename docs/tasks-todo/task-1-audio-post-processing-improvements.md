# Task 1: Audio Post-Processing Improvements

Tracks [issue #24](https://github.com/dannysmith/loom-clone/issues/24).

Goal: address two real defects in the current audio chain — boosted noise floor during quiet sections, and uncorrected volume drops when the speaker moves away from the mic — and ship one revised chain everyone gets.

## Context

The current chain is:

```
highpass=f=80 → arnndn=m=cb.rnnn → loudnorm I=-14:TP=-1.5:LRA=11 (two-pass, linear)
```

See `docs/developer/audio-post-processing.md` for what each step does today. Lives in `server/src/lib/derivatives.ts`, `processAudio()`.

### Why the chain misbehaves

**Noise floor amplification.** `arnndn` is a speech-quality denoiser, not a noise-floor crusher — it leaves a residual floor (typically -45 to -55 dBFS) in genuinely silent passages. `loudnorm` in `linear=true` mode then applies a single global gain to hit -14 LUFS integrated; on a quiet recording (e.g. -28 LUFS in) that gain is +14 dB and lifts the residual noise floor to -36 dBFS, which is clearly audible. The fix is structural: drive the floor down (better denoise) or eliminate it entirely (gate). Loudnorm itself is doing its job correctly.

**Mic-distance volume drops.** Two-pass `loudnorm` normalises *integrated* loudness, not local. If the speaker leans away from the mic for 30 s and drops 8 dB, those 30 s stay 8 dB quieter in the output. This is by design — `loudnorm` is wrong tool for the job. The classical fix is `dynaudnorm` (frame-by-frame moving-window leveling), which the previous task design rejected because it raises the noise floor before denoise. That rationale changes once a gate is in front of it: with a gate, there is no noise floor in non-speech regions for `dynaudnorm` to lift.

## Design

### Revised chain

```
highpass=f=80
  → arnndn=m=cb.rnnn
  → afftdn=nf=<profiled>:nr=12
  → agate=threshold=0.0056:ratio=10:attack=5:release=300:knee=2.5
  → dynaudnorm=f=500:g=11:m=10:p=0.95:r=0
  → loudnorm=I=-14:TP=-1.5:LRA=11        (two-pass; linear=true on pass 2)
```

Order is part of the design:

1. `highpass` first so nothing else wastes cycles on infrasound.
2. `arnndn` second — primary speech denoiser, RNN-trained.
3. `afftdn` third — supplementary stationary-noise cleanup. Runs *after* `arnndn` so its noise model isn't poisoned by transient noise `arnndn` is about to handle.
4. `agate` fourth — gates the *cleaned* signal, so threshold can sit well below speech without clipping word ends.
5. `dynaudnorm` fifth — only ever sees gated regions, so it never amplifies noise. Boosts quiet-mic sections back up.
6. `loudnorm` last — sets the global -14 LUFS target on the final, leveled signal.

### Parameters

| Filter | Setting | Rationale |
| --- | --- | --- |
| `highpass` | `f=80` | Unchanged. Below lowest male fundamental (~85 Hz), removes HVAC/desk rumble. |
| `arnndn` | `m=cb.rnnn` | Unchanged. Conjoined-burgers model, best general purpose. |
| `afftdn` | `nf=<profiled>:nr=12` | `nf` profiled per recording (see below). 12 dB attenuation — conservative; avoids "underwater" artefacts on speech. |
| `agate` | `threshold=0.0056` (-45 dBFS) | Comfortably below typical speech (-15 to -25 dBFS), above post-denoise floor. |
|  | `ratio=10` | Effectively a switch — gate is closed or open, not a compressor. |
|  | `attack=5 ms` | Fast enough to open on the first phoneme without clipping the start. |
|  | `release=300 ms` | Long enough that syllable tails fade naturally; short enough that pauses gate cleanly. |
|  | `knee=2.5 dB` (soft) | Avoids brick-wall click-on/off feel — speech tails fade rather than cut. |
| `dynaudnorm` | `f=500` | 500 ms frame length — default. |
|  | `g=11` | Gaussian smoothing across 11 frames = ~5 s window. **This is the lever for "how fast does it react when I move away from the mic."** Default of 31 (~15 s) is too slow for that case. |
|  | `m=10` | Max gain factor 10× (= +20 dB ceiling). Enough to recover a typical 8-12 dB Yeti-distance drop. |
|  | `p=0.95` | Default peak target. |
|  | `r=0` | Peak-based (default), not RMS — more responsive for speech. |
| `loudnorm` | unchanged | Two-pass, linear=true on pass 2, target -14/-1.5/11. |

### Profiled `afftdn` noise floor

A short pre-pass before `loudnorm` pass 1 estimates the recording's actual noise floor and feeds it into `afftdn` as `nf=`. The pipeline already detects silent regions for `suggested-edits.json`; we extend that.

Algorithm:

1. From the existing `runSilenceDetect` result, take the longest silence ≥ 1 s.
2. If no qualifying silence, fall back to `nf=-50`.
3. Otherwise: spawn ffmpeg with `-ss <start> -t <min(2.0, length)>` and `-af volumedetect`. Parse the `mean_volume:` line from stderr. That value (in dBFS) is the noise floor estimate. Round to the nearest integer dB and inject as `nf=`.
4. Clamp the result to `[-65, -30]` so a malformed measurement can't produce nonsense filter settings.

The profile pass adds one short ffmpeg call (~100 ms typical) before pass 1. Cheap relative to the two existing passes.

If silence detection didn't run (e.g. duration < 5 s), fall back to `nf=-50`.

### What this means for the existing pipeline

- `processAudio()` in `derivatives.ts` grows from 2 ffmpeg invocations to 3 (profile, pass 1, pass 2).
- `audioFilterChain()` must accept the profiled `nf` value. Easiest: pass it in as a parameter; rebuild the chain string per-call.
- Pre-loudnorm silence detection already runs before `processAudio` — pass the existing `Silence[]` into `processAudio` so we don't run silencedetect twice.
- All other steps (thumbnails, metadata, variants, storyboard, peaks, suggested-edits) unchanged.
- AAC 160 kbps re-encode unchanged.

### Performance expectation

Current cost: ~88× realtime. New chain: rough estimate 25-35× realtime (more filters, mostly cheap, plus the extra profile pass). For a 30-min recording: ~60-75 s of audio processing. Still negligible compared to variant encoding.

## A/B bench tool

`server/scripts/audio-bench.ts` — committed but not wired into CI.

Inputs:
- One real input file (path arg), **or**
- `--synthetic` flag generates a fixture: clean TTS-style speech (use ffmpeg `aevalsrc` or a checked-in WAV) + injected white noise at a known dB level + a programmed amplitude swing (-8 dB for 15 s in the middle) to simulate moving away from the mic.

Behaviour:

1. Run a list of named chain variants (baseline = today's chain; candidate = new chain; plus interesting subsets like "gate only", "dynaudnorm only").
2. Write `out-<name>.mp4` next to the input.
3. For each output, compute and report:
   - Integrated LUFS (loudnorm measure pass).
   - True peak (loudnorm).
   - **P10 noise-floor estimate**: short-window RMS in detected silent regions, 10th percentile.
   - **Speech dynamic range**: P90 − P10 of short-window RMS in detected speech regions.
   - Wall-clock processing time.
4. Print a tidy table to stdout. Optionally write `bench-results.json` next to the outputs.

Throwaway-quality code. No tests. Stays in `server/scripts/` so it's available for future retuning.

## Tests

Extend `server/src/lib/__tests__/audio-processing.test.ts`:

- **Existing LUFS test** stays — verifies the new chain still hits -14 LUFS ±1 LU.
- **Noise floor test**: synthetic fixture with 10 s of speech-band tone followed by 5 s of white noise at -45 dBFS. After processing, the silent-region P10 RMS must be below -65 dBFS. Confirms the gate is doing its job.
- **Dynamic-range compression test**: synthetic fixture with two speech segments at different amplitudes (e.g. 0 dB and -8 dB). After processing, the RMS difference between segments must be ≤ 3 dB. Confirms `dynaudnorm` is leveling.
- **Idempotency** test stays as-is.

All gated on `Bun.which("ffmpeg") !== null`.

Synthetic fixture generation: ffmpeg `lavfi` with `sine`, `aevalsrc`, `anoisesrc` in concat — keep fixtures generated at test time, not checked in.

## Docs

Rewrite `docs/developer/audio-post-processing.md`:

- New chain diagram + per-filter rationale.
- The parameter table from above.
- Profiled-`afftdn` mechanism (with the silence-source dependency called out).
- Bench tool usage.
- Updated performance numbers.

## Out of scope

- Per-recording adaptive chains (different presets for Yeti vs MacBook built-in vs noisy environment). Decided against — one tuned chain for everyone.
- Mac-side audio preprocessing (AVAudioSession voice processing modes, system voice isolation). Recording stays raw; all processing is server-side.
- De-essing, plosive handling, or pitch correction. Not on the table.
- Whisper/transcript-driven gate decisions. The energy-based gate is sufficient.
- Listening-test iteration loop before v1 ships. Tune against synthetic fixtures, ship, iterate from real-world feedback.

## Definition of done

- `processAudio()` runs the new chain end-to-end on a representative recording without errors.
- All three audio tests pass.
- `bun run check && bun run typecheck && bun test` clean.
- `audio-post-processing.md` reflects the new chain.
- `audio-bench.ts` exists and runs against an input file with at least baseline + candidate variants.
- Branch pushed. No PR.
