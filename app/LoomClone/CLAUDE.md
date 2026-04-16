# macOS App — Agent Notes

## Developer tooling

- **SwiftLint** runs as a post-compile build phase on every Xcode build. Config is at `app/.swiftlint.yml`. Run manually with `cd app && swiftlint lint` or auto-fix with `swiftlint --fix`.
- **SwiftFormat** config is at `app/.swiftformat`. Run with `cd app && swiftformat .` to format all files. Run before committing Swift changes.
- **Strict concurrency** is set to `complete` and **warnings are treated as errors** (`SWIFT_TREAT_WARNINGS_AS_ERRORS`). New code must be concurrency-safe — no `@unchecked Sendable` without justification.
- Both tools are installed via Homebrew (`brew install swiftlint swiftformat`).
- **xcode-build-server** bridges SourceKit-LSP with the Xcode project so cross-file type resolution works. Config is at `app/buildServer.json` (gitignored, machine-specific). Regenerate with `cd app && xcode-build-server config -project LoomClone.xcodeproj -scheme LoomClone`. The LSP index updates on build, so rebuild after significant changes.

## Recording pipeline

Four actors, each owning one concern:

- **RecordingActor** — orchestrates everything. Owns the metronome (30fps emit loop), the camera frame queue, the recording clock anchor, pause/resume state. Entry point for all capture callbacks.
- **CompositionActor** — Metal/CIContext rendering. Takes a screen buffer + camera buffer + mode, returns a composited pixel buffer. Stateless between frames except for the CIContext itself.
- **WriterActor** — AVAssetWriter in HLS fMP4 mode. Receives composited video + audio, cuts segments, reports them back for upload. Owns the AAC timestamp adjuster (priming offset + pause accumulator).
- **UploadActor** — streams segments to the server during recording, retries on failure, hands off to HealAgent for post-stop recovery.

## Two-phase start

Recording start is split into `prepareRecording` (slow: hardware init, server session creation, waiting for first audio sample) and `commitRecording` (fast: anchor the clock, start the metronome). This lets the coordinator run a countdown in parallel with hardware bring-up. Don't collapse them into one call.

## How video frames reach the output

- **cameraOnly**: camera delivers frames into a bounded FIFO queue. The metronome pops one per tick and composites it. Every camera frame reaches the output in order at its native capture PTS.
- **screenAndCamera**: metronome drives at 30fps. It reads the latest screen frame (single-slot cache) and peeks the most recent camera frame from the queue (without popping) as the PiP overlay.
- **screenOnly**: metronome drives at 30fps from the screen cache. No camera involvement.

Video PTS is always the source frame's hardware capture time, not the wall clock at emit. Audio PTS is likewise the mic's hardware capture time. Both are relative to `recordingStartTime`, which is anchored to the most recent source frame's capture PTS at commit (not `CMClockGetTime`). This is what keeps A/V in sync.

## Raw writers are a safety net

Three additional writers (ProRes screen, H.264 camera, AAC audio) write raw masters to local disk at native resolution/rate. These exist so footage is never lost — if the composited HLS path fails or needs re-rendering later, the raw files are the source of truth. They are NOT the primary output; viewers watch the composited HLS segments (or the MP4 derivative the server generates from them).

## Camera format selection

`CameraCaptureManager.bestFormat()` picks the highest-resolution format that supports ≈30fps (threshold: `maxFrameRate >= 29.0` to accept NTSC 29.97). UVC cameras report fixed-rate ranges as CMTimes that don't exactly equal `1/30` — the code only sets `activeVideoMinFrameDuration` when `1/30` is strictly within the reported range, otherwise leaves the camera at its native rate. This avoids an uncatchable `NSInvalidArgumentException` from AVCaptureDevice.
