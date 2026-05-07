# Audio Post-Processing

How the server processes audio in recorded and uploaded videos. Runs as part of the [derivatives pipeline](streaming-and-healing.md#derivatives) after `source.mp4` is stitched, before thumbnails and metadata extraction.

## The chain

```
highpass=f=80 → arnndn=m=cb.rnnn → loudnorm (two-pass, -14 LUFS)
```

Three filters in series. Video track is copied untouched; only the audio is re-encoded (AAC, 160 kbps, 48 kHz).

### highpass=f=80

Second-order Butterworth at 80 Hz. Removes sub-speech rumble — HVAC hum, desk vibration, traffic, fan resonance — that the denoiser would otherwise waste cycles on. 80 Hz sits just below the lowest male fundamental (~85 Hz), so no speech content is affected.

### arnndn (RNN-based speech denoiser)

Uses the `cb.rnnn` model (conjoined-burgers) from [richardpl/arnndn-models](https://github.com/richardpl/arnndn-models). This model was trained on "Recording" signal (close-mic speech) with "General" noise, making it the best general-purpose choice for screen recording audio where the background noise is a mix of fan hum, keyboard clicks, room ambience, and other environmental sounds.

The model file (~293 KB) is bundled at `server/assets/audio-models/cb.rnnn`. The path is resolved absolutely at import time so it survives test `chdir()` calls.

The filter operates at 48 kHz internally. ffmpeg auto-resamples if the input is a different rate, but the macOS app records at 48 kHz natively so this is a no-op in practice.

Other models in the repository (`bd.rnnn` for background voice suppression, `sh.rnnn` for speech-specific noise) are available if the general model proves inadequate for a specific noise profile.

### Two-pass loudnorm

EBU R128 loudness normalisation targeting:
- **-14 LUFS** integrated loudness (YouTube/Vimeo web standard)
- **-1.5 dBTP** true peak ceiling
- **LRA 11** loudness range

Two-pass is meaningfully more accurate than single-pass for speech:

**Pass 1** runs the full chain (`highpass → arnndn → loudnorm`) with `print_format=json` and outputs to `/dev/null`. The measurement must reflect the post-denoised signal, not the original noisy audio. ffmpeg writes a JSON block to stderr with five measurement fields.

**Pass 2** feeds the measured values back as `measured_I`, `measured_TP`, `measured_LRA`, `measured_thresh`, and `offset` with `linear=true`. Linear mode preserves speech dynamics when the input is close to target, falling back to dynamic compression only when necessary.

`dynaudnorm` is deliberately excluded from the chain — it can raise the noise floor and make the denoiser's job harder, and `loudnorm` in dynamic mode already handles typical speech input.

## Skip conditions

Audio processing is silently skipped when:
- The source has no audio track (video-only uploads, test fixtures)
- The `cb.rnnn` model file is missing (logged as a clear error, not a silent fallback)

## Performance

Processing time is dominated by the two ffmpeg passes over the audio. Typical numbers on an M2 Pro:
- 8-second video: ~800ms
- 27-second video: ~2.5s

The arnndn filter runs at ~88x realtime. For a 30-minute recording, total audio processing is roughly 40 seconds — negligible compared to variant encoding.

## Where the code lives

- Pipeline wiring: `server/src/lib/derivatives.ts` (`processAudio`, `parseLoudnormJson`)
- Model file: `server/assets/audio-models/cb.rnnn`
- Model docs: `server/assets/audio-models/README.md`
- Tests: `server/src/lib/__tests__/audio-processing.test.ts`

## Silence detection (suggested edits)

The derivatives pipeline runs ffmpeg's `silencedetect` filter against the raw `source.mp4` **before** audio processing (denoise + loudnorm) and writes `derivatives/suggested-edits.json` if any silences ≥3s are found. Running on the raw audio is critical — after loudnorm the dynamic range is compressed and background noise sits at ~-25 dB, making silence indistinguishable from quiet speech. Pre-loudnorm, true silence is -50 dB or lower, so the -30 dB threshold cleanly separates pauses from speech. These pre-populate the editor with trim/cut suggestions the first time a video is opened. See `docs/developer/admin-editor.md` for the editor-side behaviour, and `server/src/lib/suggested-edits.ts` for the silence thresholds and lifecycle rules.
