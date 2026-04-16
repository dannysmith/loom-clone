# Persistant Task Doc – Scratchpad for "Next Up" little things

Note: This scratchpad is always "task 0", although the tasks below are not nececarrily the next tasks in priority.

## Done


## To Do


## Future Ideas

### Client

- - **Quick metadata editing**: After recording, a small UI to edit the video's title and slug and see/copy the URL.
- **Basic trimming**: Trim the start and end of a recording before or after upload. Remove dead air, false starts, etc.
- **Audio enhancement**: Basic noise reduction, gating, and pop reduction — either applied during recording or as a processing step before upload. Should be configurable and toggleable. If this proves difficult locally, we could choose to do this on the server instead after upload.
- **On-device transcription**: Use Apple's on-device AI (or a local transcription model) to generate a transcript and suggested title, and send them to the server alongside the video.

### Server

- **Automatic transcription**: Generate a text transcript of the video. Store alongside the video metadata.
- **Subtitles**: Generate and serve closed captions/subtitles derived from the transcript.
- **AI title & slug suggestions**: Suggest a title and slug based on the transcript content.
- **Basic web-based editor**: Trim, cut, and stitch videos in the browser. This may be where Remotion becomes interesting as a future direction.
- **Adaptive quality**: The player automatically adjusts quality based on the viewer's connection speed. (If we're using HLS with multiple renditions, this comes naturally.)
- **Format suffixes**: `v.danny.is/{slug}.mp4` returns the raw MP4 file. `v.danny.is/{slug}.json` returns metadata (URL, raw video URL, transcript, duration, etc.). `v.danny.is/{slug}.md` returns similar in Markdown format.
