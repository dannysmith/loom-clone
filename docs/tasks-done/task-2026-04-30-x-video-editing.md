# Task — Web-Based Video Editing

Unprioritised. This document captures the full design discussion so a future session can implement it.

## What we're building

A trim/cut editor in the admin web app that lets you remove unwanted sections from recorded or uploaded videos. The immediate scope is:

- **Trim** — remove from the beginning and/or end of a video
- **Cut** — remove one or more sections from the middle of a video

The editor runs in the browser. The actual video processing (applying edits) happens server-side via ffmpeg. Edits are non-destructive — the original source video is always preserved, and edit decisions are stored as a JSON file that can be re-applied or modified later.

### Why this matters

Quick recordings often have rough starts/ends ("okay let me share my screen..."), false starts, filler sections, or mistakes mid-recording that should be cut before sharing. Currently there's no way to clean these up without downloading the video, editing locally, and re-uploading.

### Possible Future scope (not in this task, but informs technology choices)

We may never end up building these, but it's worth being aware of them for now. 

- **Multi-track editing** — when the macOS app's raw camera, screen, and audio tracks are uploaded separately, a richer editing experience with per-track control and re-composition.
- **Overlay graphics** — pre-built overlays for lower thirds, titles, logos. Libraries like Diffusion Studio Core or Etro.js could handle client-side preview of these, with server-side ffmpeg for final rendering.

These don't need to be designed now, but the architecture shouldn't preclude them.

## Architecture

### Client-side preview, server-side rendering

This is the pattern every shipping web video editor converges on. The browser provides the interactive editing UI; the server does the heavy processing. For our setup this is a clear win — ffmpeg is already on the server, the videos are already on disk, and the derivatives pipeline already exists.

We skip the heavy client-side technologies:

- **FFmpeg.wasm** — ~25MB WASM download, 10-20x slower than native, requires COOP/COEP headers. Server-side ffmpeg is faster and already exists.
- **WebCodecs** — powerful but adds complexity (needs a demuxer library, worker setup, frame management). Overkill for trim/cut. Worth revisiting for future multi-track or overlay work.
- **MSE (Media Source Extensions)** — designed for adaptive streaming, not editing.
- **Remotion** — designed for programmatic video generation from React components, not editing pre-recorded footage. Wrong tool for trim/cut.

### Dedicated page, Vite + React

The editor lives at `/admin/videos/:id/editor`, linked from the video detail page's action bar. It is a small Vite + React application, built as part of the server build process, with output served by Hono as static assets.

Why a separate app rather than extending the HTMX admin panel:

- A video editor has complex interactive state (timeline position, zoom, drag handles, undo/redo stack, playback sync) that benefits from React's model. The rest of the admin panel's HTMX + vanilla JS approach is wrong for this kind of UI.
- A dedicated page keeps the complexity isolated. The video detail page stays clean.
- Vite provides HMR during development, which matters for iterating on interactive UI.

The Hono route for `/admin/videos/:id/editor` returns a server-rendered HTML shell (with admin auth check, video ID embedded as a data attribute or JSON blob) that loads the bundled React app. The editor communicates with the server via JSON API endpoints.

The rest of the admin panel is completely unaffected.

### React, not Preact

React proper rather than Preact. The bundle size difference (~40KB vs ~3KB) is negligible when you're loading a video file. React avoids any compat surprises with libraries (wavesurfer.js has official React bindings). If a more complex React library is ever needed for future editing features, it just works.

### Build tooling

Vite with the React plugin, living in something like `server/editor/` with its own `package.json`. Production build output goes to a directory Hono serves (e.g. `server/public/editor/`). Built as part of the server build (`bun run build:editor` or similar). Bun's bundler was considered but lacks a dev server with HMR, which matters for iterating on this kind of UI.

## Editor UI

### Video preview

A standard `<video>` element playing `source.mp4` (which supports range requests for seeking). The video element provides playback and seeking — no need for WebCodecs or canvas-based rendering for trim/cut operations.

### Waveform display

**wavesurfer.js** (v7+, BSD-3, ~10k GitHub stars) with the **Regions plugin**. Regions give draggable, resizable highlighted areas on the waveform — used for trim boundaries and cut sections. The waveform syncs to the `<video>` element automatically. Official React bindings available via `@wavesurfer/react`.

Peak data is pre-computed server-side and served as JSON (`derivatives/peaks.json`). wavesurfer.js consumes this directly, avoiding the need to decode audio in the browser. Client-side fallback via Web Audio API's `decodeAudioData()` is cheap to implement for cases where peaks haven't been generated yet.

### Timeline thumbnails

A dense editor-specific storyboard, separate from the viewer-facing one. Generated server-side during the derivatives pipeline:

- 1 frame per second for videos up to 10 minutes
- 1 frame every 2 seconds beyond 10 minutes
- Thumbnails at ~200px wide, tiled into sprite sheet(s) with a VTT mapping file
- Stored as `derivatives/editor-storyboard.jpg` + `derivatives/editor-storyboard.vtt`

For a 40-minute video at 0.5fps, this produces ~1,200 frames — a large sprite sheet but manageable for a single-user admin tool on a fast connection.

### Word-level transcript overlay

When word-level timestamp data is available (see the transcription changes below), individual words are displayed along the timeline. When zoomed in, words appear aligned with the waveform — useful for identifying and removing filler words precisely. This is an enhancement, not a requirement — the editor works fine without transcript data.

### Keyboard shortcuts

Standard editor conventions: space for play/pause, arrow keys for frame stepping, shortcuts for zoom, mark cut start/end, undo/redo (Ctrl+Z / Ctrl+Shift+Z). These are well-established patterns.

### Undo/redo

The edit state (trim boundaries, cut regions) is a simple data structure. Undo/redo is a client-side history stack of states — each edit action pushes a new state. The history lives only for the editing session and is cleared on commit.

### Commit flow

A "commit" button with a confirmation dialog ("This will re-process the video"). Sends the EDL to the server, which triggers the processing pipeline. The user waits for processing to complete (seconds for short videos, a minute or two for 30-40 minute recordings).

## Edit Decision List (EDL)

Edits are stored as a JSON file alongside the derivatives:

```json
{
  "version": 1,
  "source": "source.mp4",
  "edits": [
    { "type": "trim", "startTime": 2.5, "endTime": 175.0 },
    { "type": "cut", "startTime": 45.2, "endTime": 52.8 },
    { "type": "cut", "startTime": 120.0, "endTime": 125.5 }
  ]
}
```

Stored at `derivatives/edits.json`. This is the recipe for producing the edited output from source.mp4. It can be viewed, modified, or deleted to revert to the original.

The EDL is always a complete description — not incremental. When the user re-opens the editor for a previously edited video, the existing `edits.json` is loaded and the current edit state is shown. The user can modify (add/remove cuts, adjust trim) and re-commit. Each commit re-derives everything from `source.mp4` + the updated EDL.

OpenTimelineIO (the industry standard from Pixar/ASWF) was considered but is C++/Python only and vastly overcomplicated for single-video trim/cut. The simple JSON format is easily extensible for future multi-track or overlay features.

## Server-side processing

### ffmpeg operations

Full re-encode for all committed edits. This is simpler than partial stream-copy and guarantees frame-accurate cuts and clean audio.

Use a fast encoding preset (`-preset fast` or `-preset veryfast`) — the visual quality difference is negligible for screen recordings and talking head content, and it significantly affects processing time on the Hetzner VPS (modest x86, no GPU). With a fast preset, a 5-minute 1080p video processes in well under a minute. A 40-minute video may take a few minutes.

Audio joins at cut points use a short crossfade (~20-50ms) to eliminate clicks/pops from hard splices.

### File naming

The edited output is named by its resolution, not as "edited.mp4":

```
derivatives/
  source.mp4          # untouched original — never modified
  edits.json          # the EDL
  1440p.mp4           # edited output at source resolution (if source is 1440p)
  1080p.mp4           # downscaled from edited output
  720p.mp4            # downscaled from edited output
```

This is consistent with how downscaled variants already work. Previously, a `{resolution}p.mp4` file at the source's own resolution wasn't generated because it would be identical to `source.mp4` — a waste of disk space. With editing, the presence of that file is a filesystem-level signal that the video has been edited.

Viewer-facing routes serve the resolution file when it exists, falling back to `source.mp4` when no edits have been applied.

### What gets regenerated on commit

1. Produce the edited video from `source.mp4` + `edits.json` via ffmpeg (full re-encode with audio crossfades at cut points)
2. Regenerate downscaled variants (1080p, 720p) from the edited output
3. Regenerate public-facing storyboard from the edited output
4. Generate edited captions by applying the EDL to the word-level transcript data (drop words in cut regions, shift subsequent timestamps) — no AI/Whisper needed, pure timestamp arithmetic
5. Update DB metadata (`durationSeconds`, `fileBytes`) via ffprobe on the edited output
6. Update DB transcript (`plain_text`, FTS index) with the edited transcript text
7. Set `lastEditedAt` timestamp
8. Purge CDN cache for the affected slug (video files, storyboard, captions, metadata routes) — uses the existing BunnyCDN purge mechanism in `server/src/lib/cdn.ts`

Audio processing (loudnorm + denoise) is NOT re-run. The audio in `source.mp4` is already processed. Cuts just remove sections of already-processed audio.

Thumbnail is NOT regenerated. If the current thumbnail falls within a cut region, it still works fine as a poster image. The user can upload a manual thumbnail if needed.

### Reverting edits

Delete `edits.json`, remove the resolution-named files, and re-run the standard derivatives pipeline from `source.mp4`. The DB fields update back to the original values naturally.

## Data model changes

Minimal. The DB fields (`durationSeconds`, `fileBytes`, `width`, `height`) always reflect what viewers see — the edited version when edits exist, the original otherwise. This means the dashboard, feeds, metadata routes, and search all show the right values with zero conditional logic.

One new field on the `videos` table:

- `lastEditedAt` — nullable timestamp, set when edits are committed

No new tables. No duplicate columns. The originals are preserved on disk (source.mp4, words.json), not duplicated in the DB.

The `lastEditedAt` field drives an "Edited" badge on the admin video detail page, with a link to the editor.

## Transcription changes

Two changes to the transcription system, independent of the editor but required for the word-level timeline display and for deriving edited transcripts.

### Enable word-level timestamps in WhisperKit

Currently, `TranscribeAgent.swift` calls `pipe.transcribe(audioPath:)` with no options, so `wordTimestamps` defaults to `false` and `segment.words` is always `nil`. Enabling it is a one-line change:

```swift
let options = DecodingOptions(wordTimestamps: true)
results = try await pipe.transcribe(audioPath: audioPath.path, decodeOptions: options)
```

Each `WordTiming` struct provides: `word` (String), `start` (Float, seconds), `end` (Float, seconds), `probability` (Float, confidence score).

### Send word-level data to the server

Currently only the SRT file is sent to the server. We'd also send a word-level JSON payload — either via a new endpoint or an extension of the existing transcript PUT. Stored as `derivatives/words.json`:

```json
[
  { "word": "So", "start": 0.0, "end": 0.18 },
  { "word": "here's", "start": 0.2, "end": 0.45 },
  { "word": "how", "start": 0.47, "end": 0.62 },
  { "word": "um", "start": 0.8, "end": 1.1 },
  { "word": "this", "start": 1.15, "end": 1.3 }
]
```

The word-level data preserves everything (including filler words like "um") for accurate timeline display in the editor. The SRT and DB plain text can have filler words cleaned up separately if desired — these are different concerns.

The `words.json` file also serves as the best "original transcript" backup on disk — it contains every word with timestamps, from which SRT and plain text can be reconstructed.

### Timing alignment

WhisperKit transcribes `audio.m4a` locally, producing timestamps relative to t=0 of that file. Both `audio.m4a` and the HLS segments (which become `source.mp4`) share the same `recordingStartTime` as their PTS origin, so word timestamps should map directly to source.mp4 playback time without offset correction. Worth validating empirically on a real recording — if there's a small consistent offset, it can be corrected.

### Lower transcript threshold

Currently transcription only runs for videos > 60 seconds. Lower this to ~5 seconds so that most real videos get transcripts (excluding only very short test recordings).

## Implementation status

All phases are implemented. See `docs/developer/admin-editor.md` for the full developer guide.

### Phase 1 — Transcription enhancements (done)

Word-level timestamps enabled in WhisperKit. `words.json` sent alongside SRT. Server endpoint at `PUT /api/videos/:id/words`. Transcript duration threshold lowered to 5 seconds.

### Phase 2 — Server-side editor infrastructure (done)

`lastEditedAt` field on videos table. Editor storyboard + audio peaks generation in the derivatives pipeline. EDL API endpoints (load, save, commit). ffmpeg edit pipeline with trim/cut, audio crossfade, full re-encode. Edited transcript derivation from `words.json` + EDL. `"processing"` status during edit pipeline execution with guards against concurrent edits.

### Phase 3 — Editor UI (done)

Vite + React app at `server/editor/`. Video preview, wavesurfer.js waveform with Regions, timeline thumbnail strip with drag-to-scrub, trim/cut toolbar buttons with keyboard shortcut indicators, undo/redo, commit flow with spinner and navigation.

### Phase 4 — Word-level transcript overlay (done)

Words displayed along the timeline from `words.json`. Current word highlighted during playback. Words in cut regions shown with strikethrough, trimmed words dimmed. Click-to-seek.

### Phase 5 — Admin integration and polish (done)

"Edit video" button on detail page (complete videos only). "Edited" badge driven by `lastEditedAt`. Detail page player and download links serve the edited version via `activeRawFilename()`. All viewer-facing routes (page, embed, feeds, sitemap, metadata, API) serve the correct file via centralised `urlsForVideo()` and `activeRawFilename()`. CDN cache purging on commit. Backup script includes `edits.json` and `words.json`.

### Remaining work and known issues

- The waveform region rendering when re-opening an edited video may have timing issues — the regions sync depends on React effect ordering with wavesurfer's ready event. Needs testing with more real-world use.
- The timing alignment between WhisperKit word timestamps and source.mp4 playback should be validated empirically — see the Timing alignment section above.
- No zoom control on the timeline yet. For precise cuts on long videos, a zoom mechanism would help.
- No visual indicator on the thumbnail strip for which sections are cut/trimmed.

## Research references

Libraries evaluated during the design discussion:

- **wavesurfer.js** (chosen) — ~10k stars, BSD-3, waveform rendering with Regions plugin for segment marking. Official React bindings.
- **peaks.js** (BBC) — purpose-built for audio clipping, but less actively maintained, no React bindings.
- **Diffusion Studio Core** — ~1.2k stars, WebCodecs + Canvas, ~49KB. Relevant for future overlay/composition work, not for trim/cut.
- **Etro.js** — ~1.1k stars, Canvas/WebGL, GPL-3.0 (licence concern). Also relevant for future overlay work.
- **Omniclip** — ~1.4k stars, MIT. Full web NLE, good reference architecture for future multi-track work.
- **OpenReel Video** — ~563 stars, MIT, React. CapCut-style editor, another reference for future work.
- **FFmpeg.wasm** — ~17k stars. Powerful but unnecessary when server-side ffmpeg exists. 25MB download, 10-20x slower than native.
- **Remotion** — ~20k stars. Wrong tool for editing pre-recorded footage; designed for programmatic video generation.
- **OpenTimelineIO** (Pixar/ASWF) — ~1.8k stars. Industry EDL standard but C++/Python only, overcomplicated for this use case.
