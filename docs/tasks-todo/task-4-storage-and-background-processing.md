# Task 4: Storage & Background Processing

Goal: Build on the server app to add proper file storage for videos, background processing etc.

## More background processing on completion?

We use ffmpeg to generate `derivitives/` for completed videos in the background on recording completion. This currently involves stitching the streamed segments into a source.mp4, creating a jpeg thumbnail and (depending on the quality of source.mp4) potentially creating other derivitives of it (eg 1080p, 720p etc).

This is the time to consider improving these background tasks. We should consider:

- Using ffmpeg and ffprobe to extract metadata from the videos and update the SQL data records in a useful way?
- Smarter thumbnail generation?
- Audio cleanup post-processing?
- Generating more derivitives:
  - 1080p.mp4 — downsampled variant if original > 1080p
  - 720p.mp4 — downsampled variant if original > 720p
  - hls/master.m3u8 – adaptive-bitrate playlist
  - etc?

## Async background processing?

We currently use ffmpeg to generate `derivitives/` for completed videos in the background. This is the point for us to consider the best way of running background jobs (do we need a background jobs framework with queuing etc?) It may be that the post processing we need to do here does not even need to be async or managed by a background job queue at all. Let's consider tho?

## Proper Storage on Hertzner File Store (same API as R3)

It is obviously not sensible for us to actually be storing all of our video files and data on the Hertzner box - which is why we are writing our files to a shared volume. But we should should probably be using proper file storage system like Amazon R3 or Hertzner File Object Store or similar. So let's think arefully about that and how we could do so in a way that it's easy to work with.

## Backup Strategy

We should probably have backups of the final source.mp4 videos and their important metadata (url, title, date etc) automatically backed up to some long-term storage which is seperate from our main storage, just in case of emergencies etc. Let's consider options and approaches for this.
