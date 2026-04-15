# Persistant Task Doc – Scratchpad for "Next Up" little things

Note: This scratchpad is always "task 0", although the tasks below are not nececarrily the next tasks in priority.

## Done


## To Do

### Server-side MP4 compositing

- After recording completes, stitch HLS segments into a single MP4 using FFmpeg (`ffmpeg -i stream.m3u8 -c copy output.mp4` — no re-encoding).
- Serve the MP4 as a download option alongside HLS playback.
- Future: re-composite from individual streams at full quality with FFmpeg.
