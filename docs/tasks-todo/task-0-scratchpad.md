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

### Server-side MP4 compositing

- After recording completes, stitch HLS segments into a single MP4 using FFmpeg (`ffmpeg -i stream.m3u8 -c copy output.mp4` — no re-encoding).
- Serve the MP4 as a download option alongside HLS playback.
- Future: re-composite from individual streams at full quality with FFmpeg.
