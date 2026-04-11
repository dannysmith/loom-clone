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

## Next Up

### GPU contention during recording with multiple concurrent encoders

When 3 simultaneous H.264 encode sessions run (composited HLS + raw screen + raw camera), the GPU times out during `CIContext.render()` in the compositor. The Metal command buffer hits `kIOGPUCommandBufferCallbackErrorTimeout`, then all subsequent GPU commands are immediately rejected (`kIOGPUCommandBufferCallbackErrorSubmissionsIgnored`). The metronome falls behind (segments stretch to 8s instead of 4s) and the recording degrades.

Observed on Mac14,9 (M2 Pro) with: composited at 1080p (6 Mbps) + raw screen at 4K (60 Mbps) + raw camera at 720p (12 Mbps). With only 2 encode sessions (before raw camera writer existed), no GPU timeout occurred.

**Possible approaches:**
- **Defer raw encoding to post-recording.** Buffer raw frames during recording and encode them after stop. Eliminates GPU contention entirely but has memory implications — a 30-minute recording at 4K produces ~54 GB of raw NV12 pixel buffers (3840×2160 × 1.5 bytes × 30fps × 1800s). That's obviously impossible to hold in RAM. Could write uncompressed frames to disk as they arrive and encode afterward, but at ~180 MB/s for 4K NV12, disk I/O during recording becomes the bottleneck. A lighter option: record raw streams at a lower bitrate during recording (e.g. 15 Mbps for 4K screen instead of 60) to reduce encoder load, then optionally re-encode at full quality from the source after recording if desired.
- **Recreate `CIContext` after GPU errors.** Once the command queue is poisoned, all subsequent renders fail. Detecting the error (via `CIRenderDestination` instead of the void `render(to:bounds:colorSpace:)` method) and creating a fresh CIContext with a new command queue could recover mid-recording.
- **Reduce compositor GPU load.** In cameraOnly mode, the screen frame isn't used — but the CIContext is still doing colorspace conversion on the camera frame. Could bypass CIContext entirely for single-source modes and use vImage or a direct CVPixelBuffer scale instead.
- **Cap concurrent encode sessions.** If Apple Silicon's media engine only handles 2 sessions natively and the third spills to the GPU, limiting to 2 concurrent encodes (composited + one raw) might be enough. Priority: raw screen > raw camera (screen is the higher-value master).

Needs investigation into which approach is most practical. The finishWriting hang guard (checking `.failed` status before calling finishWriting) is already in place so this doesn't cause hangs anymore — it just degrades quality.

### Camera feed metadata and colorspace handling

The ZV-1 over USB delivers pixel buffers without `kCVImageBufferYCbCrMatrixKey` or `TransferFunctionKey` metadata attached. CIContext defaults to ITU-R 709 but can't be sure, so it runs an expensive multi-stage colorspace conversion pipeline on every frame (`colormatrix → clamp → alpha_swizzle → curve → colormatrix → curve → colormatrix`). This is a contributing factor in the GPU timeout above — the conversion chain is much more expensive than a simple scale.

This is likely not specific to the ZV-1. Many USB cameras and capture cards deliver buffers with incomplete or incorrect metadata.

**What to investigate / fix:**
- **Attach missing metadata proactively.** After receiving each camera frame, check for the presence of `kCVImageBufferYCbCrMatrixKey`, `kCVImageBufferTransferFunctionKey`, and `kCVImageBufferColorPrimariesKey`. If missing, attach sensible defaults (ITU-R 709 for HD, ITU-R 2020 for 4K). This tells CIContext exactly what the source is, eliminating the guesswork conversion chain.
- **Other metadata to check:** `CVPixelBufferGetPixelFormatType` — confirm it's actually NV12 (420YpCbCr8BiPlanarVideoRange). Some cameras deliver in 420f (full range) or even BGRA. If the pixel format doesn't match what we configured in `AVCaptureVideoDataOutput.videoSettings`, the pipeline could be doing unnecessary conversions.
- **Clean aperture / pixel aspect ratio.** Some cameras attach `kCVImageBufferCleanApertureKey` or non-square pixel aspect ratios. CIImage honours these, which can cause unexpected scaling or cropping in the compositor. Stripping or normalising these on ingestion would prevent surprises.
- **Camera format introspection at startup.** When the user selects a camera, log its `activeFormat`'s media subtype, supported colorspaces, and attached metadata. This would make future debugging much faster — we'd know exactly what each camera delivers without guessing.
- **Testing matrix.** Test with: built-in FaceTime HD, ZV-1 via USB, iPhone Continuity Camera, Elgato Cam Link (HDMI capture card), generic USB webcam. Each may have different metadata behaviours.

### Connectivity Issues

Consider how we handle temporarry drops in connectivity, and also if the server doesn't reciev every chunk streamed to it.

### Camera Adjustments 

Sliders for adjusting camera feed white balance and brightness. These should be reflected in the camera previews in the popover, the composited, streamed up video and the preview overlay while recording. They should not be reflected in the raw camera.mp4 written to local disk.

### Server-side MP4 compositing

- After recording completes, stitch HLS segments into a single MP4 using FFmpeg (`ffmpeg -i stream.m3u8 -c copy output.mp4` — no re-encoding).
- Serve the MP4 as a download option alongside HLS playback.
- Future: re-composite from individual streams at full quality with FFmpeg.
