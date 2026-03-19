# Research: Streaming Upload Architecture

## Priority

Tier 1 — This is the core technical problem that enables the product's single most important feature: a working URL within seconds of stopping recording.

## Context

The product requirement is that when a user hits "stop recording," a shareable URL is on the clipboard within seconds and the video is immediately playable. This rules out the naive approach of "finish recording, upload the whole file, process it, then share." Instead, the video must be streamed to the server during recording so that it's already (mostly) there when recording stops. Read `requirements.md` for full project context, particularly the "Instant Shareability" principle and "Streaming Upload" section.

The existing Loom research (`docs/research/loom-research.md`) covers some of this at a high level. This task goes deeper into the technical implementation.

## Key Questions

### Client-Side Segmentation

- How does client-side HLS segmentation work during recording? Do we generate .ts (MPEG Transport Stream) or fMP4 (fragmented MP4) segments?
- What segment duration is optimal? Shorter segments = lower latency to playability, but more overhead. Loom appears to use ~2-6 second segments.
- How do we generate segments in real-time from the capture pipeline? Does AVAssetWriter support this directly, or do we need a separate segmentation step?
- What happens at segment boundaries — is there a quality/compression penalty?
- How do we handle the m3u8 playlist file? Is it generated client-side and uploaded, or does the server build it from received segments?

### Upload Protocol

- What protocol do we use to upload segments? Simple HTTPS PUT/POST for each segment? Chunked upload? WebSocket? tus.io (resumable uploads)?
- How do we handle segment ordering and completeness? What if segments arrive out of order?
- What's the upload latency — how quickly after a segment is recorded can it be on the server?
- How do we handle the "final segment" problem? When recording stops, the last partial segment needs to be flushed, uploaded, and the playlist finalised.

### Network Resilience

- What happens when the network drops mid-recording? The recording must continue locally (per requirements). When connectivity returns, how do we resume uploading?
- How do we handle slow/degraded networks? Do we queue segments? Reduce quality for the streaming version?
- Should there be a "dual quality" approach — stream a lower-quality version for instant playback, then upload the full-quality version afterward for replacement? (The requirements suggest this is acceptable.)

### Server-Side Handling

- How does the server receive and organise incoming segments?
- How does the server make the video playable before all segments have arrived? (Progressive HLS — the playlist grows as segments arrive.)
- What does the server-side playlist management look like? EVENT vs VOD playlist types in HLS.
- When recording stops, what's the sequence? Final segment upload → playlist finalisation → URL becomes "complete"?
- How does the server handle the transition from "still uploading" to "upload complete" to "fully processed with multiple renditions"?

### Quality Pipeline

- If we stream at reduced quality during recording for speed, when and how does the full-quality replacement happen?
- Does the full-quality upload happen as a single file or also as segments?
- How does the player handle the transition from streaming-quality to full-quality? Does the URL need to update, or can HLS handle this transparently?

### Alternative Approaches

- Are there alternatives to HLS segmentation for achieving instant playback? (e.g. WebRTC-based streaming, progressive MP4 upload with byte-range support?)
- What about using a media server like MediaMTX or SRS as an intermediary?
- Could we use WebSocket or Server-Sent Events to stream raw video data and transcode server-side? (Likely too slow, but worth understanding why.)

## Research Approach

- Deep-dive into the HLS specification, particularly live/event streaming and how playlists work for ongoing streams.
- Study how Loom implements this (expand on `docs/research/loom-research.md`).
- Look at Cap's implementation in `~/dev/Cap/` — how do they handle upload during recording?
- Research tus.io and other resumable upload protocols.
- Look for any open-source implementations of "record and stream HLS segments" patterns.
- Research how live streaming platforms (Twitch, YouTube Live) handle similar problems — they solve the "playable before complete" problem, though at different scale.

## Expected Output

A research document that:

1. Describes the recommended architecture for streaming upload, step by step from capture to playable URL.
2. Covers the segment format, upload protocol, server-side handling, and playlist management.
3. Addresses network resilience — what happens when things go wrong.
4. Evaluates the dual-quality approach (stream low, replace with high).
5. Estimates the achievable latency: how many seconds between "hit stop" and "URL works."
6. Identifies any significant technical risks or unknowns.
7. Notes relevant protocols, libraries, or tools (e.g. HLS.js, tus.io, media server options).

## Related Tasks

- Task 01 (macOS Recording APIs) — the capture pipeline produces the output that this upload pipeline consumes. The output format must be compatible.
- Task 03 (Cap Codebase Analysis) — Cap has implemented a version of this.
- Task 04 (Video Hosting: Self-Hosted vs Managed) — if we use a managed service, the server-side handling may be very different.
