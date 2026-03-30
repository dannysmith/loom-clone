# macOS Recording APIs & Desktop App Feasibility

*Research date: 2026-03-30*

---

## Executive Summary

Building the recording experience described in our requirements is feasible using native macOS APIs. The core capture primitives (ScreenCaptureKit for screen, AVCaptureSession for camera, either for microphone) are mature and well-supported. The hardest parts are real-time PiP compositing and mode switching mid-recording, both of which are achievable but require careful architecture.

Key findings:

- **ScreenCaptureKit** supports dynamic mid-stream updates to both content filters and configuration -- meaning we can change what's being captured and at what resolution without stopping the stream. This is the foundation for mode switching.
- **AVAssetWriter** can output fragmented MP4 segments in Apple HLS format, delivering segment data via a delegate callback. This is the native path to producing HLS segments during recording for streaming upload.
- **Real-time compositing** of camera-over-screen is best done via Core Image + Metal (CIContext rendering to pixel buffers), which is lightweight enough for 30fps compositing without dropped frames.
- **Pause/resume** is implemented by manipulating timestamps on CMSampleBuffers rather than stopping/starting the writer. AVAssetWriter does not support multiple sessions, so timestamp offsetting is the correct approach.
- **Mode switching** is the most architecturally complex feature but is feasible by running screen and camera capture independently and switching which streams feed into the AVAssetWriter pipeline.
- **Distribution** outside the Mac App Store via Developer ID + notarisation is the right path. No sandbox is required, which avoids restrictions on screen recording and camera access.

**No showstoppers identified.** The riskiest area is the interaction between mode switching, compositing, and HLS segment generation -- all happening simultaneously in real-time. This will require careful concurrency design but is not unprecedented.

---

## 1. Core Capture APIs

### 1.1 ScreenCaptureKit (Screen Capture)

**What it is**: Apple's modern screen capture framework, introduced at WWDC 2022, available on macOS 12.3+. It replaced the older CGDisplayStream and AVCaptureScreenInput approaches. ScreenCaptureKit is designed for high-performance screen capture and is the framework used by video conferencing apps, game streaming services, and screen recorders.

**Key classes**:

| Class | Purpose |
|---|---|
| `SCShareableContent` | Enumerates available displays, windows, and applications that can be captured |
| `SCContentFilter` | Defines what to capture -- a specific display, window, or set of applications, with inclusion/exclusion rules |
| `SCStreamConfiguration` | Controls capture quality: output resolution, frame rate, pixel format, color space, cursor visibility, audio settings |
| `SCStream` | The main capture stream object. Created with a filter + configuration, delivers CMSampleBuffers via delegate callbacks |
| `SCRecordingOutput` | (macOS 15+) Convenience API for recording directly to a file, where ScreenCaptureKit handles all the AVAssetWriter details |
| `SCContentSharingPicker` | (macOS 14+) System-level picker UI for selecting what to share, which bypasses the need for Screen Recording permission |
| `SCScreenshotManager` | (macOS 14+) API for capturing still screenshots |

**How capture works**:

1. Enumerate available content via `SCShareableContent`
2. Create an `SCContentFilter` specifying what to capture (display, window, app)
3. Create an `SCStreamConfiguration` with desired resolution, frame rate, pixel format
4. Create an `SCStream` with the filter and configuration
5. Add an `SCStreamOutput` handler to receive CMSampleBuffers for video and/or audio
6. Call `startCapture()` to begin streaming

**Output types**: The stream output handler receives callbacks categorised by `SCStreamOutputType`:
- `.screen` -- video frames as CMSampleBuffers containing CVPixelBuffers
- `.audio` -- audio samples (system audio)
- `.microphone` -- microphone audio (macOS 15+)

**Dynamic reconfiguration** (critical for our use case): After a stream starts, both the content filter and configuration can be updated without stopping the stream:
- `updateContentFilter(_:)` -- change what's being captured (e.g., switch from display A to display B, or from a specific window to the full display)
- `updateConfiguration(_:)` -- change capture parameters (resolution, frame rate, cursor visibility, etc.)

These updates happen seamlessly mid-stream. The stream continues delivering frames, and subsequent frames reflect the new filter/configuration. This is the enabler for mode switching.

**Pixel format**: The recommended pixel format is NV12 (420v / `kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange`), which is hardware-native on macOS and what VideoToolbox expects for hardware encoding. BGRA is also available for cases where pixel-level manipulation is needed.

**Frame rate**: Configurable via `SCStreamConfiguration.minimumFrameInterval`. The framework delivers frames on-demand rather than at a fixed rate -- if nothing on screen changes, fewer frames are delivered. This is efficient but means we may need to handle variable frame timing (the Nonstrict blog covers this edge case: repeating the last frame to ensure correct recording duration).

**Resolution considerations**: Retina displays have a scale factor (typically 2x). Capture resolution must account for this -- a 2560x1440 logical display is 5120x2880 physical pixels. AVAssetWriter with H.264 has a maximum resolution of 4096x2304, so 5K displays need to be scaled down. Cap handles this with VideoToolbox's VTPixelTransferSession for GPU-accelerated scaling.

**Audio capture**: ScreenCaptureKit captures system audio (application audio routed through the system) and, as of macOS 15, can also capture microphone audio directly. System audio capture through ScreenCaptureKit is the only reliable way to capture loopback audio on macOS without a virtual audio driver. Microphone capture via ScreenCaptureKit requires macOS 15+ and is configured via `SCStreamConfiguration.captureMicrophone` and `microphoneCaptureDeviceID`.

**macOS version support**:

| Feature | Minimum macOS |
|---|---|
| Basic ScreenCaptureKit | 12.3 |
| SCContentSharingPicker (system picker, no permission needed) | 14.0 |
| SCScreenshotManager | 14.0 |
| Presenter Overlay | 14.0 |
| SCRecordingOutput (record to file) | 15.0 |
| Microphone capture | 15.0 |
| HDR capture | 15.0 |

**Recommendation**: Target macOS 14+ minimum. This gives us the system sharing picker (which avoids the confusing Screen Recording permission flow) while maintaining broad compatibility. macOS 15's microphone capture is convenient but not essential -- we can use AVCaptureSession for the microphone on older versions.

### 1.2 AVCaptureSession (Camera & Microphone)

**What it is**: AVFoundation's capture session framework for camera and microphone input. This is the standard API for accessing hardware capture devices on macOS and iOS.

**How it works for our use case**: We use AVCaptureSession to capture the camera feed (and optionally microphone if not using ScreenCaptureKit's built-in mic capture). The session runs independently of ScreenCaptureKit -- they are separate frameworks with separate pipelines.

**Key setup**:

1. Create an `AVCaptureSession`
2. Add an `AVCaptureDeviceInput` for the camera (`AVCaptureDevice.default(for: .video)`)
3. Optionally add an `AVCaptureDeviceInput` for the microphone (`AVCaptureDevice.default(for: .audio)`)
4. Add an `AVCaptureVideoDataOutput` to receive camera frames as CMSampleBuffers
5. Add an `AVCaptureAudioDataOutput` to receive audio samples
6. Call `startRunning()`

**Simultaneous operation**: AVCaptureSession and ScreenCaptureKit run completely independently. There is no conflict in running both simultaneously. The camera AVCaptureSession delivers camera frames on its own dispatch queue, while ScreenCaptureKit delivers screen frames on a separate queue. This is how Cap, EasyDemo, and other tools handle it.

**Camera frame format**: Camera frames arrive as CMSampleBuffers containing CVPixelBuffers, typically in 420v (NV12) or BGRA format depending on the output configuration. For compositing, BGRA is easier to work with but NV12 is more efficient for encoding.

**Resolution**: MacBook cameras deliver up to 1080p (the FaceTime HD camera) or 12MP (the newer MacBook Pro cameras). External webcams vary. For the PiP overlay, we'll be scaling the camera feed down significantly anyway.

**Device switching**: Camera and microphone devices can be changed while the session is running by calling `beginConfiguration()`, removing the old input, adding the new input, and calling `commitConfiguration()`. This causes a brief reconfiguration but does not stop the session.

### 1.3 Audio Capture Options

We have three independent paths for audio:

| Source | API | Notes |
|---|---|---|
| Microphone | AVCaptureSession with AVCaptureAudioDataOutput | Standard approach. Works on all macOS versions. Full control over device selection. |
| Microphone | ScreenCaptureKit `captureMicrophone` | macOS 15+ only. Convenient -- mic audio arrives via the same stream output as screen/system audio. |
| System audio | ScreenCaptureKit `.audio` stream output | The only reliable way to capture system/app audio without a virtual audio driver. Available macOS 12.3+. |

**Recommendation**: Use AVCaptureSession for microphone capture (broadest compatibility, full device control). Use ScreenCaptureKit for system audio if we want that feature later. This keeps the microphone pipeline independent of the screen capture pipeline, which is cleaner for mode switching.

### 1.4 Running All Three Streams Simultaneously

The architecture is three independent capture sources:

1. **Screen**: ScreenCaptureKit SCStream, delivering screen frames and optionally system audio
2. **Camera**: AVCaptureSession, delivering camera frames
3. **Microphone**: AVCaptureSession (same or separate session as camera), delivering audio samples

Each runs on its own dispatch queue. They are completely independent and can start/stop independently. The compositing and encoding pipeline sits downstream, pulling from whichever streams are active based on the current recording mode.

**Performance overhead**: Running screen capture + camera capture + microphone capture simultaneously is well within the capabilities of any modern Mac. Cap does exactly this (via Rust equivalents of these APIs). EasyDemo does it natively in Swift. The GPU handles the heavy lifting for screen capture and encoding. CPU overhead is primarily in the compositing step and audio processing.

---

## 2. PiP Compositing (Camera Overlay)

### 2.1 The Problem

When recording in Screen + Camera + Mic mode, we need to composite the camera feed as a small overlay (circle or rounded rectangle) on top of the screen recording in real-time, at the recording frame rate (30fps or 60fps), without dropping frames.

### 2.2 Approaches

There are three main approaches, in order of preference:

**Approach A: Core Image compositing (Recommended)**

Use CIContext with Metal to composite each frame:

1. Receive screen frame (CVPixelBuffer) from ScreenCaptureKit
2. Receive camera frame (CVPixelBuffer) from AVCaptureSession
3. Create CIImages from both pixel buffers
4. Apply transforms to the camera image: scale, crop to circle/rounded rect (using CIFilter), position in corner
5. Composite using `CIFilter.sourceOverCompositing` or `CIBlendWithMask`
6. Render the composited CIImage to a new CVPixelBuffer via CIContext
7. Wrap in a CMSampleBuffer with appropriate timing and send to AVAssetWriter

**Why this works well**: Core Image uses Metal under the hood and is heavily optimised for this kind of per-frame image processing. Creating a CIContext with a Metal command queue allows the compositing to be pipelined with other GPU work. Apple's WWDC 2020 session on optimising Core Image for video explicitly covers this pattern.

**Performance**: At 30fps, each frame has ~33ms. Core Image compositing of two images with a mask and position transform takes well under 5ms on any Apple Silicon Mac. This leaves ample headroom.

**Key implementation notes**:
- Create one CIContext per pipeline (they are expensive to initialise)
- Disable intermediate caching (`kCIContextCacheIntermediates: false`) since every frame is different
- Use a CVPixelBufferPool for output buffers to avoid per-frame allocation
- The camera frame rate may differ from the screen frame rate; use the most recent camera frame for each screen frame

**Approach B: Metal shader compositing**

Write a custom Metal compute shader that takes two textures (screen + camera), applies the crop mask, and composites them. This is what Cap does via wgpu. It offers maximum performance and flexibility but is significantly more code to write and maintain.

**When to consider**: Only if Core Image proves to be a bottleneck, which is unlikely for our resolution and frame rate requirements.

**Approach C: Separate recording + post-composition**

Record screen and camera as separate tracks and composite during playback or export. This is Cap's Studio mode approach.

**Why not for us**: We need the composited output in real-time for HLS segment upload. If we defer compositing, the streamed segments during recording won't have the camera overlay, which means the instant-playback version won't match what the user sees.

### 2.3 Moving/Resizing the Overlay During Recording

Since compositing happens per-frame in our pipeline, the overlay position, size, and shape are just parameters that we read each frame. Changing them mid-recording is trivial -- update a shared state variable (e.g., an `@Published` property or a Swift actor's state), and the next frame picks up the new values. No pipeline reconfiguration needed.

This is straightforward because compositing is a per-frame render operation, not a structural pipeline change.

### 2.4 Overlay Shape (Circle/Rounded Rectangle)

Implemented via CIFilter masking:
- **Circle**: Create a circular gradient mask or use `CIRadialGradient` with a hard edge, then apply via `CIBlendWithMask`
- **Rounded rectangle**: Create a `CGPath` rounded rect, render it into a CIImage as a mask

Both are trivial to implement and have negligible performance cost since the mask can be pre-computed and reused (it only changes if the overlay size changes).

### 2.5 Assessment

**Difficulty: Moderate.** The compositing itself is well-understood and there are many examples (EasyDemo does webcam overlay compositing in Swift using Core Image). The tricky part is synchronising the camera and screen frame timing -- the camera may deliver frames at 30fps while the screen delivers frames on-demand at variable intervals. The standard approach is to always use the most recent camera frame for each screen frame, which is what Cap and EasyDemo do.

---

## 3. Mode Switching Mid-Recording

### 3.1 The Requirement

Switch between three modes during a single recording without stopping:
1. **Camera + Mic** -- full-frame camera, no screen
2. **Screen + Mic** -- screen capture, no camera
3. **Screen + Camera + Mic** -- screen with camera overlay

### 3.2 Architecture: Always-On Capture, Selective Composition

The key architectural insight is: **keep all capture sources running at all times, and switch modes by changing what feeds into the encoder.**

- ScreenCaptureKit stream runs continuously once started (even in camera-only mode)
- AVCaptureSession for camera runs continuously
- AVCaptureSession for microphone runs continuously

Mode switching changes the **composition logic**, not the capture pipeline:

| Mode | What gets encoded |
|---|---|
| Camera + Mic | Camera frames (full-resolution) + mic audio |
| Screen + Mic | Screen frames (as-is) + mic audio |
| Screen + Camera + Mic | Composited screen+camera frames + mic audio |

When switching modes, the composition function changes what it renders into the output pixel buffer. The AVAssetWriter continues receiving frames without interruption. The audio stream is unaffected.

### 3.3 Handling Resolution Changes

Different modes may want different output resolutions:
- Camera-only: camera native resolution (e.g., 1080p)
- Screen: display resolution (e.g., 2560x1440 or scaled retina)
- Screen + Camera: display resolution (camera overlay doesn't change the overall resolution)

If modes have different output resolutions, we have two options:

**Option A (Recommended): Fixed output resolution.** Choose one output resolution for the entire recording (e.g., 1920x1080 or the display resolution). Camera-only mode scales/pads the camera feed to fill this resolution. Screen mode uses this resolution directly (or scales to fit). This avoids any AVAssetWriter reconfiguration.

**Option B: Segment on mode switch.** End the current HLS segment when switching modes and start a new segment with different resolution. HLS supports resolution changes between segments. This is more complex but avoids wasting bandwidth on an oversized camera-only segment.

Option A is simpler and more reliable. Loom uses a similar approach -- the output resolution stays consistent throughout the recording regardless of mode.

### 3.4 Potential Issues

- **Brief visual transition**: When switching from camera-only to screen+camera, there may be a single-frame visual "pop" as the screen content appears. This is acceptable -- the requirements state that a hard cut is fine.
- **Audio continuity**: The microphone stream is independent of the video mode, so audio continues without interruption through mode switches.
- **Timestamp continuity**: Since the AVAssetWriter keeps running, timestamps continue incrementing naturally. No gap or adjustment needed.

### 3.5 ScreenCaptureKit's Dynamic Filter Update

Even if we wanted to change *what screen content* is captured mid-recording (e.g., switch from Display 1 to Display 2), ScreenCaptureKit supports this via `updateContentFilter(_:)` without stopping the stream. This is useful but not strictly needed for our primary mode-switching use case, since our modes are about which streams feed into the encoder, not about changing what's being screen-captured.

### 3.6 Assessment

**Difficulty: Moderate-High.** Mode switching is the single most complex feature architecturally. No existing open-source macOS recorder does this. However, the underlying API support is solid -- ScreenCaptureKit and AVCaptureSession both support dynamic reconfiguration, and the composition-layer approach avoids any need to stop/restart pipelines. The risk is in the interaction between mode switching, compositing, and the HLS segment writer, which all need to stay synchronised. Careful concurrency design (Swift actors) will be essential.

---

## 4. Output Format: HLS Segment Generation

### 4.1 AVAssetWriter for Fragmented MP4

AVAssetWriter gained the ability to output fragmented MP4 (fMP4) segments for HLS in macOS 11 / iOS 14 (WWDC 2020). This is the native path to producing HLS-compatible segments directly from the capture pipeline, without needing FFmpeg or any post-processing.

**Configuration**:

```swift
let writer = AVAssetWriter(contentType: UTType(AVFileType.mp4.rawValue)!)
writer.outputFileTypeProfile = .mpeg4AppleHLS  // or .mpeg4CMAFCompliant
writer.preferredOutputSegmentInterval = CMTime(seconds: 6.0, preferredTimescale: 600)
writer.delegate = self  // AVAssetWriterDelegate
```

**How it works**:

1. Set `outputFileTypeProfile` to `.mpeg4AppleHLS` to produce Apple HLS-compliant fMP4 segments
2. Set `preferredOutputSegmentInterval` to the desired segment duration (e.g., 6 seconds)
3. Implement `AVAssetWriterDelegate` to receive segment data
4. The delegate method `assetWriter(_:didOutputSegmentData:segmentType:segmentReport:)` is called each time a segment is ready
5. `segmentType` is either `.initialization` (the init segment, containing codec info) or `.separable` (a media segment containing video+audio data)
6. The segment data (`Data`) can be written to disk and/or uploaded immediately

**Segment types**:
- **Initialisation segment**: Emitted first. Contains the fMP4 initialization data (ftyp + moov). Must be sent before any media segments.
- **Media segments**: Emitted at the configured interval. Each is a standalone fMP4 segment (moof + mdat) that can be independently decoded given the init segment.

**Custom segmentation**: Setting `preferredOutputSegmentInterval` to `.indefinite` and calling `flushSegment()` manually gives us explicit control over when segments are cut. This could be useful for cutting segments at mode-switch boundaries.

**What this means for our streaming upload**: Each segment data blob from the delegate can be immediately uploaded to the server as a standalone HLS segment. The server writes an M3U8 playlist pointing to the uploaded segments. When the user stops recording, we flush the final segment, upload it, and finalise the playlist. The video is playable from segment 1.

### 4.2 Known Issues

**Memory leak in Swift (fixed)**: There was a memory leak when implementing AVAssetWriterDelegate in Swift on macOS 11-13.2. The segment data delivered to the delegate was a custom NSData subclass that leaked when bridged to Swift's Data type. This was fixed in macOS 13.3+. Since we're targeting macOS 14+, this is not a concern.

**CMAF crash**: There was a crash when using `.mpeg4CMAFCompliant` profile in certain configurations. The `.mpeg4AppleHLS` profile is more tested and reliable.

### 4.3 Alternative: AVAssetWriter to MOV + FFmpeg Segmentation

If AVAssetWriter's HLS output proves problematic, the fallback is:
1. Write to a standard MOV/MP4 file using AVAssetWriter
2. Run FFmpeg to segment the growing file into HLS

This is less elegant (requires FFmpeg as a dependency, adds latency, more complex file management) but is a proven approach. MediaCMS and PeerTube both use FFmpeg for HLS segmentation.

### 4.4 Assessment

**Difficulty: Straightforward.** AVAssetWriter's HLS segment output is a well-documented API (WWDC 2020 session, Apple documentation, Nonstrict examples). The main integration challenge is connecting the segment delegate callbacks to the upload pipeline. The API has been available since macOS 11 and has matured through several releases.

---

## 5. Pause/Resume

### 5.1 Implementation Approach

AVAssetWriter does not support multiple write sessions -- you cannot call `endSession()` and then `startSession()` on the same writer. This means pause/resume must be handled by timestamp manipulation rather than pipeline start/stop.

**The standard approach**:

1. **Pause**: Set a flag that causes the composition pipeline to stop appending frames to AVAssetWriter. Record the timestamp of the last appended frame. The capture sources (ScreenCaptureKit, AVCaptureSession) continue running but their output is discarded.

2. **Resume**: When recording resumes, calculate the pause duration (current time minus pause start time). Apply this offset to all subsequent CMSampleBuffers before appending them to AVAssetWriter, using `CMSampleBuffer(copying:withNewTiming:)` to create retimed copies. This makes the output file seamless -- the pause is invisible in the final video.

3. **Audio alignment**: The same timestamp offset must be applied to audio samples. Since audio and video are appended to separate AVAssetWriterInputs, both must use the same offset.

**Cap's approach for reference**: Cap's Instant mode uses a simpler flag-based pause (stop accepting frames, resume accepting). Cap's Studio mode tears down the entire pipeline and creates a new one per segment, which is heavyweight but avoids timestamp manipulation.

### 5.2 Interaction with Mode Switching

Pause and mode switching interact cleanly if the mode switch happens while paused:
1. User pauses recording
2. User switches mode (e.g., camera-only to screen+camera)
3. The composition function updates to reflect the new mode
4. User resumes -- frames from the new mode start being appended with correct timestamps

If mode switching happens while recording (not paused), it's even simpler -- the composition function just starts rendering differently on the next frame. No pause/resume interaction at all.

### 5.3 Interaction with HLS Segments

Pausing mid-segment means the current segment will be longer than the target duration (it includes the wall-clock time of the pause, but the encoded time stops during the pause). This is fine -- HLS allows variable segment durations, and the segment's actual media duration will be correct.

Alternatively, we could flush the current HLS segment when pausing and start a new one on resume. This keeps segment durations predictable and creates clean segment boundaries at pause points.

### 5.4 Assessment

**Difficulty: Straightforward.** Timestamp manipulation for pause/resume is a well-known pattern with many examples (GDCL blog, VineVideo on GitHub, numerous StackOverflow answers). The main care needed is ensuring audio and video timestamps stay aligned.

---

## 6. The Capture Pipeline Architecture

### 6.1 Overview

```
                          +-----------+
                          |  SCStream |  (screen + system audio)
                          +-----+-----+
                                |
                                v
+----------------+     +--------+--------+     +------------------+
| AVCaptureSession| --> | Composition     | --> | AVAssetWriter    |
| (camera)       |     | Engine          |     | (fMP4/HLS segs)  |
+----------------+     | (Core Image +   |     +--------+---------+
                        |  Metal)         |              |
+----------------+     +--------+--------+     +--------v---------+
| AVCaptureSession| -->         ^              | Upload Pipeline   |
| (microphone)   | ------------|              | (segment upload)  |
+----------------+              |              +------------------+
                                |
                        Recording Mode State
                        (camera / screen / screen+camera)
```

### 6.2 Component Responsibilities

**Capture layer** (always running when recording):
- `SCStream`: captures screen frames and system audio
- `AVCaptureSession` (camera): captures camera frames
- `AVCaptureSession` (microphone): captures audio samples

**Composition engine** (the central coordinator):
- Receives frames from screen and camera capture
- Reads current recording mode state
- For Camera + Mic: scales camera frame to output resolution
- For Screen + Mic: passes screen frame through (or scales)
- For Screen + Camera + Mic: composites camera overlay onto screen frame using CIContext/Metal
- Outputs composited CMSampleBuffer to the writer

**Writer layer**:
- `AVAssetWriter` configured for HLS fMP4 output
- Video input (`AVAssetWriterInput` for video)
- Audio input (`AVAssetWriterInput` for audio)
- Delegate receives segment data blobs

**Upload layer** (downstream of writer):
- Receives segment data from AVAssetWriterDelegate
- Uploads each segment to the server
- Tracks upload progress and handles retry/failure

### 6.3 Concurrency Model

Swift actors are the natural fit:

- **RecordingActor**: owns the overall recording state machine (idle / recording / paused / stopped). Coordinates start/stop/pause/resume/mode-switch commands.
- **CompositionActor**: owns the CIContext and performs per-frame compositing. Receives frames from capture callbacks, produces composited output.
- **WriterActor**: owns the AVAssetWriter. Receives composited frames and audio, handles timing/pause offsets, appends to writer inputs.
- **UploadActor**: owns the upload queue. Receives segment data from the writer delegate, manages upload to server.

This actor-based design (similar to Cap's use of `kameo` actors in Rust) prevents data races and provides clean state management.

### 6.4 Local Safety Net

In parallel with the HLS segment writer, we also keep a local recording:

- A separate AVAssetWriter writing to a local MOV/MP4 file at full quality
- This file is never deleted until the server confirms the video is fully processed
- If the network fails, the local file is the recovery mechanism

Alternatively, the HLS segments themselves can be written to local disk in addition to being uploaded, providing the same safety net. The local M3U8 + segments constitute a playable local copy.

---

## 7. Swift Ecosystem & Distribution

### 7.1 Menu Bar App Architecture

The app should be a menu bar (status bar) utility with a minimal presence:

**NSStatusItem + NSMenu** is the recommended approach (not NSPopover):
- Apple explicitly recommends displaying a menu, not a popover, from menu bar extras
- NSMenu with NSHostingView provides instant responsiveness and native macOS behaviour
- The menu appears immediately when clicked and dismisses naturally when clicking away
- NSPopover has a slight delay, doesn't dismiss naturally, and feels like a floating app rather than a system utility

**Architecture**: Hybrid AppKit + SwiftUI:
- **AppKit** for: NSStatusItem, NSMenu, window management, system permissions, global keyboard shortcuts (using Carbon's RegisterEventHotKey or the modern AddGlobalMonitorForEvents)
- **SwiftUI** for: the menu content views, settings UI, any floating panels/windows, recording controls overlay

The `@main` App struct can use `MenuBarExtra` (introduced in macOS 13), or for more control, use a traditional AppDelegate-based approach with NSStatusItem.

### 7.2 Recording UI

During recording, we need floating controls (stop, pause, mode switch). Options:

- **Floating NSPanel** (`.nonactivating`): a borderless, always-on-top panel with recording controls. This is how most screen recorders work. The panel floats above all windows, doesn't take focus, and can be styled to look like a native system control.
- **NSStatusItem menu**: the menu bar icon changes state during recording, and clicking it shows recording controls in the menu.

**Global keyboard shortcuts**: Essential for start/stop/pause without switching to the app. Implemented via `NSEvent.addGlobalMonitorForEvents(matching: .keyDown)` or the older Carbon API for truly global hotkeys that work even when other apps have focus.

### 7.3 Distribution

**Direct distribution (recommended)**: Developer ID + notarisation + DMG.

The process:
1. Sign the app with a Developer ID Application certificate
2. Enable Hardened Runtime in build settings
3. Submit to Apple's notarisation service via `xcrun notarytool submit`
4. Staple the notarisation ticket via `xcrun stapler staple`
5. Package as a DMG and host on the website

**No sandbox required.** Apps distributed outside the Mac App Store do not need to be sandboxed. They need Hardened Runtime (which is required for notarisation) but not App Sandbox. This is important because:
- Screen Recording permission works differently in sandboxed vs non-sandboxed apps
- Camera and microphone access via TCC requires hardened runtime entitlements (`com.apple.security.device.camera`, `com.apple.security.device.microphone`)
- Non-sandboxed apps have full filesystem access for storing local recordings

**Mac App Store**: Possible but not recommended initially. The App Store requires sandboxing, which imposes restrictions on screen recording access and filesystem access. Several screen recorders (like QuickRecorder) distribute outside the App Store for this reason. We can always add an App Store version later.

**Auto-update**: Sparkle (open-source macOS update framework) is the standard for apps distributed outside the App Store. It handles checking for updates, downloading, and installing -- including delta updates for smaller downloads.

### 7.4 Permissions UX

Three permissions are required, each with its own TCC (Transparency, Consent, and Control) prompt:

| Permission | When prompted | User action |
|---|---|---|
| Screen Recording | First attempt to use ScreenCaptureKit (unless using SCContentSharingPicker) | Must go to System Settings > Privacy & Security > Screen Recording and enable the app |
| Camera | First call to `AVCaptureDevice.requestAccess(for: .video)` | Standard system dialog with Allow/Deny |
| Microphone | First call to `AVCaptureDevice.requestAccess(for: .audio)` | Standard system dialog with Allow/Deny |

**Screen Recording permission** is the most friction-heavy. Unlike camera and microphone, it does not show a simple Allow/Deny dialog. Instead, the user must manually navigate to System Settings and toggle the permission. This is a known UX pain point for all screen recording apps.

**SCContentSharingPicker bypass** (macOS 14+): Using the system content sharing picker sidesteps the Screen Recording permission entirely. Because the user explicitly chooses what to share through the system UI, no blanket screen recording permission is needed. This is a significant UX improvement and is the approach Apple recommends for screen sharing apps. However, it gives the user more control (they choose what's shared), which may not fit our workflow where we want to capture a specific display.

**Recommendation**: Request camera and microphone permissions on first launch via `AVCaptureDevice.requestAccess()`. For screen recording, guide the user to System Settings with a clear in-app prompt explaining what to do. Consider supporting SCContentSharingPicker as an alternative path for macOS 14+ users.

### 7.5 macOS Version Targeting

| Target | Reasoning |
|---|---|
| macOS 14 (Sonoma) | Good balance. Gets us SCContentSharingPicker, MenuBarExtra improvements, and broad compatibility. Most Mac users are on macOS 14+. |
| macOS 15 (Sequoia) | Adds ScreenCaptureKit microphone capture, SCRecordingOutput, and HDR. Narrower audience but simpler code. |

**Recommendation**: Target macOS 14+ with runtime checks for macOS 15 features.

---

## 8. On-Device Transcription

*Side note -- not a primary focus, but worth documenting for future use.*

### 8.1 SFSpeechRecognizer (Existing)

Apple's Speech framework (`SFSpeechRecognizer`) has been available since macOS 10.15 and supports on-device recognition (without sending audio to Apple's servers). It works with live audio buffers or audio files. The on-device model quality is decent for real-time dictation but has limitations for long-form transcription (accuracy drops, no speaker diarisation, limited punctuation intelligence).

### 8.2 SpeechAnalyzer (New -- WWDC 2025)

Apple introduced the SpeechAnalyzer framework at WWDC 2025, available in macOS 26 (the next major release after Sequoia). This is a major upgrade:

- **SpeechTranscriber**: Optimised for long-form and distant audio (lectures, meetings, conversations). Higher accuracy than SFSpeechRecognizer.
- **DictationTranscriber**: Natural, punctuation-aware dictation.
- **SpeechDetector**: Detects speech presence and timing without full transcription.
- Runs entirely on-device with system-managed language models.
- The model lives in system storage -- it does not increase app size or runtime memory.
- Multiple language support.

This is exactly what we'd want for on-device transcription of recordings. However, it requires macOS 26, which is not yet released and won't have widespread adoption for some time.

### 8.3 WhisperKit (Third-Party)

WhisperKit (by Argmax) is an open-source Swift package that runs OpenAI's Whisper model locally on Apple Silicon using Core ML. It provides high-quality transcription today, without waiting for macOS 26. It supports multiple model sizes (trading accuracy for speed/memory) and works on macOS 13+.

### 8.4 Recommendation

For the near term, WhisperKit is the most practical option for on-device transcription -- it works today on our target macOS versions with good accuracy. When macOS 26's SpeechAnalyzer becomes widely available, we can migrate to the native framework for better system integration and lower resource usage. Either way, transcription can run as a post-recording step on the local audio file, so it's architecturally isolated from the capture pipeline.

---

## 9. Relevant Open-Source Projects

| Project | What it does | Why it's relevant |
|---|---|---|
| [ScreenCaptureKit-Recording-example](https://github.com/nonstrict-hq/ScreenCaptureKit-Recording-example) (Nonstrict) | Minimal example of ScreenCaptureKit + AVAssetWriter | Covers all the edge cases (retina resolution, timing, frame repetition). Essential reference. |
| [EasyDemo](https://github.com/danieloquelis/EasyDemo) | Swift/SwiftUI screen recorder with webcam overlay | Demonstrates Core Image compositing of camera over screen in a real macOS app. |
| [QuickRecorder](https://github.com/lihaoyun6/QuickRecorder) | Lightweight ScreenCaptureKit recorder | Menu bar architecture, multiple recording modes, Presenter Overlay support. |
| [Azayaka](https://github.com/Mnpn/Azayaka) | Menu bar screen + audio recorder | Clean, minimal ScreenCaptureKit implementation. Good reference for menu bar app structure. |
| [BetterCapture](https://github.com/jsattler/BetterCapture) | SwiftUI + ScreenCaptureKit recorder | ProRes/HEVC/H.264, system audio + mic recording. macOS 15.2+. |
| [Cap](https://github.com/CapSoftware/Cap) (crates/) | Tauri desktop app, Rust recording pipeline | Uses ScreenCaptureKit via cidre, VideoToolbox for scaling, AVFoundation for encoding. See our codebase analysis. |
| [AVAssetWriter segment leak sample](https://github.com/nonstrict-hq/avassetwriter-segment-leak-sample) (Nonstrict) | Demonstrates AVAssetWriter delegate memory leak and workaround | Documents a real bug (fixed in macOS 13.3+) in the HLS segment output path. |

---

## 10. Risk Assessment

### Low Risk (Straightforward)

| Capability | Assessment |
|---|---|
| Screen capture via ScreenCaptureKit | Mature API, well-documented, many examples |
| Camera capture via AVCaptureSession | Standard, decades-old API |
| Microphone capture | Standard API |
| Writing to local file via AVAssetWriter | Well-documented with edge cases covered by Nonstrict |
| Menu bar app architecture | Standard macOS pattern |
| Distribution via Developer ID + notarisation | Established process |
| Pause/resume via timestamp manipulation | Known pattern, many examples |
| Permissions UX | Annoying for users but well-understood |

### Medium Risk (Feasible but Requires Care)

| Capability | Assessment |
|---|---|
| HLS segment output from AVAssetWriter | API exists since macOS 11, documented in WWDC 2020. Less commonly used than standard file writing, so fewer real-world examples. The memory leak bug (fixed macOS 13.3+) suggests this is a less-exercised code path in AVFoundation. |
| Real-time PiP compositing | Proven approach (Core Image + Metal) with examples (EasyDemo, Cap), but synchronising two frame streams at potentially different rates requires careful buffering. |
| Mode switching mid-recording | No existing tool does this. The underlying API support is solid (dynamic reconfiguration, independent capture sources), but the composition-layer design is novel. Needs thorough testing of edge cases (rapid switching, switching during scene transitions, audio continuity). |

### Higher Risk (Needs Prototyping)

| Capability | Assessment |
|---|---|
| HLS segments + compositing + mode switching + upload (all simultaneously) | Each piece works individually. The risk is in the interaction -- running all four simultaneously in real-time with correct timestamps, no dropped frames, and seamless mode transitions. This needs a prototype to validate before committing to the full architecture. |

### No Showstoppers

Nothing in this research suggests the requirements are infeasible. The macOS capture APIs are powerful and well-designed. The hardest parts (mode switching, real-time compositing, HLS segment generation) are all supported by the native frameworks -- they just haven't been combined in this specific way before in any open-source project we found.

---

## 11. Recommended Next Steps

1. **Build a capture pipeline prototype** that validates: ScreenCaptureKit screen capture + AVCaptureSession camera capture + Core Image compositing + AVAssetWriter HLS segment output, all running simultaneously. This is the highest-risk integration point and should be proven early.

2. **Test mode switching** in the prototype: switch between camera-only and screen+camera mid-recording while the AVAssetWriter continues writing HLS segments. Verify timestamp continuity and audio alignment.

3. **Test HLS segment upload** by connecting the AVAssetWriterDelegate segment callbacks to a simple HTTP upload, and verifying the segments are independently playable on the server.

4. **Settle on macOS version target** (14 vs 15) after the prototype reveals whether any macOS 15 APIs meaningfully simplify the architecture.

---

## Sources

### Apple Documentation
- [ScreenCaptureKit framework](https://developer.apple.com/documentation/screencapturekit/)
- [SCStream](https://developer.apple.com/documentation/screencapturekit/scstream)
- [SCStreamConfiguration](https://developer.apple.com/documentation/screencapturekit/scstreamconfiguration)
- [AVAssetWriter](https://developer.apple.com/documentation/avfoundation/avassetwriter)
- [Writing fragmented MPEG-4 files for HTTP Live Streaming](https://developer.apple.com/documentation/avfoundation/media_assets_and_metadata/sample-level_reading_and_writing/writing_fragmented_mpeg-4_files_for_http_live_streaming)
- [Requesting Authorization for Media Capture on macOS](https://developer.apple.com/documentation/avfoundation/cameras_and_media_capture/requesting_authorization_for_media_capture_on_macos)
- [Notarizing macOS software before distribution](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)

### WWDC Sessions
- [Meet ScreenCaptureKit (WWDC 2022)](https://developer.apple.com/videos/play/wwdc2022/10156/)
- [Take ScreenCaptureKit to the next level (WWDC 2022)](https://developer.apple.com/videos/play/wwdc2022/10155/)
- [What's new in ScreenCaptureKit (WWDC 2023)](https://developer.apple.com/videos/play/wwdc2023/10136/)
- [Capture HDR content with ScreenCaptureKit (WWDC 2024)](https://developer.apple.com/videos/play/wwdc2024/10088/)
- [Author fragmented MPEG-4 content with AVAssetWriter (WWDC 2020)](https://developer.apple.com/videos/play/wwdc2020/10011/)
- [Optimize the Core Image pipeline for your video app (WWDC 2020)](https://developer.apple.com/videos/play/wwdc2020/10008/)
- [Bring advanced speech-to-text to your app with SpeechAnalyzer (WWDC 2025)](https://developer.apple.com/videos/play/wwdc2025/277/)

### Technical Articles
- [Recording to disk using ScreenCaptureKit (Nonstrict)](https://nonstrict.eu/blog/2023/recording-to-disk-with-screencapturekit/) -- Essential reference for AVAssetWriter + ScreenCaptureKit edge cases
- [AVAssetWriter leaking memory when segment data is used in Swift (Nonstrict)](https://nonstrict.eu/blog/2023/avassetwriter-leaks-segment-data/) -- Documents the HLS segment delegate memory leak (fixed macOS 13.3+)
- [A look at ScreenCaptureKit on macOS Sonoma (Nonstrict)](https://nonstrict.eu/blog/2023/a-look-at-screencapturekit-on-macos-sonoma/) -- SCContentSharingPicker, Presenter Overlay, Screenshot API
- [How to publish a Mac desktop app outside the App Store (DoltHub)](https://www.dolthub.com/blog/2024-10-22-how-to-publish-a-mac-desktop-app-outside-the-app-store/) -- Signing and notarisation process

### Open-Source Projects
- [ScreenCaptureKit-Recording-example (Nonstrict)](https://github.com/nonstrict-hq/ScreenCaptureKit-Recording-example) -- Minimal recording example
- [EasyDemo](https://github.com/danieloquelis/EasyDemo) -- Swift screen recorder with webcam overlay
- [QuickRecorder](https://github.com/lihaoyun6/QuickRecorder) -- Lightweight ScreenCaptureKit recorder
- [Azayaka](https://github.com/Mnpn/Azayaka) -- Menu bar screen + audio recorder
- [BetterCapture](https://github.com/jsattler/BetterCapture) -- SwiftUI + ScreenCaptureKit recorder
- [Cap](https://github.com/CapSoftware/Cap) -- Open-source Loom alternative (Rust/Tauri)
