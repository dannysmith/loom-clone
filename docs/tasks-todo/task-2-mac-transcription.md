# Task 2: Mac-Side Transcription

Goal: generate subtitles and searchable transcripts for every recording by running Whisper locally on the Mac and uploading the result, instead of burdening the Hetzner box with CPU-only inference.

## Why client-side

Apple Silicon is built for this workload; modest x86 servers are not. Rough throughput numbers for `large-v3-turbo` quantised to Q5_0:

| Backend                             | Realtime factor     | 30-min recording → |
| ----------------------------------- | ------------------- | ------------------ |
| Hetzner x86 CPU (4–8 vCPUs, no GPU) | ~0.5–1× realtime    | 30–60 minutes      |
| Apple Silicon M-series, Metal       | ~8–15× realtime     | 2–4 minutes        |
| Apple Silicon M-series, Core ML     | ~15–25× realtime    | 1–2 minutes        |

At single-user volume, running this on the Mac is massively faster, free (hardware already paid for), and does not compete with ffmpeg derivative runs, viewer page requests, or segment ingest on the server. The Mac is also the natural place to run this — the raw AAC 192 kbps `audio.m4a` master is already on local disk; no additional transport.

## Design principles

- **The user-visible stop flow does not change.** Recording stops, segments upload, `/complete` returns, URL goes on the clipboard. Transcription runs after that, asynchronously, invisibly.
- **Retry semantics mirror healing.** A new `TranscribeAgent` lives alongside `HealAgent`, with post-stop and startup-scan entry points. State is tracked by a sidecar file in the local recording directory. Failures retry at next app launch.
- **Server is transcription-agnostic.** The `/api/videos/:id/transcript` endpoint accepts an SRT (or VTT) payload and stores it. It does not care who produced it. This keeps the door open for a future server-side fallback without schema churn.
- **No external LLMs, no external APIs.** All inference runs on the Mac.

## Package choice: WhisperKit

**[WhisperKit](https://github.com/argmaxinc/WhisperKit)** — Swift-native, SPM distribution, Apple-Silicon-optimised via Core ML. Tight Swift integration, no subprocess plumbing. Actively maintained.

Alternatives considered and rejected:

- **[whisper.cpp](https://github.com/ggml-org/whisper.cpp)** — C/C++ port of Whisper. Smaller quantised model files (547 MB for large-v3-turbo Q5_0) but requires C bridging or subprocess management. Rougher Swift integration for marginal disk savings.
- **[FluidAudio](https://github.com/FluidInference/FluidAudio) (Parakeet V3 via CoreML)** — dramatically faster (110–190× realtime vs ~15–25× for Whisper), but 2.69 GB model footprint (4× larger) and less battle-tested. Speed doesn't matter here because transcription runs in the background after recording.
- **Sharing models with Handy** — investigated and ruled out. Handy uses Parakeet V3 in ONNX format via a Rust runtime (`transcribe-rs`). Completely different architecture from Whisper (FastConformer-TDT vs Encoder-Decoder Seq2Seq), different model format (ONNX vs CoreML), and different runtime. Zero model compatibility. Even using Parakeet via FluidAudio would download its own CoreML-converted copy — no overlap with Handy's ONNX files.
- **Ollama** — does not support speech-to-text models at all.

WhisperKit wins on Swift integration ergonomics, reasonable model size, and hardware isolation — it runs inference on the Neural Engine via CoreML, while Handy uses Metal GPU via `transcribe-rs`, so they don't compete for the same hardware when both are active.

**Model**: `large-v3-turbo` quantised (~626 MB on disk, ~1.5 GB RAM at inference). Current community consensus as the best quality/speed tradeoff for English transcription. Shipped via on-first-use download into the app support directory, cached thereafter.

## Client-side flow

### Post-stop

1. `RecordingCoordinator` completes its existing stop flow: writes `recording.json`, calls `/complete`, copies URL to clipboard, hands any missing segments to `HealAgent`.
2. Coordinator also fires `TranscribeAgent.scheduleTranscription(videoId:, localDir:)`. Fire-and-forget.
3. `TranscribeAgent`:
   - Checks for existing `.transcribed` sidecar → no-op if present.
   - Runs Whisper against `audio.m4a` in the recording dir.
   - Writes `captions.srt` to the recording dir (local backup).
   - PUTs SRT bytes to `/api/videos/:id/transcript`.
   - On success, writes `.transcribed` sidecar.
   - On failure, logs and exits (retry at next launch).

### Startup scan

At app launch, `TranscribeAgent.runStartupScan()` walks the recordings directory:

- For each session within the last **3 days** (same window as healing) lacking a `.transcribed` sidecar and possessing an `audio.m4a`, kick off transcription.
- Sessions with a `.orphaned` marker are skipped — if the server record is gone, transcription has nothing to upload to.
- Sessions older than 3 days are skipped.

### Sidecar files

| File                           | Purpose                                                        |
| ------------------------------ | -------------------------------------------------------------- |
| `captions.srt`                 | Local copy of the generated transcript (backup)                |
| `.transcribed`                 | Sentinel: upload succeeded, do not retry                       |
| `.orphaned` (existing)         | Sentinel: server 404'd — skip transcription and healing alike  |

### UI surface

Minimal. A small badge in the popover's recent-recording list when a recording is still awaiting transcription, cleared on sidecar write. No user-initiated retry button — the agent handles it.

## Server-side work

### New endpoint

```
PUT /api/videos/:id/transcript
Content-Type: application/x-subrip (SRT) or text/vtt (VTT)
Body: raw SRT/VTT bytes
```

- Bearer-authed (same `lck_` keys as segment uploads).
- Writes bytes to `data/<id>/derivatives/captions.srt` atomically (`.tmp` → rename).
- On success, parses the SRT into plain-text and upserts into the `video_transcripts` table (below).
- 404 if the video record does not exist (client writes `.orphaned`, stops).
- Idempotent: re-uploading replaces the file and re-indexes.

### Schema additions

New table (separate from `videos` — consistent with `videoSegments`, `videoEvents`, `videoTags` pattern):

```sql
video_transcripts(
  video_id TEXT PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE,
  format TEXT NOT NULL,              -- 'srt' | 'vtt'
  plain_text TEXT NOT NULL,          -- concatenated cue text for display/search
  word_count INTEGER NOT NULL,
  created_at TEXT NOT NULL
)
```

Add `transcript` column to the existing `videos_fts` FTS5 virtual table (which already indexes `title`, `description`, `slug` in `server/src/lib/search.ts`). This integrates transcript search directly into the admin search box that already exists — no new search endpoint needed.

### Viewer wiring

`/:slug` viewer page emits a `<track>` element when `captions.srt` exists:

```html
<track kind="subtitles" src="/:slug/captions.srt" srclang="en" label="English" default />
```

Vidstack parses SRT natively (`type="srt"`). No conversion to VTT required.

### Metadata routes

Add transcript text to the existing metadata endpoints:

- **`/:slug.json`** — add a `transcript` field (plain text string, or `null` if not yet transcribed).
- **`/:slug.md`** — add a `## Transcript` section at the end with the plain text.

### Admin: transcript tab

The video detail page (`server/src/views/admin/pages/VideoDetailPage.tsx`) already has an Events/Files tab switcher. Add a third **Transcript** tab that displays the plain text transcript (from `video_transcripts.plain_text`), word count, and generated timestamp. Show a "not yet transcribed" state when no transcript exists.

## Out of scope

- **Server-side transcription.** Deferred until an upload path for non-recorded videos exists. When it does, the server grows its own whisper.cpp path behind the same `PUT /transcript` endpoint (or an internal equivalent).
- **Translation / multi-language detection.** English only for now. Whisper can auto-detect language but the recordings are English in practice; no reason to spend on the extra inference cost.
- **Auto-generated titles / descriptions / summaries.** Requires an LLM, ruled out as a dependency.
- **Speaker diarisation.** Whisper alone does not produce speaker labels; a separate model (e.g. pyannote) would be needed. Not a priority for single-speaker recordings.
- **Manual transcript correction UI.** Not in this task. If needed later, the stored SRT is a plain file that can be edited server-side and re-indexed.
- **Cue-level search / jump-to-timestamp.** Not needed for now. Plain-text search across the full transcript is sufficient.
