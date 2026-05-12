# Admin Video Editor

How the web-based video editor works — architecture, build process, editing pipeline, and the relationship between source files and edited derivatives.

## Architecture overview

The editor is a React app that runs inside the admin panel at `/admin/videos/:id/editor`. It communicates with the Hono server via JSON API endpoints. Editing decisions are stored as a JSON "edit decision list" (EDL). The actual video processing (applying edits via ffmpeg) happens server-side when the user clicks "Commit."

```
Browser (React editor)              Server (Hono + Bun)
  │                                    │
  │  GET /admin/videos/:id/editor      │  serves HTML shell loading React bundle
  │  GET /:id/editor/edl               │  returns current edits.json (or empty EDL)
  │  GET /:id/editor/media/peaks.json  │  audio waveform peaks
  │  GET /:id/editor/media/words.json  │  word-level transcript timestamps
  │  GET /:id/media/raw/source.mp4     │  the editor always plays the original
  │                                    │
  │  PUT /:id/editor/edl               │  save edit decisions (no processing)
  │  POST /:id/editor/commit           │  trigger ffmpeg processing pipeline
  │                                    │
  │                                    │  → sets status to "processing"
  │                                    │  → runs ffmpeg trim/cut/crossfade
  │                                    │  → regenerates variants, storyboard, captions
  │                                    │  → updates DB metadata
  │                                    │  → purges CDN cache
  │                                    │  → sets status back to "complete"
```

## Why it's a separate React app

The rest of the admin panel uses HTMX + vanilla JS with server-rendered Hono JSX. That's the right choice for CRUD forms and page navigation. A video editor needs continuous state management (timeline position, zoom, drag handles, undo/redo stack, playback sync) that benefits from React's model. Keeping it as a separate Vite + React sub-project means the editor's complexity doesn't leak into the rest of the admin panel.

## Project structure

```
server/editor/              # Vite + React sub-project
  package.json              # separate dependencies (react, wavesurfer.js, vite)
  tsconfig.json             # React JSX config (not hono/jsx)
  vite.config.ts            # base="/static/editor/", builds to ../public/editor/
  index.html                # Vite entry point template
  src/
    main.tsx                # React entry — reads data attributes from the HTML shell
    App.tsx                 # orchestrates all components and hooks
    api.ts                  # fetch helpers for EDL load/save/commit, chapters, media URLs
    types.ts                # shared types: Edit, Edl, PeaksData, Word, Chapter
    hooks/
      useEdl.ts             # EDL state management with undo/redo history
      useChapters.ts        # chapter list state + debounced auto-save
      useVideoPlayback.ts   # video element control, playback through cuts
      useKeyboard.ts        # keyboard shortcut bindings
    components/
      VideoPreview.tsx      # <video> element playing source.mp4
      Waveform.tsx          # wavesurfer.js with Regions plugin for trim/cut handles
      Timeline.tsx          # thumbnail strip + draggable chapter flag markers
      Toolbar.tsx           # controls: play, trim, cut, undo/redo, save, commit
      CommitDialog.tsx      # confirmation dialog before processing
      TranscriptOverlay.tsx # word-level transcript with current-word highlighting
      ChaptersPanel.tsx     # chapter list editor (title/time/jump/delete + add)
    styles/
      editor.css            # dark theme, full-viewport layout
```

## Build and dev workflow

**Production build:**
```sh
cd server/editor && bun run build
# or from server/: bun run editor:build
```

Output lands in `server/public/editor/` (gitignored). The Hono route reads the Vite manifest at `public/editor/.vite/manifest.json` to resolve hashed JS/CSS filenames.

**Development (two terminals):**
```sh
# Terminal 1: Hono server
cd server && bun run dev

# Terminal 2: Vite dev server with HMR
cd server/editor && bun run editor:dev
```

The Hono route detects dev mode (no manifest file on disk) and loads scripts from `localhost:5173` for hot module replacement.

## How the Hono route serves the editor

`server/src/routes/admin/editor.ts` has a `GET /:id/editor` route that:

1. Checks admin auth (inherited from the admin middleware)
2. Guards against non-complete or trashed videos
3. Returns an HTML shell with:
   - The video's ID, slug, duration, title, and height as `data-*` attributes on `#editor-root`
   - In production: `<script>` and `<link>` tags resolved from the Vite manifest
   - In dev: `<script>` tags pointing at the Vite dev server

The React app reads the data attributes on mount and never needs a separate API call for video metadata.

## Edit Decision List (EDL)

Edits are stored as `derivatives/edits.json`:

```json
{
  "version": 1,
  "source": "source.mp4",
  "edits": [
    { "type": "trim", "startTime": 2.5, "endTime": 175.0 },
    { "type": "cut", "startTime": 45.2, "endTime": 52.8 }
  ]
}
```

- **trim** — defines the kept range (everything outside is removed)
- **cut** — a section within the kept range to remove

The EDL is always a complete description applied to `source.mp4` from scratch. It is not incremental — each commit fully re-derives all outputs. Re-editing loads the existing EDL so previous edits are visible and modifiable.

## Suggested edits

A separate `derivatives/suggested-edits.json` file pre-populates the editor with auto-detected trim and cut suggestions on the very first time you open the editor for a new video. Same shape as `edits.json` so accepted suggestions merge straight in.

Generated server-side from ffmpeg's `silencedetect` filter (run after audio post-processing in the derivatives pipeline). Silences ≥3 seconds at the start/end of the video become a single trim suggestion; interior silences become cut suggestions. See `server/src/lib/suggested-edits.ts` for the thresholds.

**Lifecycle:**
- Generated once during initial post-processing if `lastEditedAt` is null and no suggestions file already exists (idempotent — healing reruns of the derivatives pipeline don't regenerate).
- Deleted on the first successful commit in `edit-pipeline.ts`, so suggestions never reappear once the user has committed any edit.
- Suppressed in the editor UI if `edits.json` already contains user edits (e.g. an in-progress saved-but-not-committed edit), to avoid noise on a returning visit.

**UI:**
- Suggested cuts render as amber wavesurfer regions, distinct from the red of committed cuts.
- A suggested trim renders as amber dimmed regions at the leading/trailing silence positions, but only when the active trim is at the default (full duration) — once the user manually adjusts the trim, the suggestion is hidden.
- Each region carries a ✓ Accept / ✗ Dismiss control, and the toolbar surfaces "Accept all" / "Dismiss all" with a count.
- Accept moves a suggestion into the live EDL (single undoable step). Dismiss is in-memory only and reappears on next page load until the user commits.

## Editor components

**Video preview:** Standard `<video>` element playing `source.mp4` (always the original, never the edited output). During playback, the `useVideoPlayback` hook uses `requestAnimationFrame` to skip over cut regions and stop at the trim end.

**Waveform:** wavesurfer.js v7 with the Regions plugin. Loaded from pre-computed `peaks.json` (generated during the derivatives pipeline from source.mp4). Trim boundaries appear as draggable handles. Cut regions appear as red overlays that can be dragged and resized. Double-click to add a new cut.

**Timeline:** Thumbnail strip rendered from `editor-storyboard.jpg` + `editor-storyboard.vtt`. One frame per second up to 10 minutes, one every 2 seconds beyond. Supports click-to-seek and drag-to-scrub.

**Transcript overlay:** Word-level display from `words.json` (uploaded by WhisperKit with per-word start/end timestamps). Words in cut regions are shown with strikethrough. The current word is highlighted. Click a word to seek to its timestamp.

**Chapters panel:** Sits at the bottom of the bottom panel (below the transcript). Lists each chapter as a row with a jump-to time button, editable title, editable time field (mm:ss.s or h:mm:ss.s), and remove ×. "+ Add at PLAYHEAD" creates a new anonymous chapter at the current player time.

Chapter timestamps are managed independently of the EDL — saves go to `/admin/videos/:id/chapters` and do not run `applyEdits`. The server returns chapter times in the **viewer timeline** (already mapped through any committed `edits.json`); on PUT, the server reverse-maps incoming viewer-timeline times back to the original recording timeline before persisting. This means `chapters.json` is canonical against the original source — re-editing (or un-cutting) automatically picks up the right chapter positions on the next page load without rewriting the file. Text edits are debounced 600ms; add / delete / drag-time-change saves are immediate.

Small amber flag markers render on the storyboard thumbnail strip at each chapter position. **Click a flag** to seek to it; **drag a flag** along the strip to move the chapter's `t`. While dragging, an inline timestamp pill above the flag shows the live target time; on release the new time is committed and saved. The flag's "end" is implicit — each chapter spans from its `t` to the next chapter's `t` (or video end).

**Keyboard shortcuts:**

| Key | Action |
|-----|--------|
| Space | Play/pause |
| I | Set trim start at playhead |
| O | Set trim end at playhead |
| X | Add a cut at the playhead |
| Left/Right | Step 1 second |
| Shift+Left/Right | Step 5 seconds |
| Cmd+Z | Undo |
| Cmd+Shift+Z | Redo |
| Cmd+S | Save EDL (without committing) |

## Processing pipeline

When the user clicks Commit, the server-side edit pipeline (`lib/edit-pipeline.ts`) runs:

1. Sets video status to `"processing"` (prevents concurrent edits)
2. Reads `edits.json` and probes `source.mp4`
3. Computes kept segments (the inverse of the cuts/trims)
4. Runs ffmpeg to produce `{height}p.mp4` (e.g. `1080p.mp4`) from `source.mp4`
   - Full re-encode with `-preset fast -crf 18`
   - 30ms audio crossfade at cut join points to prevent clicks
   - For simple trims: `-ss`/`-to` args
   - For cuts: `trim`/`atrim` + `concat` filter_complex
5. Regenerates downscaled variants (720p, etc.) from the edited output
6. Regenerates viewer-facing storyboard from the edited output
7. Derives edited captions from `words.json` by dropping words in removed regions and shifting timestamps
8. Updates DB: `durationSeconds`, `fileBytes`, `lastEditedAt`, `status` → `"complete"`
9. Purges CDN cache for the slug + global feeds
10. Logs `edits_committed` event

If the pipeline fails at any point, status is restored to `"complete"` so the video isn't stuck.

## File layout after editing

See the "Edited video file resolution" section in [Server Routes & API](server-routes-and-api.md) for the full file layout and URL resolution rules.

Key points:
- `source.mp4` is never modified — it's the sacred original
- The edited output is named by resolution (e.g. `1080p.mp4`)
- `activeRawFilename(video)` in `lib/url.ts` is the single source of truth for which file viewers should see
- Editor-specific files (`peaks.json`, `editor-storyboard.*`) always reflect `source.mp4`, never the edited output
- Viewer-facing files (storyboard, captions, variants) are regenerated from the edited output

## Where the code lives

| Concern | File |
|---------|------|
| Editor page route + API endpoints | `server/src/routes/admin/editor.ts` |
| React editor app | `server/editor/src/` |
| Edit pipeline (ffmpeg processing) | `server/src/lib/edit-pipeline.ts` |
| Edit transcript derivation | `server/src/lib/edit-transcript.ts` |
| Active raw filename resolution | `server/src/lib/url.ts` (`activeRawFilename`) |
| Audio peaks generation | `server/src/lib/peaks.ts` |
| Editor storyboard generation | `server/src/lib/storyboard.ts` (`generateEditorStoryboard`) |
| Suggested-edits generation | `server/src/lib/suggested-edits.ts` |
| Task document (design decisions) | `docs/tasks-todo/task-x-video-editing.md` |
