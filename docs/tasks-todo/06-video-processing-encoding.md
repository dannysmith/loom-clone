# Research: Video Processing & Encoding Pipeline

## Priority

Tier 2 — The scope of this task depends on the outcome of Task 04 (Build vs Buy). If we use a managed service, much of this becomes irrelevant. If we self-host, this is critical infrastructure. Either way, we need to understand the fundamentals.

## Context

Regardless of whether we use a managed video service or self-host, we need to understand video encoding, HLS packaging, and the processing pipeline. At minimum, the desktop app needs to produce video in a format suitable for upload and initial playback. If we self-host, we also need to transcode into multiple quality renditions for adaptive streaming. Read `requirements.md` for full project context, particularly the "Receiving & Processing" section.

## Key Questions

### Codecs & Formats

- **H.264 (AVC)** — The universal baseline. What encoding settings produce good quality at reasonable file sizes for screen recordings and talking-head video?
- **H.265 (HEVC)** — Better compression than H.264, but what's the current browser support situation? Any licensing concerns?
- **AV1** — Best compression, royalty-free. But encoding is slow. Browser support? Is it practical for our use case?
- **VP9** — Google's codec. Where does it fit?
- For our use case (mostly screen recordings and talking-head video, not cinematic content), which codec makes sense as the primary output? Which as a secondary/future option?
- What container formats? MP4 (fMP4) vs MPEG-TS for HLS segments?

### HLS Packaging

- What does a well-configured HLS output look like? Master playlist, variant playlists, segment files.
- What quality renditions make sense for our use case? (e.g. 1080p, 720p, 480p? Or different for screen recordings vs camera recordings?)
- What segment duration is standard? How does it affect seeking, startup time, and adaptive switching?
- fMP4 vs TS segments — which is preferred for modern HLS and why?

### FFmpeg

- What FFmpeg commands produce good HLS output from a source recording?
- What encoding presets balance quality, file size, and encoding speed?
- Hardware acceleration — can we use GPU encoding (VideoToolbox on macOS, NVENC, VAAPI) to speed up processing? What are the quality tradeoffs?
- How do we generate thumbnails? (Single frame, or animated preview like Loom?)
- How do we generate multiple renditions efficiently? (Single-pass with multiple outputs, or multiple passes?)

### Processing Pipeline Design (if self-hosted)

- What does a reliable processing pipeline look like? Job queue? Worker process?
- How do we handle failures? (Encoding crashes, disk space issues, corrupt input.)
- What's the processing time for a typical 3-minute video? (Rough estimate, with and without hardware acceleration.)
- How do we signal processing status? (Uploading → Processing → Ready.)
- Can we make the video playable in low quality while high-quality renditions are still processing?

### Desktop App Output

- What format should the desktop app's capture pipeline produce? This needs to be compatible with both direct HLS playback (for the instant-URL feature) and subsequent transcoding.
- If the desktop app produces HLS segments during recording for streaming upload, what codec and quality settings should those segments use?
- If we also upload a full-quality master file afterward, what format should that be?

### Screen Recording Specifics

- Screen recordings have different characteristics from camera footage — large flat areas, text, sharp edges, occasional high motion. Do they benefit from different encoding settings?
- What about variable frame rate? Screen content often doesn't change at 30/60fps — does variable frame rate encoding help with file size?

## Research Approach

- Study FFmpeg documentation for HLS output, encoding presets, and hardware acceleration.
- Look at what encoding settings Loom, Cap, and YouTube recommend or use.
- Research current browser codec support tables (caniuse.com or similar).
- Look for best-practice guides on HLS packaging from Apple, Mux, Cloudflare, or Bitmovin.
- Test or find benchmarks for encoding speed at different presets and with hardware acceleration.
- Look at how screen recording tools optimise encoding for screen content specifically.

## Expected Output

A research document that:

1. Recommends a primary codec and encoding configuration for our use case, with reasoning.
2. Describes the ideal HLS output structure (renditions, segments, playlists).
3. Provides example FFmpeg commands for the key operations.
4. Outlines a reliable processing pipeline architecture (if self-hosting).
5. Covers the desktop app's output format requirements.
6. Estimates processing time and resource requirements.
7. Notes any important encoding differences for screen recordings vs camera recordings.

## Related Tasks

- Task 01 (macOS Recording APIs) — the capture pipeline's output feeds into this.
- Task 02 (Streaming Upload Architecture) — the streaming segments need specific encoding settings.
- Task 04 (Build vs Buy) — if we use a managed service, most server-side processing is handled for us.
- Task 07 (Storage, CDN & Cost Modelling) — encoding settings affect file sizes, which affect storage and bandwidth costs.
