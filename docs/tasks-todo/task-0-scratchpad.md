# Persistant Task Doc – Scratchpad for "Next Up" little things

Note: This scratchpad is always "task 0", although the tasks below are not nececarrily the next tasks in priority.

## Done

aaa

## To Do

- [ ] Audio/video sync issue - Audio is consistently about a quarter of a second ahead of the camera/screen in the composited/streamed up videos. This is true even when I have no display selected and so am only writing/streaming the camera and audio output. I would like to see if we can identify the cause of this. Because the obvious fix is simply to make like an ad an adjustment to the how those things are lined up. and then tweak that until it looks right. But obviously that doesn't seem like a brilliant solution. because then we've got a magic number that's just offsetting the audio by a certain amount. However, if that is the best thing to do, we can absolutely do that. But let's first look to see if we can find what we think is the cause or potential causes for this. 
- [ ] Audio Input indicator for selected microphone in panel


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
