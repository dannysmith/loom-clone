# Audio Post-Processing

How the server processes audio in recorded and uploaded videos. Runs as part of the [derivatives pipeline](streaming-and-healing.md#derivatives) after `source.mp4` is stitched, before thumbnails and metadata extraction.

## The chain

```
highpass=f=80
  → arnndn=m=cb.rnnn
  → afftdn=nf=<profiled>:nr=12
  → agate=threshold=0.0056:ratio=10:attack=5:release=300:knee=2.5
  → dynaudnorm=f=500:g=11:m=10:p=0.95
  → loudnorm=I=-14:TP=-1.5:LRA=11      (two-pass, linear=true on pass 2)
```

Six filters in series. Video track is copied untouched; only the audio is re-encoded (AAC, 160 kbps, 48 kHz).

Order is part of the design:

1. `highpass` first so nothing else wastes cycles on infrasound.
2. `arnndn` second — primary speech denoiser.
3. `afftdn` third — supplementary stationary-noise cleanup. After `arnndn` so its noise model isn't poisoned by transients `arnndn` is about to handle.
4. `agate` fourth — gates the *cleaned* signal, so the threshold can sit well below speech without clipping word ends.
5. `dynaudnorm` fifth — only ever sees gated regions, so it never amplifies noise. Recovers volume drops when the speaker moves away from the mic.
6. `loudnorm` last — sets the global -14 LUFS target on the final, leveled signal.

### highpass=f=80

Second-order Butterworth at 80 Hz. Removes sub-speech rumble — HVAC hum, desk vibration, traffic, fan resonance — that downstream filters would otherwise waste cycles on. 80 Hz sits just below the lowest male fundamental (~85 Hz), so no speech content is affected.

### arnndn (RNN-based speech denoiser)

Uses the `cb.rnnn` model (conjoined-burgers) from [richardpl/arnndn-models](https://github.com/richardpl/arnndn-models). This model was trained on "Recording" signal (close-mic speech) with "General" noise, making it the best general-purpose choice for screen recording audio where the background noise is a mix of fan hum, keyboard clicks, room ambience, and other environmental sounds.

The model file (~293 KB) is bundled at `server/assets/audio-models/cb.rnnn`. The path is resolved absolutely at import time so it survives test `chdir()` calls.

The filter operates at 48 kHz internally. ffmpeg auto-resamples if the input is a different rate, but the macOS app records at 48 kHz natively so this is a no-op in practice.

Other models in the repository (`bd.rnnn` for background voice suppression, `sh.rnnn` for speech-specific noise) are available if the general model proves inadequate for a specific noise profile.

### afftdn (FFT-based stationary noise reduction)

Spectral subtraction denoiser. Complements `arnndn` by attacking *stationary* noise — fan hum, mic hiss, AC drone — that an RNN trained on dynamic noise leaves alone. `nr=12` attenuates noise components by 12 dB; `nf` is the noise-floor estimate (in dB) below which the filter treats spectral content as noise.

`nf` is **profiled per recording**: see [Profiled noise floor](#profiled-noise-floor) below.

### agate (noise gate)

Hard-floors anything below -45 dBFS (linear `threshold=0.0056`) during non-speech sections. This is the structural fix for the "noise gets boosted because speech is quiet" problem — `loudnorm`'s global gain can no longer lift a residual noise floor because there *is* no noise floor in gated regions.

Parameters:

- `ratio=10` — effectively a switch (closed or open), not a compressor.
- `attack=5` ms — opens fast enough not to clip the start of a phoneme.
- `release=300` ms — long enough that syllable tails fade naturally; short enough that pauses gate cleanly.
- `knee=2.5` dB (soft) — avoids a brick-wall click-on/off feel.

Threshold is tuned for post-denoise audio. It assumes `arnndn` + `afftdn` have already pulled the noise floor below -45 dBFS in non-speech regions; on raw audio this would clip quiet speech. Order matters.

### dynaudnorm (local volume leveling)

Frame-by-frame moving-window leveler. Recovers volume drops when the speaker moves away from the mic — `loudnorm`'s integrated normalization can't, by design (it normalizes the whole-file LUFS, not local sections).

Parameters:

- `f=500` ms — frame length.
- `g=11` — Gaussian smoothing across 11 frames = ~5 s window. **The lever for "how fast does it react when I move away from the mic."** Default of 31 (~15 s) is too slow for that case.
- `m=10` — max gain factor 10× (= +20 dB ceiling). Enough to recover a typical 8-12 dB Yeti-distance drop.
- `p=0.95` — peak target (default).
- `r=0` — peak-based, not RMS (default; more responsive for speech).

The earlier design rejected `dynaudnorm` because it raises the noise floor before denoise. That rationale doesn't apply here: with `agate` in front, there is no noise floor in non-speech regions for `dynaudnorm` to amplify.

### Two-pass loudnorm

EBU R128 loudness normalisation targeting:
- **-14 LUFS** integrated loudness (YouTube/Vimeo web standard)
- **-1.5 dBTP** true peak ceiling
- **LRA 11** loudness range

Two-pass is meaningfully more accurate than single-pass for speech:

**Pass 1** runs the full chain (`highpass → arnndn → afftdn → agate → dynaudnorm → loudnorm`) with `print_format=json` and outputs to `/dev/null`. The measurement must reflect the post-processed signal, not the original. ffmpeg writes a JSON block to stderr with five measurement fields.

**Pass 2** feeds the measured values back as `measured_I`, `measured_TP`, `measured_LRA`, `measured_thresh`, and `offset` with `linear=true`. Linear mode preserves speech dynamics when the input is close to target, falling back to dynamic compression only when necessary.

## Profiled noise floor

`afftdn`'s `nf` parameter — the dB threshold below which spectral content is treated as noise — is estimated per recording before pass 1 runs.

The pipeline already detects silent regions for [suggested edits](admin-editor.md). `processAudio()` reuses that result:

1. From the silences passed in, pick the longest one ≥ 1 s.
2. Spawn ffmpeg with `-ss <start> -t <min(2.0, length)>` and `-af volumedetect`.
3. Parse `mean_volume:` from stderr — that value (in dBFS) is the noise floor estimate.
4. Round to the nearest integer and clamp to `[-65, -30]` so a malformed measurement can't produce nonsense filter settings.

Falls back to `nf=-50` if:

- No silence ≥ 1 s is available (very short recordings, or no detected silences).
- ffmpeg is missing.
- `volumedetect` fails or its output is malformed.

The profile pass adds one short ffmpeg call (~100 ms typical) before pass 1.

## Skip conditions

Audio processing is silently skipped when:
- The source has no audio track (video-only uploads, test fixtures).
- The `cb.rnnn` model file is missing (logged as a clear error, not a silent fallback).

## Performance

Three ffmpeg invocations per recording: profile pass + loudnorm pass 1 + loudnorm pass 2. Typical numbers on an M2 Pro:

- 8-second video: ~1.5 s
- 27-second video: ~5 s

Roughly 25-35× realtime on the new chain (vs ~88× on the prior chain). For a 30-minute recording, total audio processing is roughly 60-75 s — still negligible compared to variant encoding.

## A/B bench tool

`server/scripts/audio-bench.ts` runs multiple labelled chain variants against a single input and reports per-output integrated LUFS, true peak, P10 noise floor in silent regions, and P90-P10 dynamic range in speech regions. Useful for retuning parameters or validating chain changes without going through the production pipeline.

```sh
# Real recording:
bun run audio:bench path/to/source.mp4

# Synthetic fixture (tone-noise-tone-noise-tone with an 8 dB amplitude swing):
bun run audio:bench --synthetic
```

Outputs land in a `bench-<basename>/` directory next to the input — one `out-<chain>.mp4` per variant plus `bench-results.json`. The synthetic variant generates `bench-synthetic.mp4` in the current directory.

## Where the code lives

- Pipeline wiring: `server/src/lib/derivatives.ts` (`processAudio`, `profileNoiseFloor`, `audioFilterChain`, `parseLoudnormJson`).
- Model file: `server/assets/audio-models/cb.rnnn`.
- Model docs: `server/assets/audio-models/README.md`.
- Tests: `server/src/lib/__tests__/audio-processing.test.ts`.
- Bench tool: `server/scripts/audio-bench.ts`.

## Silence detection (suggested edits)

The derivatives pipeline runs ffmpeg's `silencedetect` filter against the raw `source.mp4` **before** audio processing and writes `derivatives/suggested-edits.json` if any silences ≥ 3 s are found. Running on the raw audio is critical — after the chain runs, the gate has driven non-speech regions below the silence threshold and the dynamic range is compressed, making silence indistinguishable from quiet speech. Pre-processing, true silence is -50 dB or lower, so the -30 dB threshold cleanly separates pauses from speech. These pre-populate the editor with trim/cut suggestions the first time a video is opened.

The same `silencedetect` result also feeds the `afftdn` noise-floor profile (see [Profiled noise floor](#profiled-noise-floor)). One detection pass, two consumers.

See `docs/developer/admin-editor.md` for the editor-side behaviour, and `server/src/lib/suggested-edits.ts` for the silence thresholds and lifecycle rules.
