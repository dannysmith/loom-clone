# Persistant Task Doc – Scratchpad for "Next Up" little things

## Done

- [x] Fix laggy video preview when recording
- [x] Make it handle cameras and mics (and screens) which come online while the app is running/open - probably need polling for these?
- [x] Add screen preview and clean up UI
- [x] Make it behave properly if the server isn't running when the app opens and disable recording if server is unreachable.
- [x] Add a cancel button to the recording overlay which abandons the recording after a confirmation. This will also have to send a message to the server to delete the in-progress recording on the server end.
- [x] Write out a JSON file which contains some representation of the data being recorded with timestamps, what changed (change mode, pause, resume etc), chunks recorded with size etc. All with timestamps. If we write this out to the local files on disk, then we can send that up to the server when the video is finished recording. I figure that might be useful if we have to do some server side stuff to rebuild videos or debug videos or whatever that is, you know. When we get around to also saving the raw high-quality video feeds locally, we could also use the data in here if we ever build some kinda local video editor which lets us use the raw data to change when we switch modes etc.
- [x] Recording resolution for both screen and video - maybe this should be selectable in the popover UI before recording?
  - Currently hardcoded to 1920x1080. Test with high-res monitors (Retina, external 4K) and high-quality camera inputs (DSLR via USB/capture card).
  - Capture at native display resolution instead of forcing 1080p. Scale down only for the composited HLS output if needed.
  - Bitrate should scale with resolution — 6 Mbps is fine for 1080p but needs ~15-20 Mbps for 4K.
  - Camera capture should use the camera's native resolution, not be constrained by output resolution.
- [x] Local full-quality recordings
  - Save individual capture streams as standalone files alongside the composited HLS segments:
    - Screen → `screen.mp4` at native monitor resolution
    - Camera → `camera.mp4` at native camera resolution
    - Audio → `audio.m4a`
  - This enables re-compositing later (change camera position/size, effects, etc.) and provides a high-quality master.
  - Requires running multiple AVAssetWriters simultaneously. Apple Silicon's dedicated media engine supports concurrent H.264 encode sessions.
  - Full composited recording also available as MP4, perhaps composited from the stream files locally after recording has finished?

## Moved out

The "GPU contention during recording with multiple concurrent encoders",
"Camera feed metadata and colorspace handling", and "Camera Adjustments"
entries previously listed here have been moved to
`task-0A-encoder-contention-and-camera-pipeline.md` and rewritten as a
phased plan based on research findings (the root cause turned out to be
single-media-engine contention on M2 Pro, not CIContext itself — see that
task for the full reframing).

## Next Up

### Connectivity Issues

Consider how we handle temporarry drops in connectivity, and also if the server doesn't reciev every chunk streamed to it.

### Log noise cleanup + AppKit layout recursion warning

The app's console output during normal recording is full of noise. Most of it is harmless macOS chatter, some of it is ours to fix, and at least one message is a ticking AppKit warning that Apple has explicitly said "may break in the future". This task is to walk through all of it, fix what we can, and document the rest.

**Must fix — AppKit recursive layout warning.** First observed in the 1-minute test on 2026-04-11. AppKit emits exactly once per session:

> It's not legal to call -layoutSubtreeIfNeeded on a view which is already being laid out. If you are implementing the view's -layout method, you can call -[super layout] instead. Break on void _NSDetectedLayoutRecursion(void) to debug. This will be logged only once. This may break in the future.

Somewhere in our UI layer a view's `layout` method is calling `layoutSubtreeIfNeeded` on a subtree that's currently being laid out — a recursive layout pass that AppKit is tolerating today but might stop tolerating in a future macOS. Likely candidates are the views that bridge SwiftUI and AppKit directly: `RecordingPanel` (NSWindow host), `CameraOverlayWindow`, `NativePopUpPicker`, the popover-hosting `MenuView`. The fastest way to locate it is a symbolic breakpoint on `_NSDetectedLayoutRecursion` in Xcode — let it fire once, read the stack, fix the offending call site (usually by replacing `layoutSubtreeIfNeeded` with `super.layout()` inside a custom `layout` override, or by moving layout-triggering work out of a layout pass).

**Must fix — disable camera Reactions.** The Xcode console is spammed with `Portrait.framework` / `VFXNode` / particle-emitter log lines whenever the app talks to the camera (`vfx_custom_shader_confetti_shader_171`, `vfx_custom_shader_balloons_shader_14`, `vfx_custom_shader_fireworks_shader_248`, etc.). These come from the macOS system-wide "Reactions" feature — when you wave at the camera or make a thumbs-up, macOS overlays confetti/balloons/fireworks/hearts on the video feed. AVFoundation loads the VFX resources the moment an app opens a camera session, even if the user never triggers a reaction, which is where all the noise comes from. Beyond the log noise, **we almost certainly don't want Reactions active on a recording** — if someone waves while recording a talking-head video, the reaction lands in the composited HLS and the raw camera master. Disable it explicitly on camera capture via the `AVCaptureDevice.Format.reactionEffectsSupported` / `AVCaptureDevice.reactionEffectsEnabled` APIs (macOS 14+). Needs to be set on both the recording session and the preview session. One change; eliminates probably 80% of the Xcode console spam and fixes a real correctness hazard.

**Should fix — camera preview pixel buffer tagging.** Console logs `createFromPixelbuffer: kCVImageBufferYCbCrMatrixKey not found. Using R709` and `createFromPixelbuffer: TransferFunctionKey not found. Using ITU_R_709_2` during camera preview setup. These come from the *preview* path (`CameraPreviewManager` via `AVCaptureVideoPreviewLayer`), which doesn't go through our Phase 1 tagging in `CameraCaptureManager.captureOutput` — our tagging only fires on the recording-path delegate callback. The preview has its own capture session / layer. Fixes: either (a) apply the same Rec. 709 attachment-tagging in the preview manager's delegate, or (b) migrate the preview to a CIImage-based renderer (which is already proposed in task 0A Phase 4, so this may land for free with that phase).

**Should fix — "cannot index window tabs due to missing main bundle identifier".** AppKit complaint about tab groups. Probably fixable by making sure the main window has a unique `tabbingIdentifier` set (or disabling tabbing on the window). Harmless but noisy.

**Live with:** these all come from macOS internals, we can't suppress them from our code without side effects, and they don't indicate anything wrong:

- `Force [_MTLDevice _purgeDevice] not supported` — generic Metal log, appears in many apps
- `(Fig) signalled err=0 at <>:85` — AVFoundation internal
- `Reporter disconnected. { function=sendMessage, reporterID=... }` — Core Media internal
- `CMIO_Graph_Helpers_Analytics.mm:36:sendAnalytics Missing key plugInPackage` / `Missing key CMIOType` / `Missing key numberOfDevices` — CMIO analytics telemetry noise
- `CMIO_Unit_Input_Device.cpp:385:GetPropertyInfo Sensitive content analyzer unavailable because SensitiveContentAnalysis/conferencing_detection is disabled` — correct, we don't use SCA
- `os_unix.c:51044: (2) open(/private/var/db/DetachedSignatures)` — SQLite probe from some system framework, harmless
- `cannot open file at line 51044 of [f0ca7bba1c]` — same SQLite thing
- `AddInstanceForFactory: No factory registered for id <CFUUID ...>` — CoreFoundation runtime noise
- `MLE5Engine is disabled through the configuration` — Vision framework internal
- WindowServer "Metal Compiling Shader" entries during app launch — one-time shader warm-up
- `Failed to create world from file:.../Portrait.framework/Resources/lighting.vfx/` — likely goes away with the Reactions fix above, but if it persists it's harmless

Goal for this task: end up with a clean Xcode console during a normal recording — just our `[recording]` / `[writer] ` / `[upload]` / `[camera]` / `[screen]` / `[mic]` log lines, plus any real errors.

### Server-side MP4 compositing

- After recording completes, stitch HLS segments into a single MP4 using FFmpeg (`ffmpeg -i stream.m3u8 -c copy output.mp4` — no re-encoding).
- Serve the MP4 as a download option alongside HLS playback.
- Future: re-composite from individual streams at full quality with FFmpeg.
