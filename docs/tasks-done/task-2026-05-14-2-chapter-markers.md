# Task 2: Chapter Markers

GitHub: [#1](https://github.com/dannysmith/loom-clone/issues/1)

## Goal

Let me drop anonymous chapter markers during a recording with a single button press, then name/edit/reorder/remove them in the admin editor afterwards. Chapters are served to viewers via WebVTT so Vidstack shows them in the public, embed, and admin players. Optional: on-device AI suggests titles for chapters created during recording.

Explicitly **not** in scope:

- Auto-creating chapter markers themselves (AI may only *name* existing markers).
- Team/multi-user concerns — single-user tool.
- Per-viewer chapter analytics.

## Design decisions

1. **Source of truth split.** Mac app emits `chapter_marker` events into `recording.json` (matches how pause/resume/mode-switch are stored — an audit log of what happened during the session). On `/complete`, the server extracts those events into a separate `chapters.json` next to `edits.json`. From then on `chapters.json` is the only mutable representation; `recording.json` is never touched.
2. **UUIDs generated Mac-side.** So AI title-suggestion calls from the Mac can identify their target chapter unambiguously even if other chapters are added/removed in the admin in the meantime.
3. **Chapter times stored in the original recording timeline.** Always. We remap through `edits.json` at *read* time (VTT generation, admin GET) rather than rewriting `chapters.json` on every edit commit. This means:
   - Re-editing or un-cutting brings back chapters that briefly fell into a cut region.
   - `chapters.json` is immutable with respect to EDL changes — only the user mutates it.
   - When the admin UI sends a new chapter or a new time, it does so in viewer-timeline coordinates; the server reverse-maps to recording timeline before persisting. Helpers live next to `computeKeptSegments()` in `edit-pipeline.ts`.
4. **AI suggestions only run if at least one marker was created during the recording session.** The `createdDuringRecording` flag drives this. If the user only adds chapters later via the admin UI, no AI run is triggered (per issue). The Mac processes chapters sequentially so prior generated titles can be used as context for later ones.
5. **Admin UI lives inside the existing editor**, but as a non-intrusive sidebar or footer panel. Editing chapters is a fundamentally different operation from cutting video, and chapter saves are independent of EDL saves/commits.
6. **Chapters and edits save independently.** Saving a chapter title shouldn't force `applyEdits()` to re-run.

### `chapters.json` schema

```json
{
  "version": 1,
  "chapters": [
    {
      "id": "uuid-v4",
      "title": null,
      "t": 12.345,
      "createdDuringRecording": true
    }
  ]
}
```

- `t` — seconds from start of original recording (`source.mp4`).
- `title: null` — anonymous; VTT generation falls back to `Chapter N`.
- `createdDuringRecording` — true if produced from a `chapter_marker` event in `recording.json`; false if added later via admin UI.
- Order in array is order on the timeline; server keeps the array sorted by `t` on every write.

### Timeline event (added to `RecordingTimeline.swift`)

```
kind: "chapter_marker"
data: { "id": "<uuid>" }
```

Recorded both during `.recording` and `.paused` states. Uses `elapsedSeconds` (the existing single clock source) as the `t` value.

## Implementation plan

### Phase 1 — macOS app: capture markers

Files: `app/LoomClone/Models/RecordingTimeline.swift`, `app/LoomClone/Pipeline/RecordingActor.swift` (+ extensions), `app/LoomClone/App/RecordingCoordinator.swift`, `app/LoomClone/UI/RecordingPanelContent.swift`.

- Add `recordChapterMarker(id:)` to `RecordingTimeline` (mirror `recordPaused()` at lines 525-535). Bump timeline `version` only if downstream tools depend on it — likely not needed; new event kinds are additive.
- `RecordingActor.addChapterMarker()` async — generates a UUID, calls `timeline.recordChapterMarker(id:)`, returns the UUID + current `t` to the coordinator.
- `RecordingCoordinator.addChapterMarker()` async — calls the actor, keeps a session-local count for the UI badge.
- New `Bookmark`/flag SF Symbol button in `RecordingPanelContent.swift` between the timer and stop button. Enabled in both `.recording` and `.paused` states.
- Visual feedback: brief scale/opacity pulse on press, badge with marker count next to the icon. Keep it cheap.
- No keyboard shortcut in v1 (not requested by the issue).

### Phase 2 — Server: extract on /complete, CRUD, VTT

New file: `server/src/lib/chapters.ts`.
Modify: `server/src/routes/api/videos.ts`, `server/src/routes/admin/editor.ts` (or new `admin/chapters.ts`), `server/src/routes/videos/media.ts`, `server/src/lib/cdn.ts` if needed.

- `chapters.ts` exports:
  - `readChapters(videoId)`, `writeChapters(videoId, chapters)` — atomic tmp + rename, same pattern as `editor.ts:108`.
  - `extractChaptersFromTimeline(timeline)` — pulls `chapter_marker` events, builds initial `chapters.json` payload.
  - `mapChapterTimesForward(chapters, edl, sourceDuration)` — recording timeline → viewer timeline; drops chapters in cuts.
  - `mapTimeBackward(viewerT, edl, sourceDuration)` — viewer timeline → recording timeline. Used when admin UI sends a new chapter time on an edited video.
  - `generateChaptersVTT(chapters, videoDuration)` — emits WebVTT with `kind=chapters` cues. Cue ends at next chapter start (or video end for the last one). Falls back to `Chapter N` when `title === null`.
- `/complete` (videos.ts:214) — after writing `recording.json`, call `extractChaptersFromTimeline()` and write `chapters.json` if it produced any rows. Idempotent on re-completes.
- Admin endpoints (mirror EDL pattern at editor.ts:83-150):
  - `GET  /admin/videos/:id/chapters` — returns chapters with `t` already mapped to viewer timeline.
  - `PUT  /admin/videos/:id/chapters` — bulk replace; server reverse-maps any times back to recording timeline before persisting. Validates: max ~50 chapters, titles ≤ 200 chars, unique IDs, `t` within video duration.
- Public route: `GET /:slug/chapters.vtt` in `server/src/routes/videos/media.ts` — 404 when file missing or empty list. `Cache-Control: public, max-age=3600` matching captions/storyboard.
- CDN purge: call `purgeVideo(slug)` from `cdn.ts` after `/complete` writes chapters and after every admin PUT. Existing `purgeVideo` wildcard covers the new `chapters.vtt`.

### Phase 3 — Vidstack integration

Files: `server/src/views/viewer/VideoPage.tsx`, `server/src/views/viewer/EmbedPage.tsx`, `server/src/views/admin/pages/VideoDetailPage.tsx`.

- Route handlers pass a `hasChapters: boolean` flag (cheap fs check) so the view conditionally renders the track element. Avoids the player firing a 404.
- Add `<track src={`/${video.slug}/chapters.vtt`} kind="chapters" srclang="en" />` inside `<media-provider>` when `hasChapters` is true (VideoPage.tsx:194 area).
- Same in `EmbedPage.tsx` and admin `VideoDetailPage.tsx`.
- Verify Vidstack auto-renders chapter UI from a `kind=chapters` track via context7 docs — if any extra player config is needed, capture it here. Default video layout should pick it up.

### Phase 4 — Admin editor UI

Files under `server/editor/src/`.

- New chapter list component shown in the existing editor — placed as a sidebar or below the timeline (whichever is least intrusive to the cut/trim flow). Per row: title input, time display (mm:ss.SSS), "use current player time" button, delete.
- "Add chapter at current player time" button at the top of the list.
- Light visual markers on the editor's timeline at each chapter's mapped position. Click jumps to that time.
- API client in `editor/src/api.ts` — `loadChapters(videoId)` and `saveChapters(videoId, chapters)` independent of the EDL functions.
- Save semantics: debounce-on-change or explicit save button. Bulk PUT.
- After committing edits via the existing `commitEdits()` flow, reload chapters so the UI shows freshly-remapped times.

### Phase 5 — AI chapter title suggestions

Files: new `app/LoomClone/Pipeline/ChapterTitleSuggestion.swift`, modify `app/LoomClone/Pipeline/TranscribeAgent.swift`, new server endpoint in `videos.ts`.

- After transcription completes, `TranscribeAgent` reads `recording.json` and gathers `chapter_marker` events. If none, no AI run (per issue requirement).
- For each chapter in **sequence**: slice transcript words to `[t_chapter, t_next_chapter_or_end]`; build prompt with the suggested video title (from `TitleSuggestion`), prior chapter titles generated this run, and the chapter's transcript slice; generate a title via `LanguageModelSession` (same pattern as `TitleSuggestion.swift:35-61`).
- New endpoint: `PUT /api/videos/:id/chapters/:chapterId/suggest-title` accepts `{ title: string }`. Applies only if the chapter's current `title` is `null` and the chapter still exists. Returns `{ applied: boolean, reason?: string }`. Logs event `chapter_title_suggested`.
- Server validation: title 1–200 chars, no refusal-shaped responses (reuse validation from `TitleSuggestion.swift` if generalisable).
- The endpoint is idempotent — concurrent admin renames or deletes always win.

## Open questions / things to verify mid-build

- **Vidstack chapter track syntax.** Confirm via context7 that a plain `<track kind="chapters">` inside `<media-provider>` is sufficient with the default layout. If a wrapper or extra config is needed, document here.
- **Reverse-mapping edge cases.** A chapter time landing exactly on a cut boundary — snap forward (to start of next kept segment) or reject? Lean forward, but verify against a real edited video.
- **Marker generation while the user spam-clicks the button.** Coalesce within, say, 250ms so accidental double-presses don't produce two markers within milliseconds of each other. Cheap and avoids janky chapter lists.

## Out of scope (defer / not doing)

- Cross-video / global chapter library.
- Per-chapter thumbnails (rely on Vidstack's storyboard).
- Chapter-level analytics or progress markers.
- Hotkey for adding markers during recording (can be added later).
