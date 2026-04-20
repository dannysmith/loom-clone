# Task 4: Storage & Background Processing

Goal: Build on the server app to add proper file storage for videos, background processing etc.

## Proper Storage on Hertzner File Store (same API as R3)

It is obviously not sensible for us to actually be storing all of our video files and data on the Hertzner box - we should be using proper file storage like Amazon R3 or Hertzner File Store. So let's wire that up properly in such a way that it's easy to work with.

## Better background processing

We currently use ffmpeg to generate `derivitives/` for completed videos in the background. This is the point for us to consider the best way of running background jobs (do we need a background jobs framework with queuing etc?)

This is also the time to consider other background tasks like:

- Smarter thumbnail generation?
- Audio cleanup post-processing?
- 
- Generating more derivitives:
  - 1080p.mp4 — downsampled variant if original > 1080p
  - 720p.mp4 — downsampled variant if original > 720p
  - hls/master.m3u8 – adaptive-bitrate playlist
  - etc

## Backup Strategy

We should probably have backups of the final source.mp4 videos and their important metadata (url, title, date etc) automatically backed up to some long-term storage just in case of emergencies.
