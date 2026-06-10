# macOS App — Agent Notes

For the full narrative walkthrough of the recording pipeline (actors, timing, mode switching, pause/resume, GPU recovery), see `docs/developer/recording-pipeline.md` at the repo root. This file covers tooling, quick-reference notes, and gotchas specific to working in this directory.

## Developer tooling

- **SwiftLint** runs as a post-compile build phase on every Xcode build. Config is at `app/.swiftlint.yml`. Run manually with `cd app && swiftlint lint` or auto-fix with `swiftlint --fix`.
- **SwiftFormat** config is at `app/.swiftformat`. Run with `cd app && swiftformat .` to format all files. Run before committing Swift changes.
- **Strict concurrency** is set to `complete` and **warnings are treated as errors** (`SWIFT_TREAT_WARNINGS_AS_ERRORS`). New code must be concurrency-safe — no `@unchecked Sendable` without justification.
- Both tools are installed via Homebrew (`brew install swiftlint swiftformat`).
- **xcode-build-server** bridges SourceKit-LSP with the Xcode project so cross-file type resolution works. Config is at `app/buildServer.json` (gitignored, machine-specific). Regenerate with `cd app && xcode-build-server config -project LoomClone.xcodeproj -scheme LoomClone`. The LSP index updates on build, so rebuild after significant changes.

## Recording pipeline

Four actors, each owning one concern:

- **RecordingActor** — orchestrates everything. Owns the metronome (emit loop at the target rate, 30 or 60fps), the camera frame queue, the recording clock anchor, pause/resume state. Entry point for all capture callbacks. Split across extensions: `+Metronome` (drift-corrected emit loop), `+FrameHandling` (capture callbacks, PTS retiming, metronome frame emission), `+CompositionRecovery` (GPU failure handling and terminal escalation).
- **CompositionActor** — Metal/CIContext rendering. Takes a screen buffer + camera buffer + mode, returns a composited pixel buffer. Stateless between frames except for the CIContext itself.
- **WriterActor** — AVAssetWriter in HLS fMP4 mode. Receives composited video + audio, cuts segments, reports them back for upload. Owns the AAC timestamp adjuster (priming offset + pause accumulator).
- **UploadActor** — streams segments to the server during recording, retries on failure, hands off to HealAgent for post-stop recovery.

## Two-phase start

Recording start is split into `prepareRecording` (slow: hardware init, server session creation, waiting for first audio sample) and `commitRecording` (fast: anchor the clock, start the metronome). This lets the coordinator run a countdown in parallel with hardware bring-up. Don't collapse them into one call.

## How video frames reach the output

The metronome ticks at the target rate (30 or 60fps) but that tick is a **budget, not a contract** (post-#21 cadence rework): output rate tracks whatever the active mode's source actually delivers, so a sub-target camera produces honest VFR rather than fabricated frames. See `docs/developer/recording-pipeline.md` for the full model.

- **cameraOnly**: camera delivers frames into a bounded FIFO queue. The metronome pops one per tick and composites it. Every camera frame reaches the output in order at its native capture PTS; output cadence = the camera's real delivery rate.
- **screenAndCamera**: screen drives the cadence (latest screen frame from a single-slot cache); the most recent camera frame is peeked (without popping) as the PiP overlay. A 60fps target gives 60fps screen output even with a slower camera.
- **screenOnly**: screen drives the cadence from the screen cache. No camera involvement.

Video PTS is always the source frame's hardware capture time, not the wall clock at emit. Audio PTS is likewise the mic's hardware capture time. Both are relative to `recordingStartTime`, which is anchored to the most recent source frame's capture PTS at commit (not `CMClockGetTime`). This is what keeps A/V in sync.

## Raw writers are a safety net

Three additional writers (ProRes screen, H.264 camera, AAC audio) write raw masters to local disk at native resolution/rate. These exist so footage is never lost — if the composited HLS path fails or needs re-rendering later, the raw files are the source of truth. They are NOT the primary output; viewers watch the composited HLS segments (or the MP4 derivative the server generates from them).

## Camera format selection

`CameraCaptureManager.bestFormat(targetFPS:)` picks the highest-resolution format whose advertised rate range contains the target (30 or 60fps), matched on **rate** with a 0.5fps tolerance (`targetRateFits`) so NTSC fractional rates (29.97 / 59.94) pass. `capFrameRateIfSupported` then sets at most `activeVideoMinFrameDuration` — a **ceiling** on frame rate ("don't deliver faster than target") — and **never** `activeVideoMaxFrameDuration` (a *floor*). For discrete `min == max` ranges it uses the range's own reported duration, not `CMTime(1, fps)`, to dodge an uncatchable `NSInvalidArgumentException`.

Crucially, the ceiling is applied **only when the selected format has rate headroom** (`shouldCapRate`: the format can deliver faster *or* slower than the target). For a format **rate-locked to the target** — every advertised range ≈ target, e.g. the ZV-1's sole discrete 720p `30-30` USB format — it sets **nothing**, because on such a format setting `activeVideoMinFrameDuration` drags `activeVideoMaxFrameDuration` up to the target too (it's the only valid value), re-imposing the floor.

> **Why this shape (task 3 / #30, fixed 2026-06-09).** A floor at a rate the camera **can't sustain** triggers the CMIO `-12743` meltdown: CMIO tries to *fabricate* the missing frames, corrupting the camera capture-PTS timeline → heavy A/V desync plus a raw `camera.mp4` writer death (`-11800` → underlying `OSStatus -16364`). The **ZV-1 over USB streaming** (single discrete 720p30 format, actually delivers ~24fps) hits this; FaceTime and the Cam Link 4K do **not** — FaceTime sustains 30+, and the Cam Link's format advertises `25-60` so its floor sits at 25fps, which it meets. `#34` introduced the floor by setting both min+max unconditionally; pre-`#34` set neither for the ZV-1 (its discrete match failed the old CMTime check) and it ran clean. The same physical ZV-1 via HDMI → Cam Link 4K never melts down (the capture device self-paces honestly), confirming the trigger is the ZV-1's own UVC streaming + the floor. The cadence model (post-#21) already produces correct output from whatever the camera delivers, so a free-running camera needs no pinning. A defence-in-depth guard in `handleCameraFrame` also drops any non-monotonic camera frame before the raw writer (counted as `cameraRawFramesSkipped`), so a corrupt feed leaves `camera.mp4` truncated-but-playable rather than dead. See #30 / #44 and `docs/developer/recording-pipeline.md`.
