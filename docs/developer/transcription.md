# Transcription

How subtitles and searchable transcripts are generated for recordings. Inference runs locally on the Mac using WhisperKit; the server stores, indexes, and serves the result.

## Architecture

```
macOS app (after recording stops)
  └── TranscribeAgent
        1. Loads WhisperKit pipeline (large-v3-turbo, Core ML)
        2. Runs inference against local audio.m4a
        3. Builds SRT from segments
        4. Writes captions.srt locally (backup)
        5. PUTs SRT to /api/videos/:id/transcript
        6. Writes .transcribed sidecar on success

Server (on receipt)
  └── Writes derivatives/captions.srt atomically
  └── Parses SRT → plain text
  └── Upserts into video_transcripts table + FTS index
```

Transcription is fully asynchronous and invisible to the user. The URL is on the clipboard before transcription begins.

## Why client-side

Apple Silicon runs Whisper `large-v3-turbo` at 15–25× realtime via Core ML (Neural Engine). A 30-minute recording transcribes in 1–2 minutes. The Hetzner VPS (modest x86, no GPU) would take 30–60 minutes for the same task. The Mac is also where the raw `audio.m4a` already lives — no transport cost.

## Model management

**Package:** [WhisperKit](https://github.com/argmaxinc/WhisperKit) — Swift-native, SPM, Core ML optimised.

**Model:** `openai_whisper-large-v3-v20240930_626MB` (~626 MB on disk, ~1.5 GB RAM at inference). Downloaded on first use from HuggingFace into the app support directory, cached permanently thereafter.

**Download trigger:** Explicit user action in Settings (not automatic). The model is large enough that downloading without consent would be rude. The Settings UI shows download progress and a delete option.

**Gating:** `TranscriptionModelStatus` (`@Observable`, `@MainActor` singleton) tracks model state: `.notDownloaded`, `.downloading`, `.ready`, `.failed(String)`. All transcription is gated on `.isReady` — if the model isn't downloaded, `TranscribeAgent` no-ops silently. The Settings UI binds to this for download/delete buttons and status display.

**Storage location:** `~/Library/Application Support/LoomClone{-Debug}/models/argmaxinc/whisperkit-coreml/openai_whisper-large-v3-v20240930_626MB/`. Presence check: `config.json` existing in that directory.

## TranscribeAgent lifecycle

`TranscribeAgent` is an actor — all transcription is serialised (one recording at a time). Two entry points, mirroring `HealAgent` (see [Streaming & Healing](streaming-and-healing.md#healing)):

### Post-stop handoff

After `/complete` returns and the URL is on the clipboard, `RecordingCoordinator` fires `TranscribeAgent.scheduleTranscription(videoId:, localDir:)`. Fire-and-forget — the user is already done.

### Startup scan

At app launch, `TranscribeAgent.runStartupScan()` walks the recordings directory. For each session within the last **3 days** that has an `audio.m4a` but no `.transcribed` sidecar (and no `.orphaned` marker), it runs transcription sequentially. This catches recordings where the app quit before transcription finished, or where the model wasn't downloaded at recording time.

### The transcription flow

1. Check `.transcribed` sidecar — skip if present.
2. Check `audio.m4a` exists — skip if absent (video-only recording, no mic).
3. Load or reuse the WhisperKit pipeline (lazy-initialised on first call).
4. Run inference → `[TranscriptionResult]`.
5. Build SRT string from segments (strip Whisper special tokens, format timestamps).
6. Write `captions.srt` to the local recording directory (backup).
7. PUT SRT bytes to `/api/videos/:id/transcript` with `Content-Type: application/x-subrip`.
8. On 404 → write `.orphaned` sidecar, stop (server record was deleted).
9. On other failure → log, exit (retries at next startup scan).
10. On success → suggest a title via Apple Intelligence (see below). Failures are logged and swallowed.
11. Write `.transcribed` sidecar with timestamp.

## Server-side handling

The `PUT /api/videos/:id/transcript` endpoint (bearer-authed, 5 MB limit):

1. Detects format from Content-Type header or `WEBVTT` prefix (supports both SRT and VTT).
2. Writes to `data/<id>/derivatives/captions.srt` (or `.vtt`) atomically via `.tmp` → rename.
3. Parses the SRT/VTT into plain text.
4. Upserts into `video_transcripts(video_id, format, plain_text, word_count, created_at)`.
5. Updates the FTS index (integrated with the existing admin search that indexes title/description/slug).
6. Logs a `transcript_uploaded` event.

Re-uploading replaces the file and re-indexes — fully idempotent.

## Viewer integration

When `derivatives/captions.srt` exists, the viewer page at `/:slug` includes a `<track>` element. Vidstack parses SRT natively — no VTT conversion needed. Captions are served at `/:slug/captions.srt` (and `/:slug/captions.vtt` if that format was uploaded).

The metadata routes (`/:slug.json`, `/:slug.md`) include the transcript plain text when available. See [Server Routes & API](server-routes-and-api.md#viewer-routes-slug) for the full route reference.

## AI title suggestion

After the transcript is successfully uploaded, `TranscribeAgent` attempts to generate a title for the video using Apple's on-device Foundation Models framework (`FoundationModels`, macOS 26+). This is entirely optional — if the framework isn't available or generation fails, the video simply keeps its null title and the 3-word slug remains the only identifier.

### How it works

1. Read `recording.json` from the local session directory.
2. Build a deterministic context preamble from the timeline metadata — e.g. "3-minute with voiceover screenshare" — using `RecordingContextBuilder`.
3. Strip SRT timestamps from the transcript to get plain text, truncated to ~500 words (the on-device model's context window is 4096 tokens total).
4. Create a `LanguageModelSession` and call `respond(to:generating:)` with a `@Generable` struct that has a `topic` field (forces the model to identify the subject first) and a `title` field.
5. Validate the result: non-empty, 2+ words, ≤80 characters, not a refusal.
6. `PUT /api/videos/:id/suggest-title` with `{ "title": "..." }`.
7. The server applies the title only if `video.title` is still null (user hasn't edited it). Returns `{ applied: true/false }`.

### Failure posture

Same philosophy as transcription itself: failures are silent and non-blocking. No retry at next startup scan — if it didn't work this time, the video just stays untitled. The user can always set a title manually in the admin panel or the macOS popover.

### Gating

- `#if canImport(FoundationModels)` — compile-time check.
- `#available(macOS 26, *)` — runtime check.
- No equivalent of `TranscriptionModelStatus` needed — the Foundation Model is a system capability, not a downloaded asset.

## Where the code lives

| Concern | File |
|---|---|
| TranscribeAgent (inference + upload + title suggestion) | `app/LoomClone/Pipeline/TranscribeAgent.swift` |
| Title suggestion generator (@Generable, prompt, validation) | `app/LoomClone/Pipeline/TitleSuggestion.swift` |
| Recording context preamble builder | `app/LoomClone/Helpers/RecordingContextBuilder.swift` |
| Model status (observable, gates transcription) | `app/LoomClone/Helpers/TranscriptionModelStatus.swift` |
| Transcript upload endpoint | `server/src/routes/api/videos.ts` |
| Suggest-title endpoint | `server/src/routes/api/videos.ts` |
| SRT parsing (cues → plain text) | `server/src/lib/srt.ts` |
| Transcript DB access (upsert, query) | `server/src/lib/store.ts` |
| Captions serving (/:slug/captions.*) | `server/src/routes/videos/media.ts` |
| Viewer page (track element) | `server/src/routes/videos/page.tsx` |
| Metadata routes (transcript field) | `server/src/routes/videos/metadata.ts` |
| Admin transcript tab | `server/src/routes/admin/videos.tsx` |
