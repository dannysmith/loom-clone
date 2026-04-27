# Task 2 — AI Title Suggestions

**AI title suggestions**: After transcription completes, suggest a title for the video based on its transcript and recording metadata, using Apple Intelligence (Foundation Models framework) on-device. No external LLM APIs, no server-side inference.

The flow:
1. After local transcription finishes, send the transcript (first ~500 words) plus a short deterministic context preamble (e.g. "3-minute screenshare with voiceover") to Apple Intelligence via `SystemLanguageModel`.
2. Sanity-check whatever comes back against simple rules to weed out malformed or obviously insane suggestions.
3. Upload the suggestion to the server via a dedicated endpoint.
4. Server auto-applies the title only if the user hasn't already set one manually (title is still null). No slug changes — the 3-word human-id slugs are already good for sharing.

## Design Decisions

**Auto-apply, not "suggestion" UI.** For a single-user tool, auto-applying the title when it's still null is simpler and strictly better than every video being untitled. The admin panel and macOS popover already let you edit the title — that's the undo mechanism. No separate accept/reject flow needed.

**Title only, no slug update.** Slugified titles make worse URLs than the existing 3-word human-id slugs. `calm-dogs-dream` is short, memorable, and speakable. `quick-walkthrough-of-the-new-billing-dashboard` is none of those things.

**Extend TranscribeAgent, not a separate actor.** Title suggestion is tightly coupled to having a transcript — it can't run without one. The Foundation Models call is sub-second, so it doesn't meaningfully delay the `.transcribed` sidecar. If the feature grows complex later, extract then.

**Foundation Models framework.** `SystemLanguageModel` runs on-device, no download step (unlike WhisperKit), no API key, no network. Gating is just `#available(macOS 26, *)`. The model is optimised for summarisation and short generative tasks — this is its sweet spot.

## Key Technical Constraints

**4096 token context window (total).** This is the hard ceiling — shared between instructions, prompt, schema, and response. At ~3-4 characters per token for English, that's roughly 12-16K chars total. After instructions + schema + output budget, there's room for ~500-800 words of transcript. Use `tokenCount(for:)` (macOS 26.4+) to preflight and dynamically truncate.

**Property order in @Generable structs is generation order.** Earlier properties establish context for later ones. Put a "topic" field before the title field to force the model to identify the subject before generating the title (cheap chain-of-thought).

**Guardrails can false-positive on input content.** Use `.permissiveContentTransform` for the session to avoid guardrail triggers on transcript text. Even with this, the model occasionally refuses — detect and handle gracefully.

**Lead bias in transcripts.** NLP research consistently shows the first few sentences of spoken content contain the most salient information. The first ~500 words will capture the topic for almost all recording types.

## Prompt Design

Instructions (set on session creation):
```
You suggest short, descriptive titles for video recordings.
Respond with only the title. Do not use quotes or ending punctuation.
Do not start with filler like "Introduction to" or "A quick look at".
```

Prompt (per request):
```
Recording: [deterministic preamble from recording.json].

Transcript:
[first ~500 words, trimmed to fit token budget]
```

The deterministic preamble is built from `RecordingTimeline` data we already have:
- Duration (`session.durationSeconds`)
- Mode (`session.initialMode` + mode switch events → "screenshare", "talking head", "screenshare with talking-head overlay")
- Whether it has audio (`inputs.microphone` presence → "with voiceover" / silent)

Structured output:
```swift
@Generable
struct TitleSuggestion {
    @Guide(description: "The main topic of the video in 2-4 words")
    var topic: String

    @Guide(description: "A concise descriptive title for this video in 3 to 8 words")
    var title: String
}
```

The `topic` field is never sent to the server — it exists purely to make the model reason before producing the title.

## Phases

### Phase 1: Server endpoint

Add `PUT /api/videos/:id/suggest-title` (bearer-authed):
- Accepts `{ "title": "..." }`.
- If `video.title IS NULL`, updates the title and returns `200 { applied: true }`.
- If `video.title` is already set (user edited it), no-ops and returns `200 { applied: false }`.
- Logs a `title_suggested` event either way.
- 404 if video doesn't exist.

Add test coverage for both paths (title null → applied, title already set → no-op).

### Phase 2: Recording context builder

Add a small helper (in `Pipeline/` or `Helpers/`) that takes a `RecordingTimeline` and produces the deterministic preamble string. Pure function, easy to unit test. Examples of output:
- `"3-minute screenshare with voiceover"`
- `"12-minute talking-head recording"`
- `"8-minute screenshare with camera overlay and voiceover"`
- `"45-second silent screenshare"`

### Phase 3: Title suggestion in TranscribeAgent

After successful transcription + upload (step 7 in the existing transcription flow, before writing `.transcribed`):

1. Read `recording.json` from local dir, build the context preamble.
2. Truncate transcript (the SRT plain text, stripped of timestamps) to ~500 words. Use `tokenCount(for:)` to verify fit if available, otherwise word-count heuristic.
3. Create a `LanguageModelSession` with instructions and `.permissiveContentTransform`.
4. Call `session.respond(to: prompt, generating: TitleSuggestion.self)` with `GenerationOptions(maximumResponseTokens: 50, sampling: .greedy)`.
5. Sanity-check the `.title` result: non-empty, under ~80 chars, not obviously garbage (exact rules TBD through testing).
6. `PUT /api/videos/:id/suggest-title` with the title.
7. Log result. On any failure (guardrail, context overflow, network, garbage output), log and move on — never block the `.transcribed` sidecar.

Gate the entire block on `#available(macOS 26, *)`. If unavailable, skip silently.

### Phase 4: Testing & prompt tuning

Run against a handful of real recordings and tune:
- The instruction wording (does it produce good titles? too generic? too long?)
- Whether few-shot examples in instructions are worth the token cost
- The sanity-check rules (what does "garbage" actually look like from this model?)
- Whether `prewarm()` is worth calling at transcription start for the ~1s latency saving
- Edge cases: very short recordings (<15s), silent recordings, recordings where the speaker takes a while to get to the point
