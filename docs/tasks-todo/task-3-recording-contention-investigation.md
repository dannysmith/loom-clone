# Task 3: Recording contention / CMIO-corruption investigation & fix

https://github.com/dannysmith/loom-clone/issues/30 (primary)
https://github.com/dannysmith/loom-clone/issues/44 (parent)

Third of four tasks from #44. This is the one that tries to make the failure **stop happening**, rather than just making it visible (tasks 1–2). It is a **driver for the existing #30 investigation**, not a fresh one — #30 already holds the hypotheses, the repro strategy, three captured reproductions, and a definition of done. This doc owns the execution; it does not re-litigate the analysis. Read #30 in full first.

**Depends on task 1.** #30 has been blocked on one thing repeatedly: every reproduction surfaces only the generic top-level error (`-11800 AVErrorUnknown`), never the underlying VideoToolbox/CMIO code that would discriminate the hypotheses. Task 1 Part 2 (walk the `NSUnderlyingError` chain) and task 1 Part 1 (extract the Apple CMIO logs per recording) are exactly the missing instruments. Do not start task 3 until they've landed — otherwise we're investigating blind again, which is what stalled #30 three times.

## The two competing hypotheses (from #30)

1. **H.264 engine contention.** M2 Pro has a single hardware H.264 encoder. The composited HLS writer and the raw camera writer (`camera.mp4`) run two concurrent H.264 sessions. Under load (1440p composite + 1080p raw camera) the engine may intermittently go over budget → raw writer enters `.failed`. This was the original most-likely hypothesis.

2. **Camera-source CMIO corruption.** The 2026-06-03 reproduction **undercuts hypothesis 1**: it fired at **720p** raw camera (the shape the validation table said "fits within engine headroom"), with only composited-1080p + raw-camera-720p H.264 sessions — and still failed. It co-occurred with a continuous CMIO `-12743` synchronizer meltdown at the **source** (`RepeatPreviousFrame CreateRetimedSampleBuffer failed -12743`), plus `monoRejects 81`, `neg 10`, `noSrc 1076` — i.e. the camera's own CMIO retiming fell over and fed non-monotonic garbage that the raw `AVAssetWriter` rejected. If this is the dominant cause, the hypothesis-1 remediations (cap/relocate the raw camera writer) **won't help**, because the input is already corrupt upstream of the writer.

These are not mutually exclusive — it's plausible both occur, on different rigs (HDMI/Cam Link 1080p vs ZV-1-direct UVC 720p). The investigation's first job is to **determine which dominates on the current real-world setup.**

## Investigation plan

### Step 0 — confirm the instruments (inherited from task 1)

Before reproducing, verify on a *deliberately* triggered failure that: (a) the `raw.writer.failed` event now carries the underlying domain/code, not just `-11800`; and (b) the per-recording CMIO log dump captures the `-12743` flood with timestamps that line up with the recording timeline. If either is missing, fix it here before going further — the whole task depends on these reading true.

### Step 1 — correlate, don't guess

For each available reproduction (the archived #30 sessions + any new ones), line up three timelines: the `raw.writer.failed` events (`recording.json`), the metronome reject/no-source spikes (`diagnostics.json` periodic snapshots), and the CMIO `-12743` flood (task-1 log dump). The discriminating question #30 already framed:

> Does `raw.writer.failed` reliably co-occur with `-12743` floods + negative-PTS source frames?

- **If yes** → hypothesis 2 (source corruption) dominates. The lever is **source-side**: handling the UVC camera's bad sample buffers (drop non-monotonic source buffers before the raw writer; investigate whether a different capture configuration / format selection avoids the synchronizer meltdown). Encoder-contention remediations are a dead end for this case.
- **If no** (failures occur without a source flood, correlated instead with thermal/load) → hypothesis 1 (engine contention). The lever is the **second H.264 session** (below).

### Step 2 — reproduce deliberately

Use #30's repro strategy. Two distinct rigs, because they may exercise different hypotheses:
- **Contention rig:** composited 1440p + raw camera forced to 1080p + long duration (≥5 min) + mode-switch flurries; push thermals (concurrent GPU/compile load) if it won't repro clean.
- **Source-corruption rig:** ZV-1 direct over UVC (the flaky 720p shape) — #30 notes this may be the *faster* path to a clean repro than thermal stress, since the `-12743` meltdown is the trigger.

Record from the **production build run directly from Finder**, not from Xcode — per #3's resolution and the `AGENTS.md` note, Xcode's console back-pressure is itself a frame-drop cause and would contaminate the experiment.

## Candidate remediations (decide after the diagnosis, not before)

**If hypothesis 1 (contention) confirmed** — #30 lists these in least→most invasive order:
- Lower raw camera H.264 bitrate (12 → 8 Mbps); masters are safety-net quality.
- Cap raw camera writer resolution (e.g. clamp to 720p height regardless of native).
- **Move the raw camera writer off H.264 to ProRes** (mirroring what `screen.mov` did in the 2026-04-11 encoder-contention task). Eliminates the second H.264 session entirely; ProRes is intra-only so a mid-recording failure yields a *playable* truncated file rather than a broken-moov unplayable one. Costs ~7× storage (relates to #33 local-recordings cleanup UI). Plus a resolution cap so we never write upscaled content (the Cam Link silently upscales — #30).

**If hypothesis 2 (source corruption) confirmed:**
- Drop non-monotonic / negative-delta source sample buffers before they reach the raw camera writer (the writer rejects them anyway and dies; pre-filtering keeps it alive with a clean truncation instead).
- Investigate capture-format choices that avoid the synchronizer meltdown for UVC cameras (format/rate selection in `CameraCaptureManager.bestFormat()` — relates to the rate-lock bug #34, now closed, and the VFR truth in project memory).
- Accept-and-document if there's no app-side mitigation for a fundamentally misbehaving UVC driver — but only after task 1's logs prove it's driver-level.

**Reducing pressure (orthogonal, from #44).** The biggest known lever is already documented (don't record from Xcode). Within the app, the second H.264 session is the main contention surface (above). Previews are already torn down during recording, so there's less easy headroom there than it might seem.

## Definition of done (inherits #30's)

- A clean reproduction with the **underlying** (not `-11800`) error code captured in `recording.json`, and the CMIO log dump correlated against it.
- A determination of which hypothesis dominates on the current setup, written up.
- **Either** a code change that eliminates the failure under stress (with a re-run confirming it), **or** a documented decision that the current trade-off is acceptable, noted in `docs/archive/m2-pro-video-pipeline-failures.md`.
- Update `docs/developer/recording-pipeline.md` and the raw-writers section if the writer shape changes (e.g. raw camera → ProRes).

## Out of scope

- Live warnings (task 2 — already shipped by the time this runs; this task should *reduce how often they fire*).
- Mid-recording source switching / device re-attach (#18).
- Object-storage / R2 changes (#4).

## Files likely touched (depends on diagnosis)

| Concern | File |
|---|---|
| Raw camera writer codec/resolution/bitrate | `Pipeline/RawStreamWriter.swift`, raw-writer config in `Pipeline/RecordingActor+Prepare.swift` |
| Source sample-buffer pre-filtering | `Pipeline/RecordingActor+FrameHandling.swift` |
| Camera format/rate selection | `Capture/CameraCaptureManager.swift` |
| Incident write-up | `docs/archive/m2-pro-video-pipeline-failures.md` |
| Doc update | `docs/developer/recording-pipeline.md` |
