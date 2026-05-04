# Features

> Note: This is a working doc on the features of this project, which will probs eventually be used as the basis of a blog article.

## Why I built this

TBD

## Initial Requirements in a Nutshell

### Recording

TBD - bullet list of my specific requirements for recording.

- Three modes, instant cuts bwteeen them.
- No chrome in screen recordings
- High-quality cam-only when talking head
- Pre-recording tweaks to white balance etc
- Local copies of all input streams saved to disk seperatley for final cut Pro etc if needed

### Sharing

TBD - bullet list of my specific requirements for sharing.


- Videos on https://v.danny.is/my-video can easily customise slug.
- Instant sharing of URL when recording is done.
- Full control over public-facing video endpoints and what's returned.
- Viewers always get the best UX possible.

### Admin

TBD - bullet list of my specific requirements for admin.

- Loom-like admin interface for me to manage my videos.
- Can upload mp4 videos exported from loom/youtube etc.
- Three modes of visibility:
  - **Unlisted** vidoes are the default. They are publically available but are not easily *discoverable* unless you know their URL. The vast majority of my videos will be of this type.
  - **Public** videos are discoveravle via RSS & JSON feed and can be indexed by search engines.
  - **Private** vidoes are not available anywhere except via the admin interface and cannot be shared. These are intended for personal notes and videos I want to keep private until I’m ready to share them.

### Other Requirements

TBD - bullet list of my other specific requirements.

- Deployed to my own server, ideally one where I can also run other services on it.
- Cheap.
- Not complex to manage or keep current with security patches etc.

## Core Principles

Before I started work on this I wanted to nail down some **super fundamental** principles which weren't gonna change even if my initial requirements (inevitably) evolved. Here they are:

### 1. Instant Shareability

The moment I stop recording, I need a working URL which I can paste into Slack and the other person can watch immediately (or within a few seconds). It's what makes async video a viable replacement for a quick call or a long message. "Processing, check back in 2 minutes" is not okay.

### 2. Never Lose Footage

Recording a 20-minute tutorial and losing it to an upload glitch or encoding failure is unacceptable. The system must guarantee that footage is recoverable. In practice this means: the desktop app keeps a full local copy of everything it records; we design the system to be fault-tolerant and recover wherever possible; if the network drops mid-recording, we can usually recover even without the local raw backups. Etc. This principle also extends to the server side: processed videos should be backed up to durable storage.

### 3. I Own My URLs

Every video lives on `v.danny.is`, a domain I control – the public-facing URL is **mine**.

### 4. Permanent URLs

A video URL works forever. If I change a video's slug, the old URL becomes a 301 redirect to the new one. Videos embedded in Notion pages, Google Docs, and knowledge bases years from now must still work.

### 5. Reliability & Good UX for Viewers

When someone clicks a video link, it works. The video loads fast, buffers quickly, and plays smoothly — regardless of where the viewer is, what device they're on, or whether my server happens to be creaking at that moment. Viewer-facing video delivery must be first-class.

### 6. Simplicity

This tool does one thing: record, host, and share video. Every feature in it must be in service of doing those things **really well**. I'll never add features like comments, likes, reactions etc.

### 7. I'm the Only Creator Here

This product is **only for me**: nobody else will use the mac app or admin app. Nobody else will record videos. The only parts where other people matter are the public bits folks use to find and watch my videos. 

## Overview: The Fundamentals

1. macOS app – The recorder. A Swift/SwiftUI menubar app.
2. Backend API – Backend for the macOS app. Receives streamed HLS segments, runs post-processing, stores vide files. Hono & Bun deployed to a Hetzner VPS.
3. Admin Web App – Interface for managing my recordings. Part of the same Hono app but with it’s own auth and seperate admin API.
4. Viewer-facing surface - The public-facing pages, feeds etc. Part of the Hono app behind BunnyCDN.

## The Menubar UI

The menubar app is deliveratley very simple. Three drop-downs allow me to select a screen, camera and audio source and see a preview below. If both camera and video sources are set to “None” recording is disabled, and if only one is set the preview and UI adapts appropriately. If an audio source is selected sound meter is shown below the video preview.

If a camera source is selected, sliders to adjust white balance and brightness are shown and changes are reflected in the preview.

Below these there are selectors for **stream quality** and **starting mode**. Stream quality allows the user to choose between 720p, 1080p and 1440p for the uploaded stream. If no screen source is selected and the selected camera source is at 1080p, 1440p will not be available.

When screen and camera feeds have been selected, there are three modes available while recording:

- **Camera & screen** mode records the screen with the camera feed shown in a circle in the corner.
- **Screen only** mode hides the camera circle.
- **Camera only** mode replaces the screen recording with the camera feed.

Switching between theese in the menubar panel updates the preview appropriately and also dictates which mode the recording will *start* in. The mode can still be changed during recording.

## The Recording UI

While recording is in progress a toolbar is shown at the bottom of the screen with controls for ending, pausing and cancelling the recording, and for switching between modes. The mode switcher is only visible when both camera and screen feeds are available.

When not in screen-only mode, a draggable preview of the camera feed is also shown. This is circular when in screen-and-camera and rectangular when in camera-only.

Neither the camera preview or toolbar are captured in the actual screen recording, but dragging the camera preview between quadrants of the screen will cause the camera overlay in the final recording to move to that corner of the screen.

## The Basic Recording Lifecycle

I think the best way to explain how this all works is to walk through the process of recording a video together...

### 1. Open the Menubar App

When I open the menubar popover, lightweight preview sessions start for the camera and audio devices and the app begins polling for new devices and capturing screenshots for previewing the selected display. It also checks the server is reachable and the local data directory is writable. All this is torn down once the menubar popover is closed.

I select my input devices, check they look & sound okay in the preview and…

### 2. Hit Record

The recording toolbar shows a short countdown to me while in the background:

1. We immediatly start capture sessions for the available devices so they have time to warm up, check the audio source is actually providing samples and spin up the various writer sessions s they’re warm.
2. We hit the server to generate a UUID and unique slug, create a new video record and the required data directory on the server. The UUID and slug are returned.
3. We use the UUID to create a local data directory and an `init.mp4` to act as entrypoint for the local `m4s` segments.

When the countdown finishes we initiate an internal metronome and begin the various writers.

### 3. During Recording

We use two capture sessions: one for the screen and another for the camera+audio together (or just the audio of there’s no camera feed). These feed an orchestrator which maintains a metronome & recording clock, handles users pausing/unpausing (by pausing the clock), and deals with things like frame caching. It also writes three files to disk locally, directly from the capture sessions:

- `screen.mov` - The “raw” output of the ProRes screen capture session.
- `camera.mp4` - The “raw” output of the H.264 camera capture session, ignoring any adjustments to white balance & brightness. It includes an audio track.
- `audio.m4a` - The “raw” audio from the mic.

<Callout>
These are never sent to the server, but having the raw recordings localy means I can always pull them into Final Cut Pro if I need to do some proper editing. They also act as a reliable backup if composition fails.
</Callout>

The video we send to the server is *composited* from the capture streams, taking into account the users choices pre-recorging and any mode changes during recording:

- Camera adjustments like white balance are applied to the camera feed.
- The camera and screen feeds are downscaled and/or cropped to an appropriate size and aspect ratio for the recording, taking into account the selected stream quality.
- In screen+camera mode, the camera feed is rendered on top of the screen as a circle in the appropriate corner.
- The composited video reflects user changes to mode or overlay position.

The composited video is then written to disk as series of ~4s  `.m4s` segments and streamed up to the server via simple `PUT` requests via a queue. Failed `PUT`s are retried sensibly: even a ~10min connection loss will just cause the queued egments to strem up on reconnection. These `PUT`s are idempotent on the server.

A timeline of events is kept during recording which we’ll use later…

### 4. Hit Stop

When I hit stop on a recording the capture sessions are stopped immediatly and the writers stop as they finish their last job. If the `UploadActor` queue isn’t empty it’s given ten seconds to drain.

A `recording.json` is written to disk which includes:

- Basics like UUID, timestamps, duration etc.
- Details of how the composited video was encoded, input sources and raw writers used.
- A log of events during recording, each of which includes:
	- `kind` - type of event (eg `segment.uploaded` or `modeChange.CamOnly`)
	- `t` - time of event as seonds since metronome `T0`
	- `wallClock` - datetime of event per OS clock as UTC
	- `data` - Other stuff as object. Depends on the kind of event.
- A log of segments, each of which includes:
	- `bytes` - size of the segment
  - `durationSeconds` - segment duration rounded to the nearest second
  - `emittedAt` - Metronome time the segment was emitted.
  - `filename` - Filename on local filesystem (eg `seg_000.m4s`)
  - `index` - Order of segments chronologically (as recorded).
  - `uploaded` - True if any `PUT` for the segment returned OK, false if not.

The data above is also `POST`ed to `/:id/complete` which tells the server our client is done recodring. This kicks off the async post-processing pipeline below.

### 5. And As a User…

With the HLS segments on the server already, the public URL is instantly shareable (and on my clipboard) even though the post-processing tasks have barely started. 

If I want to quickly edit the title, slug or visibility of the video we just finished I can do so directly in the menubar app, or use it to open the video in the admin web app. 

## Post-Processing

When the sever recieves a `POST` to `/:id/complete` already have all the segments on disk and is serving them as a HLS playlist on the public URL. So the *complete* message just needs to write the recording data to a server-side `recording.json` and kick off a series of post-processing jobs…

### 1. Healing

Healing is the recovery mechanism for HLS segments that didn't make it during the live recording. The server know what segments it has on disk and now it has the client’s segments log it can compare the two and ask the client to resend any segments it’s missing or thinks are corrupted. Whenever the client resends segments for a video it will finish by re-triggering the *complete* process and sending a new `recording.json`.

<Clallout>
The *heal loop* runs after every recording, but it also runs against all videos recorded in the last three days whenever the mcOS app reconnects to the server. It walks the local recording folder for any session within the last 3 days where `recording.json` shows segments with `uploaded: false` and resends them. This catches any recordings where the app quit before healing finished, or where the network dropped and never came back.
</Callout>

### 2. Restitching

The first and simplest post-processing task is stitching the `m4s` segments into a single `source.mp4` file using `ffmpeg`.

As soon as we have a valid `source.mp4` available, we serve that to viewers instead of the HLS playlist.

### 3. Audio Enhancement

We run the audio through a high-pass filter at 80Hz and then the `cb.rnnn` model from [richardpl/arnndn-models](https://github.com/richardpl/arnndn-models). We do two-pass EBU R128 loudness normalisation with loudnorm.

The first pass runs the full chain (`highpass → arnndn → loudnorm`) with `print_format=json` and outputs a JSON file reflecting the post-denoised signal. The second pass uses the measurements from that to do the actual cleanup.

The result is written to the audio track of `source.mp4`.

### 4. Generating Derivitives

Now we have a clean `source.mp4` we can use it to generate some derivitive files we need:

- **Thumbnail candidates** — Multiple frames are extracted and scored by luminance variance. The “best” one is written to disk as `thumbnail.jpg` and used as the thumbnail in the admin interface and public-facing pages. The other candidates are also saved to disk so I can manually chose one in the admin app.
- **Metadata extraction** — We use ffprobe on `source.mp4` to grab useful metadata and (along with data from `recording.json`) write it to the database.
- **Video variants** — Downsampled variants are created and served to viewers alongside `source.mp4`. If our source is in 1080p we will only create a `720p.mp4`; if it’s 1440p we’ll create both `720p.mp4` and `1080p.mp4` derivitives.
- **Storyboard** - For videos longer than 60s we generate a `storyboard.jpg` and `storyboard.vtt` to provide previews when scrubbing in the player.


### 5. Transcription, Subtitles & Title Generation

While the post-processing above is best done server-side, doing any **AI stuff** on the server would mean paying for tokens on an external service or beefing up the server enough to run models on it. Since I have a pretty powerful laptop it makes more sense to do this stuff locally instead. So the macOS app includes WhisperKit for transcription.

Whenever a 60s+ video completes, the macOS app kicks off a task to transcribe the local `audio.m4a` and then use it and the  timing data from `recording.json` to generate a `captions.srt`.  Both sre stored locally on disk and also sent to the server – the transcript is written to the database and the `captions.src` is used to provide close captions in the web players.

If transcription completes successfully, the first ~500 words are fed to Apple Intelligence’s local Foundation Models along with a system prompt generated using data from `recordings.json` which is tasked with returning a suggested title for the video. The suggestion is checked against some simple *is-this-insane* rules and then sent to the server where it updates the video’s title (unless the user has already added a title).

## End State

For a 60+ second video with all input sources, we’ll end up with the following once all post-processing is finished:

### Database Record

The *videos* table in our SQL database will have a record something like this…

| Field            | Value                                  |
| ---------------- | -------------------------------------- |
| id               | `a1b2c3d4-e5f6-7890-abcd-ef1234567890` |
| slug             | `how-to-use-the-new-dashboard`         |
| status           | `complete`                             |
| visibility       | `unlisted`                             |
| title            | `How to Use the New Dashboard`         |
| description      | `null`                                 |
| duration_seconds | `187.4`                                |
| width            | `2560`                                 |
| height           | `1440`                                 |
| aspect_ratio     | `1.778`                                |
| file_bytes       | `48291840`                             |
| camera_name      | `FaceTime HD Camera`                   |
| microphone_name  | `MacBook Pro Microphone`               |
| recording_health | `null`                                 |
| source           | `recorded`                             |
| created_at       | `2026-04-30T14:22:03.841Z`             |
| updated_at       | `2026-04-30T14:29:17.205Z`             |
| completed_at     | `2026-04-30T14:25:44.012Z`             |
| trashed_at       | `null`                                 |

The `video_transcripts` table will also have a row for this video, holding the plain text of the transcript, a word count, and the format (`srt`). The actual subtitle file lives on disk as `captions.srt` — the database stores the parsed plain text for display and search.

### On Disk (Server)

The volume attached to our server will have a directory which looks something like this…

```
data/a1b2c3d4-e5f6-7890-abcd-ef1234567890/
├── init.mp4                          # HLS initialization segment (codec headers)
├── seg_000.m4s                       # ~4s media segments streamed during recording
├── seg_001.m4s
├── ...
├── seg_046.m4s
├── stream.m3u8                       # HLS playlist referencing init.mp4 + segments
├── recording.json                    # Timeline, events and segment log from the client
└── derivatives/
    ├── source.mp4                    # Stitched single-file MP4 with enhanced audio
    ├── 1080p.mp4                     # Downsampled variant (source is 1440p)
    ├── 720p.mp4                      # Downsampled variant
    ├── thumbnail.jpg                 # Auto-selected best frame
    ├── thumbnail-candidates/
    │   ├── auto-01.jpg               # Other candidate frames (cleaned up after 10 days)
    │   ├── auto-02.jpg
    │   └── auto-03.jpg
    ├── captions.srt                  # Subtitles uploaded by the macOS app
    ├── storyboard.jpg                # Sprite sheet of preview frames (videos ≥ 60s)
    └── storyboard.vtt                # Maps time ranges to sprite regions
```

### On Disk (Local)

Our mac will have a directory in `~/Application Support/LoomClone/recordings/[UUID]` which looks something like this…

```
~/Library/Application Support/LoomClone/recordings/a1b2c3d4-e5f6-7890-abcd-ef1234567890/
├── init.mp4                          # HLS initialization segment
├── seg_000.m4s                       # Composited ~4s segments (uploaded to server)
├── seg_001.m4s
├── ...
├── seg_046.m4s
├── screen.mov                        # Raw ProRes screen capture
├── camera.mp4                        # Raw H.264 camera + audio
├── audio.m4a                         # Raw AAC mic audio
├── recording.json                    # Timeline, events and segment log
├── captions.srt                      # Local backup of generated subtitles
└── .transcribed                      # Sentinel: transcription complete
```


## The Admin Interface

The admin interface lives at http://v.danny.is/admin and allows me to log in and manage my videos.

### The Video Page

- Changing the title, slug and visibility
- The video player
- Video Actions: Open, Copy, Embed, Edit, Download, Duplicate, Trash
- Video meta-information
- Description and tags
- Thumbnail Picker

#### The Event Log & File Browser

- Event Log
- File Browser
- Transcription

### The Video Editor

### The Dashboard

- Filters, Search & Sorting
- Vdieo Options

### Settings & Trash Bin

## Viewer-Facing Features

### The Video Page (/:slug)

- Basic info shown
- The Player: versions, poster, subtitles, storyboard, transcriptions etc.
- SEO & Metadata etc

### Other Formats

- `/:slug.json`
- `/:slug.md`
- `/:slug.mp4`

### Embedding

- Poster Frame etc from vidstack.
- `/:slug/embed` 
- The `/oembed` URL

### Public Feeds

- `/feed.xml` (and `/rss`)
- `/feed.json`
- `/llms.txt`
- `/` hints for LLMs and machines etc

### Slug Redirects


### Performance

- BunnyCDN
- Serving the right headers
- HTML stuff like preload etc

## Deployment & Backup

Just a quick note on deployment, archiving and backup, future plans etc.
