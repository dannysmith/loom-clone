# Task 4: Mac-Side Transcription

Goal: generate subtitles and searchable transcripts for every recording by running Whisper locally on the Mac and uploading the result, instead of burdening the Hetzner box with CPU-only inference.

Companion to [task 3](task-3-post-processing-enhancements.md) (server-side post-processing). The two can proceed independently.

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

## Package choice

Two candidates — pick at the start of implementation after a spike:

- **[WhisperKit](https://github.com/argmaxinc/WhisperKit)** — Swift-native, SPM distribution, Apple-Silicon-optimised via Core ML. Tight Swift integration, no subprocess plumbing. Actively maintained.
- **[whisper.cpp](https://github.com/ggml-org/whisper.cpp)** directly — bundle the compiled `whisper-cli` binary and spawn it via `Process()`. More control over flags, easier to upgrade the binary independently, but we manage process lifecycle ourselves.

Expected outcome: WhisperKit wins on integration ergonomics for a Swift app. Validate by running both on a real 10-minute recording and comparing setup complexity, runtime speed, and output quality.

**Model**: `large-v3-turbo` quantised to Q5_0 (~500 MB on disk, ~1.5 GB RAM at inference). Current community consensus as the best quality/speed tradeoff for English transcription. Shipped via on-first-use download into the app support directory, cached thereafter.

## Client-side flow

### Post-stop

1. `RecordingCoordinator` completes its existing stop flow: writes `recording.json`, calls `/complete`, copies URL to clipboard, hands any missing segments to `HealAgent`.
2. Coordinator also fires `TranscribeAgent.scheduleTranscription(videoId:, localDir:)`. Fire-and-forget.
3. `TranscribeAgent`:
   - Checks for existing `.transcribed` sidecar → no-op if present.
   - Runs Whisper against `audio.m4a` in the recording dir.
   - Writes `captions.srt` to the recording dir.
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
| `captions.srt`                 | Local copy of the generated transcript                         |
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
- On success, parses the SRT into plain-text and upserts into an FTS5 virtual table (below).
- 404 if the video record does not exist (client writes `.orphaned`, stops).
- Idempotent: re-uploading replaces the file and re-indexes.

### Schema additions

New table:

```sql
video_transcripts(
  video_id TEXT PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE,
  format TEXT NOT NULL,              -- 'srt' | 'vtt'
  plain_text TEXT NOT NULL,          -- concatenated cue text for display/search
  word_count INTEGER NOT NULL,
  created_at TEXT NOT NULL
)
```

FTS5 virtual table mirrors `plain_text` for full-library search:

```sql
CREATE VIRTUAL TABLE video_transcripts_fts USING fts5(
  plain_text,
  content='video_transcripts',
  content_rowid='rowid',
  tokenize='porter unicode61'
)
```

Triggers keep FTS in sync on insert/update/delete.

### Viewer wiring

`/:slug` viewer page emits a `<track>` element when `captions.srt` exists:

```html
<track kind="subtitles" src="/:slug/captions.srt" srclang="en" label="English" default />
```

Vidstack parses SRT natively (`type="srt"`). No conversion to VTT required.

### Admin: library search

Admin UI (landing in its own task) gains a search box that hits an endpoint roughly like:

```
GET /admin/api/search?q=...
```

Returns `{ videos: [{ id, slug, title, snippet, timestamp }] }` by joining FTS hits against the `videos` table. Snippet is FTS5's native snippet output; timestamp is the nearest cue's start time (requires storing cue offsets — see extension below).

### Optional extension: cue-level search

If jump-to-timestamp from search results is wanted, add a per-cue table:

```sql
video_transcript_cues(
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  cue_index INTEGER NOT NULL,
  start_seconds REAL NOT NULL,
  end_seconds REAL NOT NULL,
  text TEXT NOT NULL,
  PRIMARY KEY (video_id, cue_index)
)
```

FTS5 over `text` with content table pointing at this gives cue-resolution search hits. Decide whether this is worth the extra indexing work once the plain-text search is in use.

## Out of scope

- **Server-side transcription.** Deferred until an upload path for non-recorded videos exists. When it does, the server grows its own whisper.cpp path behind the same `PUT /transcript` endpoint (or an internal equivalent).
- **Translation / multi-language detection.** English only for now. Whisper can auto-detect language but the recordings are English in practice; no reason to spend on the extra inference cost.
- **Auto-generated titles / descriptions / summaries.** Requires an LLM, ruled out as a dependency.
- **Speaker diarisation.** Whisper alone does not produce speaker labels; a separate model (e.g. pyannote) would be needed. Not a priority for single-speaker recordings.
- **Manual transcript correction UI.** Not in this task. If needed later, the stored SRT is a plain file that can be edited server-side and re-indexed.
