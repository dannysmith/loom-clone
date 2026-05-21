# Introducing my very own Loom

This is part of a series on TK

1. Part 1 - Introducing LC
2. Part 2 - Building LC as a "Technical Product Manager"

## Why I built this

[VIDEO - 30s Talking Head where I explain why and then basically say "And you're watching a video made with it right now"]

## Initial Requirements in a Nutshell

For this project to be worthwhile I need to be very clear about my fundamental requirements, and particularly those which differentiate it from existing tools like Loom, Cap or Supercut. So in a nutshell...

### 1. Mac app for recording

I want a native macOS menubar app which lets me record a video with as little friction as possible. It should...

- Let me record a screen: with or without a Loom-esque curcular camera feed in the corner.
- Let me switch instatly between the above and a high-quality **full-screen** camera feed for talking-head parts of the recording.
- Before recording, show enough information that I can be sure my audio, camera and screen are going to record properly.
- Let me pause and restart recording at will – I often do this in longer videos while I switch spaces, change slides or get ready for the next part of the recording.
- Make it easy to tweak the white balance and brightness of the camera feed before recording without having to mess with my actual camera settings.
- Save high-quality local copies of the screen, camera and microphone recordings so I can use Final Cut Pro to compose them into more complex videos if needed.
- Work reliably with the cameras and microphones I use to record videos.
- Put very little pressure on my CPU, GPU & RAM when not actually in use, and be performan when recording.

### 2. Viewing Videos

The macOS app should stream a *composited* video to a webserver **during recording**, so when I finish it's **instantly** available at a friendly URL I own (eg. https://v.danny.is/my-video). Any post-processing on the server acts to *entrich* that in the background.

### 3. Administering Videos

A Loom-like web app lets me edit, manage & organise my recordings, and upload videos recorded elsewhere. The admin app is optimised to reduce friction for my specific video-related workflows.

### 4. Other Requirements

- The backend can be easily deployed to a **cheap** European VPS, which ideally can be shared with other services I might want to run.
- The system is simple, resiliant and easy to manage and support long-term.

## Core Principles

Given how vage some of these requirements are, it seems sensible to also establish a few **fundamental principles** which are unlikeley to changes as my requirements evolve during the build.

### 1. Instant Shareability

The moment I stop recording, I need a **working** URL which I can share immediatly. This is what makes async video a viable replacement for quick video calls and long written messages. It's what differentiates tools like this from platforms like YouTube. "Processing, check back in 2 minutes" is not acceptable.

### 2. Never Lose Footage

Recording a 20-minute tutorial and losing it to an upload glitch or encoding failure is unacceptable. The system **must** guarantee that footage is recoverable. In practice this probably means: the desktop app keeps a full local copy of everything it records; we design the system to be fault-tolerant and recover wherever possible; if the network drops mid-recording, we can recover even without the local raw backups. Etc. This principle should extend to the server side: processed videos should be backed up to durable storage etc.

### 3. I Own My URLs

Every video lives on `v.danny.is`, a domain I control – the public-facing URL is **mine**.

### 4. Permanent URLs

A video URL works forever. If I change a video's slug, the old URL becomes a 301 redirect to the new one. Videos embedded in Notion pages, Google Docs, and knowledge bases years from now must still work.

### 5. Reliability for Viewers

When someone clicks a video link, it works. The video loads fast, buffers quickly, and plays smoothly — regardless of where the viewer is, what device they're on, or whether my server happens to be creaking at that moment. Viewer-facing video delivery must be first-class.


### 6. Discoverability & Viewer UX

We're a good *web citizen*. Our public-facing endpoints serve semantic content which works in a variety of contexts. Public videos are SEO-friendly and are discoverable via RSS feeds, LLM-facing endpoints and the like.

<Callout title="Recording Visibility">
- **Unlisted** vidoes are the default. They are publically available but are not easily *discoverable* unless you know their URL. The vast majority of my videos will be of this type.
- **Public** videos are discoveravle via RSS & JSON feed and can be indexed by search engines.
- **Private** vidoes are not available anywhere except via the admin interface and cannot be shared. These are intended for personal notes and videos I want to keep private until I’m ready to share them.
</Calout>

### 7. Simplicity

The whole system is designed with one goal in mind: **allowing me to record, host, and share videos**. Every feature must be in service of doing those things **really well**. I'm unlikeley to ever add features like comments, likes, reactions etc because they do not serve this end.

Similarly, the codebase and technology stack should be as simple as possible.

### 8. I'm the Only Creator Here

This product is **only for me**. Nobody else will use the mac app or admin app. Nobody else will record videos. The only parts where other people matter are the public-facing bits where folks find and watch my videos. 

## The System

All this led me to start thinking about the system as having four main components.

1. **macOS Menubar App** – The recorder. A simple native Swift/SwiftUI menubar app which uses Apple APIs to record and stream as efficiently as possible.
2. **Backend API** – Backend for the macOS app. Receives streamed HLS segments, runs post-processing, stores video files.
3. **Admin Web App** – Web interface for managing my recordings with it’s own auth and admin API.
4. **Viewer-facing Surface** - The public-facing pages, feeds etc.

In an effort to keep things simple, the Backend API, Admin Web App and Viewer-facing Surface are all served by the same Hono app, deployed to a Hertzner VPS. The viewer-facing endpoints are behind BunnyCDN.

Let's look at each of these components in turn...

## The Menubar UI

[VIDEO Menubar app]

The menubar app is deliveratley very simple. Three drop-downs allow me to select a screen, camera and audio source and see a preview below. If both camera and video sources are set to “None” recording is disabled, and if only one is set the preview and UI adapts appropriately. If an audio source is selected sound meter is shown below the video preview.

If a camera source is selected, sliders to adjust white balance and brightness are shown and changes are reflected in the preview.

Below these there are selectors for **stream quality** and **starting mode**. Stream quality allows the user to choose between 720p, 1080p and 1440p for the uploaded stream. If no screen source is selected and the selected camera source is at 1080p, 1440p will not be available. Framerate can be selected in a similar way (30fps or 60fps).

When screen and camera feeds have been selected, there are three modes available while recording:

- **Camera & screen** mode records the screen with the camera feed shown in a circle in the corner.
- **Screen only** mode hides the camera circle.
- **Camera only** mode replaces the screen recording with the camera feed.

Switching between theese in the menubar panel updates the preview appropriately and also dictates which mode the recording will *start* in. The mode can still be changed during recording.

Expanding the *Hide from recording* section allows us to hide stuff from the screen recorder.

1. **Desktop icons** - When checked, finder’s desktop icons will be hidden in the screen recording.
2. **App Windows** - Any ckecked apps will have their windows hidden in the screen recording. Currently running apps are shown alongside the five most-recently selected apps (whether they’re running or not).

## The Recording UI

[IMAGE Recording UI]

When recording is in progress a toolbar is shown at the bottom of the screen with controls for ending, pausing and cancelling the recording, and for switching between modes. The mode switcher is only visible when both camera and screen feeds are available. I can set a chapter marker by hitting a button in the toolbar.

[IMAGE Annotated toolbar with 4 chapter markers set]

When not in screen-only mode, a draggable preview of the camera feed is also shown. This is circular when in screen-and-camera and rectangular when in camera-only.

Neither the camera preview or toolbar are captured in the actual screen recording, but dragging the camera preview between quadrants of the screen will cause the camera overlay in the final recording to move to that corner of the screen.

## The Basic Recording Lifecycle

The best way to explain the finer details is for us to walk through the recording process together...

### 1. We Open the Menubar App

When I open the menubar popover, lightweight preview sessions start for the camera and audio devices and the app begins polling for new devices and capturing screenshots for previewing the selected display. It also checks the server is reachable and the local data directory is writable. All this is torn down once the menubar popover is closed.

I select my input devices, check they look & sound okay in the preview and…

### 2. We Hit Record

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

These are never sent to the server, but having the raw recordings localy means I can always pull them into Final Cut Pro if I need to do some proper editing. They also act as a reliable backup if composition fails.

The video we send to the server is *composited* from the capture streams using the upload resolution and framerate selected before recording.

- Camera adjustments for white balance & brightness are applied to the camera feed.
- The camera and screen feeds are downscaled and/or cropped to an appropriate size and aspect ratio for the recording, taking into account the selected stream quality.

<Callout title="User Actions While Recording">
The following user actions will affect the composited recording.

- Pressing **pause** in the toolbar will temporarily pause all recording streams until **unpause** is pressed.
- Pressing **chapter marker** in the toolbar will add an anonymous marker to the recording timeline which can later be edited in the admin app to create viewer-facing chapter markers. If pressed while paused it will be added at the next unpause timestamp.
- Changing the **mode** in the toolbar will cause the composited recording to show the relevant feed (screen or camera). In screen & camera mode the camera feed is rendered as a small circular overlay in a corner of the screen.
- Moving the camera preview from one quadrant to another (eg. from bottom-right to top-left) will cause it to be shown in that corner in the composited output when in screen & camera mode.
</Callout>

The composited video is then encoded at an appropriate bitrate and written to disk as series of ~4s  `.m4s` segments abefore being streamed to the server via a queue of simple `PUT` requests. Failed `PUT`s are retried sensibly: even a ~10min connection loss will just cause the queued egments to strem up on reconnection. These `PUT`s are idempotent on the server.

A recording timeline is periodically written to a temporary file on disk to facilitate recovery if anything goes wrong.

### 4. We Hit Stop

When we hit stop, the capture sessions are terminated and the writer processes are terinated after their next write job finishes. If the `UploadActor` queue isn’t empty it’s given ten seconds to finish uploading before any remaining are marked as *failed* locally.

The recording timeline is used to write a `recording.json` to disk which includes:

- Basic info like UUID, start/end timestamps, duration etc.
- Details of the input source hardware and raw writers used.
- Details of the composited writer including the encoder and streaming settings.
- A log of timeline events during recording, each of which includes:
	- `kind` - type of event (eg `segment.uploaded` or `modeChange.CamOnly`).
	- `t` - time of event as seonds since metronome `T0`.
	- `wallClock` - datetime of event per OS clock as UTC.
	- `data` - Other stuff as object. Depends on the kind of event.
- A log of segments written, each of which includes:
	- `bytes` - size of the segment.
  - `durationSeconds` - segment duration.
  - `emittedAt` - Metronome time the segment was emitted.
  - `filename` - Filename on local filesystem (eg `seg_000.m4s`).
  - `index` - Order of segments chronologically (as recorded).
  - `uploaded` - True if any `PUT` for the segment returned OK, false if not.

The data above is then `POST`ed to `/:id/complete` which tells the server our client is done recodring. This kicks off the async post-processing pipeline below.

### 5. We share the video

With the HLS segments on the server already, the public URL is instantly shareable (and now on our clipboard), even before any post-processing tasks are started. If we want to quickly edit the title, slug or visibility we can do so directly in the menubar app, or use it to open the video in the admin web app.

## Post-Processing

When the sever recieves a `POST` to `/:id/complete` it already has all the segments on disk and is serving them as an HLS playlist on the public URL. So the *complete* signal just causes the data in `recording.json` to be written server-side and kicks off a series of post-processing jobs.

### 1. Healing

Healing is the recovery mechanism for HLS segments that didn't make it during live recording. The server knows what segments it has on disk and now it has the client’s segments log it can compare the two and ask the client to resend any segments it’s missing or thinks are corrupted. Whenever the client finishes resending segments for a video it will finish by re-triggering the *complete* process and sending a new `recording.json`.

<Clallout>
The *heal loop* runs after every recording, but it also runs against all videos recorded in the last three days whenever the mcOS app reconnects to the server. It walks the local recordings folder for any video within the last 3 days where `recording.json` shows segments with `uploaded: false` and resends them. This catches any recordings where the app quit before healing finished, or where the network dropped and never came back.
</Callout>

### 2. Restitching

The first and simplest post-processing task is stitching the `m4s` segments into a single `source.mp4` file using `ffmpeg`. As soon as we have a valid `source.mp4` available, we serve that to viewers instead of the HLS playlist.

### 3. Audio Enhancement

We run the audio through a high-pass filter at 80Hz to remove rumble and then the `cb.rnnn` model from [richardpl/arnndn-models](https://github.com/richardpl/arnndn-models) to denoise the speech. This is followed by stationary-noise cleanup with `afftdn` and a pass through `agate` to identify the speech parts of the cleaned audio. `dynaudnorm` then operates on the gated regions to normalise speech volume before we do two-pass EBU R128 loudness normalisation with loudnorm.

The result is written to the audio track of `source.mp4`. We also generate a `peaks.json` which is used in the *Video Editor* to render a waveform and suggest areas to trim or cut.

### 4. Generating Derivitives

Now we have a clean `source.mp4` we can use it to generate some derivitive files we need:

- **Thumbnail candidates** — Multiple frames are extracted and scored by luminance variance. The “best” one is written to disk as `thumbnail.jpg` and used as the thumbnail in the admin interface and public-facing pages. The other candidates are also saved to disk so I can manually chose one in the admin app.
- **Metadata extraction** — We use ffprobe on `source.mp4` to grab useful metadata and (along with data from `recording.json`) write it to the database.
- **Video variants** — Downsampled variants are created and served to viewers alongside `source.mp4`. If our source is in 1080p we will only create a `720p.mp4`; if it’s 1440p we’ll create both `720p.mp4` and `1080p.mp4` derivitives.
- **Storyboard** - For videos longer than 60s we generate a `storyboard.jpg` and `storyboard.vtt` to provide previews when scrubbing in the player. We also generate more deailed versions for use in the admin app's video editor.


### 5. Transcription, Subtitles & Title Generation

While the post-processing above is best done server-side, doing any **AI stuff** on the server would mean paying for tokens on an external service or beefing up the server enough to run models on it. Since I have a pretty powerful laptop it makes more sense to do this stuff locally instead. So the macOS app includes WhisperKit for transcription and makes use of Apple's built-in foundation models.

When a video completes, the macOS app kicks off a task to transcribe the local `audio.m4a` and then use it and the timing data from `recording.json` to generate a `captions.srt`. Both are stored locally on disk and also sent to the server: the transcript is written to the database and the `captions.src` is used to provide closed captions in the video players.

If transcription completes successfully, the first ~500 words are fed to Apple's local Foundation Model along with a system prompt and some data from `recordings.json` which is tasked with returning a suggested title for the video. The suggestion is checked against some simple *is-this-insane* rules and then sent to the server where it updates the video’s title (unless the user has already added a title).

We use the same process to generate a suggested description and – if chapter markers exist – to suggest titles for each of them.

## End State

For a video with all input sources, we’ll end up with the following once all post-processing is finished:

### Database Record

The *videos* table in our SQL database will have a record something like this…

| Field            | Description                                                                       | Example Value                          |
| ---------------- | --------------------------------------------------------------------------------- | -------------------------------------- |
| id               | UUID, primary key.                                                                | `a1b2c3d4-e5f6-7890-abcd-ef1234567890` |
| slug             | Current URL slug. Unique. Old slugs live in `slug_redirects` for 301s.            | `how-to-use-the-new-dashboard`         |
| status           | `recording`, `healing`, `processing`, `complete`, `failed` or `deleting`.         | `complete`                             |
| visibility       | `public`, `unlisted` or `private`.                                                | `unlisted`                             |
| title            | Display title. Null until set by the user or the AI suggestion step.              | `How to Use the New Dashboard`         |
| description      | Public-facing description. Null until set.                                        | `null`                                 |
| notes            | Private notes — admin-only, never exposed publicly.                               | `null`                                 |
| duration_seconds | Cached at completion so list views don't need to sum segment durations.           | `187.4`                                |
| width            | Pixel width of `source.mp4`, from ffprobe.                                        | `2560`                                 |
| height           | Pixel height of `source.mp4`, from ffprobe.                                       | `1440`                                 |
| aspect_ratio     | Width / height, cached for layout work.                                           | `1.778`                                |
| file_bytes       | Size of `source.mp4` in bytes.                                                    | `48291840`                             |
| camera_name      | Camera device name captured from `recording.json`.                                | `FaceTime HD Camera`                   |
| microphone_name  | Mic device name captured from `recording.json`.                                   | `MacBook Pro Microphone`               |
| recording_health | Summary of any recording issues (dropped frames, failed segments). Null if clean. | `null`                                 |
| source           | `recorded` (from the macOS app) or `uploaded` (via the admin web upload).         | `recorded`                             |
| created_at       | Row creation timestamp (ISO-8601).                                                | `2026-04-30T14:22:03.841Z`             |
| updated_at       | Last update timestamp (ISO-8601).                                                 | `2026-04-30T14:29:17.205Z`             |
| completed_at     | Set on first transition to `complete`; never overwritten on re-complete.          | `2026-04-30T14:25:44.012Z`             |
| trashed_at       | Set when the video is moved to the trash bin; null otherwise.                     | `null`                                 |
| last_edited_at   | Set when edits are committed via the video editor; null if never edited.          | `null`                                 |

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
├── chapters.json                     # Chapter markers (extracted from recording.json, user-editable)
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
    ├── words.json                    # Per-word transcript timings (used by the editor)
    ├── peaks.json                    # Audio waveform peaks for the editor
    ├── suggested-edits.json          # AI-suggested silence/filler cuts for the editor
    ├── storyboard.jpg                # Sprite sheet of preview frames (videos ≥ 60s)
    ├── storyboard.vtt                # Maps time ranges to sprite regions
    ├── editor-storyboard.jpg         # Higher-density sprite sheet for the editor
    └── editor-storyboard.vtt         # Maps time ranges to editor sprite regions
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
├── diagnostics.json                  # Recording-time diagnostic snapshot
├── captions.srt                      # Local backup of generated subtitles
├── words.json                        # Local backup of per-word transcript timings
└── .transcribed                      # Sentinel: transcription complete
```

## Managing Local Recordings

The macOS app has a settings pane which allows us to manage local recordings. We can see any which failed, errored or were orphaned. We can save space by deleting the local backups (`camera.m4a`, `screen.mov` and `audio.m4`) or the local HLS segments, or delete the whole thing.

[IMAGE Settings Pane]

## The Admin Interface

The admin interface lives at http://v.danny.is/admin and is a web interface for managing my videos. The dashboard has grid and table views with controls for sorting and filtering videos. Searching will show all videos whose title, description, slug or transcript match.

[VIDEO Dashboard demo]

*Trashing* a video will move it to the **trash bin**, disable its public endpoints and remove it from any public feeds. Trashed videos can be restored or permenantly deleted from the trash bin.

[IMAGE Trash bin]

I can also upload an `mp4` video directly via the web interface, and the server will run as much of the post-processing pipeline as it can.

[IMAGE Upload screen]

### The Video Page

The video page lets me watch the video and edit various 

[VIDEO Video Page Walkthrough]

- Basic Actions:
  - Open Public URL
  - Copy Public URL
  - Copy Public URL at Current time
  - copy embed HTML
  - Edit Video
  - Download
  - Duplicate
  - Trash
- Edit Video Data:
  - Title
  - Visibility
  - Description
  - Edit Slug
    - Prepend date
    - Append string
    - Generate from title
  - Tags
  - Private Notes
- Video meta-information:
  - Status & "Edited" marker
  - Date
  - Resolution
  - Size on Disk
  - Camera
  - Mic
  - UUID
- Thumbnails
  - Selecting
  - Deleting
  - Uploading
  - Editor
- Details
  - Event Log
  - File Browser
  - Transcription

### The Video Editor

The 

[VIDEO Video Editor Demo]


- Trimming
- Clipping
- Comitting & Regen
- Undo
- Suggested Clips
- Chapter markers

### The Thumbnail Editor

[VIDEO Cover Editor Demo]

- Generating a cover image
- Generating an image for external use

### Tags

[IMAGE Tag Settings Page]

- Tag management
- Tag slugs & visibility

## Viewer-Facing Features

### The Video Page (/:slug)

[IMAGE Video Page]

- Basic info shown
- The Player: versions, poster, subtitles, storyboard, transcriptions etc.
- SEO, Metadata, JSONL, Microformats etc
- Preload, HTTP Headers etc

### Embedding

[IMAGE Video Embed Page]

- Poster Frame etc from vidstack.
- `/:slug/embed` 
- The `/oembed` URL

<Callout title="Embedding on this site">
I don't use these endpoints to embed videos on this site...
</Callout>

### Other Formats

- `/:slug.json`
- `/:slug.md`
- `/:slug.mp4`

### Tag Pages

[IMAGE Tag Page]

### Discoverability

#### RSS Feeds

- `/feed.xml` (and `/rss`)
- `/feed.json`
- `/:tag/feed.xml` and `/:tag/feed.json`

#### AI-Facing Features

- `/llms.txt`
- `/` hints for LLMs and machines etc

## Infrastructure

- The Server
- Docker & Volumes
- Deployment
- BunnyCDN & Cache Busting
- Backups
