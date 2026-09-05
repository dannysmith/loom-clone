# Admin Video Editor

How the web-based video editor works — architecture, editing pipeline, and the relationship between source files and edited derivatives.

The editor is one of the two apps in `server/admin-client/`. Its package layout, build and dev workflow, and the manifest seam that joins it to the Hono server are covered in [`admin-client.md`](admin-client.md); this document is about the editor itself.

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
  │                                    │  → sets status to "reprocessing"
  │                                    │  → stages the master + variants +
  │                                    │    storyboard + captions, validates,
  │                                    │    then swaps the set in atomically
  │                                    │  → updates DB metadata, purges CDN
  │                                    │  → sets status back to "ready"
```

## Why it's a React app

The rest of the admin panel uses HTMX + vanilla JS with server-rendered Hono JSX. That's the right choice for CRUD forms and page navigation. A video editor needs continuous state management (timeline position, zoom, drag handles, undo/redo stack, playback sync) that benefits from React's model.

## Project structure

```
server/admin-client/src/editor/
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

## How the Hono route serves the editor

`server/src/routes/admin/editor.tsx` has a `GET /:id/editor` route that:

1. Checks admin auth (inherited from the admin middleware)
2. Guards against non-ready or trashed videos, and against a post-processing run still in flight
3. Renders `EditorPage`, which puts the video's ID, title and duration on `#editor-root` as `data-*` attributes and pulls in the built bundle

The React app reads those attributes on mount and never needs a separate API call for video metadata. See [`admin-client.md`](admin-client.md) for the asset seam and the dev-server workflow.

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
- Deleted on the first successful commit (`finalizeEdit` in `lib/processing/pipeline.ts`), so suggestions never reappear once the user has committed any edit.
- Suppressed in the editor UI if `edits.json` already contains user edits (e.g. an in-progress saved-but-not-committed edit), to avoid noise on a returning visit.

**UI:**
- Suggested cuts render as amber wavesurfer regions, distinct from the red of committed cuts.
- A suggested trim renders as amber dimmed regions at the leading/trailing silence positions, but only when the active trim is at the default (full duration) — once the user manually adjusts the trim, the suggestion is hidden.
- Each region carries a ✓ Accept / ✗ Dismiss control, and the toolbar surfaces "Accept all" / "Dismiss all" with a count.
- Accept moves a suggestion into the live EDL (single undoable step). Dismiss is in-memory only and reappears on next page load until the user commits.

## Editor components

**Video preview:** Standard `<video>` element playing `source.mp4` — always the pristine original, because the EDL is expressed against its timeline. That also means the editor plays *un-processed* audio: the chain is applied to the presentation master, not the source, so a quiet recording sounds quiet here. During playback, the `useVideoPlayback` hook uses `requestAnimationFrame` to skip over cut regions and stop at the trim end.

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
| D | Delete the cut under the playhead |
| Left/Right | Step 1 second |
| Shift+Left/Right | Step 5 seconds |
| Cmd+Z | Undo |
| Cmd+Shift+Z | Redo |
| Cmd+S | Save EDL (without committing) |

## Processing pipeline

Commit is not a special mode. `edits.json` is an input to the presentation master, so committing an edit and pressing "Re-run post-processing" are the same run — a `present` intent (`scheduleEdit` in `lib/processing/pipeline.ts`; the ffmpeg render itself lives in `lib/edit-render.ts`). It regenerates the whole presentation group, so it builds into a staging directory and swaps atomically, which is why it gets its own `reprocessing` status (see [Status model](streaming-and-healing.md#status-model)):

1. Sets video status to `"reprocessing"` (prevents concurrent edits)
2. Reads `edits.json` and computes kept segments — the inverse of the cuts and trims
3. Builds the presentation group into `derivatives/.staging/` (nothing in `derivatives/` is touched yet):
   - The master `{height}p.mp4` from `source.mp4`. The cut is rendered first (`-preset fast -crf 18`, `-pix_fmt yuv420p`, `-fps_mode passthrough`, a 30ms audio crossfade at joins; `-ss`/`-to` for a simple trim, `trim`/`atrim` + `concat` for cuts), then the audio chain runs over the result — so loudness is measured on the audio a viewer will actually hear, and the video is encoded exactly once
   - Downscaled variants cut from the staged master
   - Storyboard from the staged master
   - Captions, remapped from `captions.original.srt` through `words.json`
4. Validates every staged video file with `isProbablyPlayable`
5. **Swaps** the validated set into `derivatives/` in one fast pass of per-file renames
6. Updates the DB: transcript, `durationSeconds`, `fileBytes`, `lastEditedAt`, `status` → `"ready"`
7. Purges CDN cache for the slug and logs `edits_committed`

If anything fails before the swap, the staging dir is discarded and status is restored to `"ready"` — the previous outputs are left byte-for-byte untouched, so an interrupted commit never leaves a new master beside a stale variant. Only the presentation group is staged; source-group files (`peaks.json`, `editor-storyboard.*`, thumbnails) write in place and don't move when you edit.

**Reverting.** Clearing every edit and committing is the revert path, and it needs no separate action: an empty EDL means one full-span kept segment, so the master is rebuilt from the whole source, `lastEditedAt` is cleared, and the captions go back to a verbatim copy of the original. Because every rebuild starts from the pristine source rather than the previous master, edit → revert is a true round trip — repeated processing can't accumulate.

## File layout

See [File resolution](server-routes-and-api.md#file-resolution) in Server Routes & API for the full layout and URL rules.

Key points:
- `source.mp4` is never modified — it's the pristine original, and the only thing the editor plays
- The presentation master is named by resolution (e.g. `1080p.mp4`) whether or not the video is edited
- `activeRawFilename(video)` in `lib/url.ts` is the single source of truth for which file viewers get
- Editor-facing files (`peaks.json`, `editor-storyboard.*`) always reflect `source.mp4`
- Viewer-facing files (master, variants, storyboard, captions) are regenerated together from the master
