# Research: macOS Recording APIs & Desktop App Feasibility

## Priority

Tier 1 — This is the highest-risk area of the project. The answers here determine whether the core desktop app concept is feasible as described.

## Context

We're building a native macOS desktop app (Swift, not Electron/Tauri) that records video from camera, screen, and microphone — with the ability to switch between modes mid-recording and composite a picture-in-picture camera overlay onto screen recordings in real-time. Read `requirements.md` for full project context, particularly the "Recording Requirements (Desktop App)" section.

This is the most novel part of the project. Server-side video hosting is well-trodden ground. The question is: can we build the recording experience we want using native macOS APIs, and what does that look like in practice?

## Key Questions

### Core Capture APIs

- What is **ScreenCaptureKit** and what does it offer? When was it introduced, what macOS versions support it, and what are its capabilities and limitations compared to the older CGDisplayStream/AVCaptureScreenInput approaches?
- How does **AVCaptureSession** work for camera and microphone capture? Can we run screen capture and camera capture simultaneously?
- Can we capture **screen + camera + microphone** as three independent streams and composite them in real-time? What's the performance overhead?
- What APIs handle **audio capture**? AVAudioEngine vs AVCaptureAudioDataOutput? What about system audio capture (not required initially, but worth understanding)?

### PiP Compositing

- How do we composite a camera feed overlay onto a screen recording in real-time? Is this done at the capture level, or do we need a separate compositing pipeline (e.g. AVMutableComposition, CIFilter, Metal)?
- What's the performance cost of real-time compositing? Can we do it without dropping frames?
- Can we move/resize the PiP overlay during recording?

### Mode Switching

- Can we switch between recording modes (camera-only → screen+camera → screen-only) mid-recording **without** stopping and restarting the capture session?
- If we need to reconfigure AVCaptureSession mid-recording, what happens? Does it cause a gap in the output?
- What's the most reliable approach: single flexible pipeline that reconfigures, or multiple pipelines that we switch between?
- Can we write all modes into a single continuous output file, or do we end up with segments that need stitching?

### Output Format

- What output formats can we write to directly from capture? Can we write HLS segments (.ts files with .m3u8 playlist) directly from the capture pipeline, or do we need to write to a container (MOV/MP4) and segment separately?
- What's **AVAssetWriter** and how does it work for real-time writing from capture sessions?
- Can we use AVAssetWriter to produce fragmented MP4 (fMP4) or MPEG-TS segments suitable for HLS?

### Pause/Resume

- How do we implement pause/resume in the recording? Do we stop writing and restart, or manipulate timestamps?
- Does pause/resume interact well with mode switching?

### Swift Ecosystem & Developer Experience

- What's the state of Swift for media-heavy applications? Are there mature libraries or frameworks beyond Apple's own?
- What does a menu bar app architecture look like in Swift? SwiftUI vs AppKit for the UI layer?
- What are the distribution options? Direct distribution (DMG/ZIP + notarisation) vs Mac App Store? Are there sandbox restrictions that affect screen recording or camera access?
- What macOS permissions are required (Screen Recording, Camera, Microphone) and how does the permission UX flow work?

### On-Device Transcription (side note)

While researching macOS media APIs, note what's available for on-device speech recognition and transcription. Apple's Speech framework and any Apple Intelligence transcription capabilities are worth documenting as a side consideration — we may want on-device transcription later and it's efficient to capture what's available while we're already in these APIs. This is not a key research question for this task, just "note what's there."

## Research Approach

- Start with Apple's official documentation for ScreenCaptureKit, AVFoundation, AVCaptureSession, and AVAssetWriter.
- Look for WWDC session videos/transcripts about ScreenCaptureKit (introduced WWDC 2022) and any updates in subsequent years.
- Search for open-source Swift projects that do screen recording, camera capture, or real-time compositing. Examine how they handle the capture pipeline.
- Look at how Cap's desktop app (Tauri + Rust) interfaces with macOS capture APIs — see `~/dev/Cap/` for the codebase. Their Rust code likely uses the Objective-C bridge to these same APIs.
- Search for any technical blog posts or articles about building screen recorders on macOS with Swift.
- If possible, find example code for real-time PiP compositing during screen capture.

## Expected Output

A research document that:

1. Maps out the macOS APIs we'd use for each capability (screen capture, camera capture, mic capture, compositing, output writing).
2. Identifies which capabilities are straightforward, which are tricky but feasible, and which might be problematic.
3. Provides a rough architectural sketch of the capture pipeline — how the pieces fit together.
4. Flags any showstoppers or significant risks (e.g. "mode switching mid-recording will always cause a brief gap" or "real-time PiP compositing requires Metal and is complex").
5. Notes any relevant open-source code or examples worth referencing during implementation.
6. Covers the Swift ecosystem and distribution considerations.

## Related Tasks

- Task 02 (Streaming Upload Architecture) — the output format from the capture pipeline feeds directly into the upload pipeline.
- Task 03 (Cap Codebase Analysis) — Cap's desktop app tackles similar capture problems, though via Rust/Tauri.
