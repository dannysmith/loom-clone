# Research: Transcription & AI Features

## Priority

Tier 3 — Nice-to-have features in the requirements, but potentially high-impact for the product. Understanding the options early means we can design the system to accommodate transcription without retrofitting later.

## Context

The requirements list several AI-powered features as nice-to-haves: automatic transcription, subtitle generation, AI-suggested titles and slugs, and on-device transcription using Apple's AI capabilities. Transcription in particular could meaningfully improve the product — it enables search, subtitles, auto-generated titles, and makes video content accessible. Read `requirements.md` for full project context, particularly the "Nice-to-Haves" sections for both the desktop app and server.

## Key Questions

### On-Device Transcription (macOS)

- What does Apple's **Speech framework** offer for on-device speech recognition? Quality? Speed? Language support?
- What about **Apple Intelligence** features available on newer macOS versions? Any transcription capabilities?
- Can **Whisper** run locally on a Mac? What model sizes are practical? What's the transcription speed relative to audio duration? (e.g. can we transcribe a 3-minute video in under 30 seconds?)
- **whisper.cpp** and **MLX Whisper** — what's the state of optimised local Whisper implementations for Apple Silicon?
- Could transcription happen *during* recording (real-time) or only after? Real-time would let us have a transcript ready at the same time as the video.
- What's the accuracy like for different types of content? (Casual speech, technical terminology, screen share narration.)

### Cloud Transcription APIs

- **OpenAI Whisper API** — Quality, speed, cost per minute of audio. Batch vs real-time.
- **Deepgram** — Known for speed and accuracy. Pricing at our volumes.
- **AssemblyAI** — Feature-rich (speaker diarization, sentiment, summarization). Pricing.
- **Google Cloud Speech-to-Text** — Quality, pricing.
- **AWS Transcribe** — Quality, pricing.
- How do these compare on accuracy, speed, and cost for our expected volumes (~75 videos/month, ~3 min average)?

### Where in the Pipeline?

- **On-device during recording** — Transcript is ready when recording stops. Zero cloud cost. But: adds CPU load during recording, might affect recording performance.
- **On-device after recording** — Transcribe while uploading. Transcript arrives alongside or shortly after the video. Still zero cloud cost.
- **Server-side after upload** — Server runs Whisper or calls a cloud API. Centralised, but adds processing cost and latency.
- **Cloud API after upload** — Fastest server-side option, but ongoing cost.
- Which approach (or combination) makes the most sense? Could we default to on-device and fall back to server-side?

### Output Format & Usage

- What format should transcripts be stored in? Plain text? SRT/VTT for subtitles? Timestamped segments?
- How do we generate **subtitles/closed captions** from a transcript? (SRT or WebVTT format.)
- How do we use the transcript for **search**? (Full-text search over transcript content in the database.)
- How do we use the transcript for **AI title/slug suggestions**? (Feed transcript to an LLM, get suggested title.)
- What about **chapter markers** or **summary generation** from the transcript?

### Quality & Accuracy

- What's the realistic accuracy for each option? (Word error rate.)
- How do they handle technical jargon, proper nouns, and casual speech?
- Is post-processing (capitalisation, punctuation, formatting) included or do we need to handle it?
- How much does accuracy matter for our use cases? (Subtitles need high accuracy; search can tolerate some errors; title suggestions are fine with rough transcripts.)

## Research Approach

- Test or find benchmarks for Whisper model sizes on Apple Silicon (speed vs accuracy tradeoff).
- Check Apple's Speech framework documentation for current capabilities.
- Compare cloud API pricing calculators at our expected volumes.
- Look at how Loom, Cap, and other tools handle transcription.
- Research WebVTT/SRT generation from timestamped transcripts.
- Consider the integration points — how does transcription fit into the overall pipeline without complicating it?

## Expected Output

A research document that:

1. Compares on-device vs cloud transcription options with quality, speed, and cost tradeoffs.
2. Recommends where transcription should happen in the pipeline (on-device, server, or cloud).
3. Recommends a specific transcription approach (e.g. "Whisper medium model on-device via whisper.cpp").
4. Describes how transcripts feed into subtitles, search, and title suggestion.
5. Estimates the cost of cloud transcription at our volumes (if recommending a cloud approach).
6. Notes any integration considerations for the desktop app and server architecture.

## Related Tasks

- Task 01 (macOS Recording APIs) — on-device transcription adds to the desktop app's responsibilities.
- Task 08 (Server & Admin Stack) — server-side transcription affects the processing pipeline and database schema.
