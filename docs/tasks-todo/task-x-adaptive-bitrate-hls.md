# Task — Adaptive Bitrate HLS for Viewers

Unprioritised. May or may not be done. This document captures the context so a future session can decide.

## What this is about

The viewer-facing player at `/:slug` (and `/:slug/embed`) currently lets users manually pick between source / 1080p / 720p MP4 variants via the Vidstack quality menu (see the implementation that landed under task-2-adaptive-quality). That gives users *manual* quality control, but not *adaptive* quality control — once a source is loaded, switching qualities means the player reloads the file. There is no segment-level bitrate adaptation as bandwidth changes mid-playback.

This task is about whether to upgrade the playback path to a true adaptive bitrate (ABR) HLS stream — one master playlist referencing multiple bitrate variants, with hls.js (or native HLS in Safari and Chrome 142+) doing automatic mid-stream quality switching.

## Why this might be worth doing

- **Graceful recovery from network dips.** A viewer on Wi-Fi who briefly drops to a weaker signal currently either buffers or has to manually downgrade. ABR would smoothly switch them down and back up without interruption.
- **Better default for unknown viewers.** The single-source-per-page approach has to pick a default. ABR means the player probes bandwidth and picks for itself, rather than us guessing.
- **CDN-readiness.** If/when this project moves behind Cloudflare Workers + KV (the planned Viewer Layer per `AGENTS.md`), serving HLS at the edge is a well-trodden path. Industry standard.
- **Engineering interest.** It's a clean piece of work with a clear endpoint.

## Why this might NOT be worth doing

For a personal tool whose viewer base is overwhelmingly desktop-on-broadband (Slack screenshares for colleagues, Notion embeds in internal docs), the manual quality menu from task-2 is probably enough. The marginal win from segment-level ABR is small unless we start seeing actual playback complaints.

It is reasonable to keep this on the backlog indefinitely and only pick it up if (a) we see evidence of viewers struggling with the current setup, (b) a CDN move forces the question anyway, or (c) it just feels worth doing.

## Key constraints from earlier discussion

These shaped the framing and should be respected by any future implementation.

### MP4 derivatives must remain on disk

Even if HLS becomes the playback path, the project must continue to keep `source.mp4` and the `720p.mp4` / `1080p.mp4` derivatives on disk:

- `source.mp4` is the canonical archive copy and the target of the `/:slug.mp4` convenience redirect. It is also what users expect when they want to download the video.
- The lower-resolution MP4 derivatives are useful for direct download too (smaller file when someone wants to share it elsewhere) and as an obvious "download a smaller version" affordance.
- Generating these on demand (per-request) was considered and rejected: not viable on a modest server.

So this work is *additive* — it cannot replace the MP4 derivatives, only augment them with HLS playback metadata.

### Streamed-up live segments are not the right input

The `seg_NNN.m4s` segments uploaded by the macOS app during recording are pre-post-processing. They have not been through the audio denoise + loudness normalisation chain that `derivatives.ts` runs over `source.mp4`. If we tried to reuse the live segments as one of the ABR variants, viewers would get an audibly worse audio track for that variant.

The current daily cleanup job (in `src/lib/cleanup.ts`) deletes the live segments 10 days after a video transitions to complete. That job stays — it would not need to change for this work, because the ABR variants would be built off the post-processed MP4 derivatives, not the live segments.

The healing-window playback path (single-bitrate HLS playlist while `source.mp4` doesn't exist yet) also stays as-is. ABR only kicks in once the derivatives pipeline has run.

## A path that softens the disk-usage cost

The user's first instinct in conversation was that adopting ABR would mean carrying significant additional segment files on disk per video (one set per quality variant, on top of the MP4 derivatives). That is true under the naïve approach but probably avoidable.

HLS supports `#EXT-X-BYTERANGE` entries — a media playlist can reference byte ranges into a single file rather than separate per-segment files. Combined with fragmented MP4 (`fmp4`, `-movflags frag_keyframe+empty_moov+default_base_moof`), this means each variant playlist could point directly into the existing `source.mp4` / `1080p.mp4` / `720p.mp4` derivatives. Net new disk: a handful of small `.m3u8` text files per video (one master + one per variant). The MP4 files we are keeping anyway *become* the segments.

This is worth confirming as feasible at the time of implementation — it is the standard approach for "ABR over existing MP4 assets" but the details matter.

## What would have to change in the encoding pipeline

Two preconditions for the byte-range approach:

1. **Keyframe alignment.** All variants need GOP boundaries at the same wall-clock times so the player can switch variants on segment boundaries without artefacts. The current `derivatives.ts` recipes for 720p and 1080p use libx264 without enforced keyframe intervals. They would need something like `-g 120 -force_key_frames 'expr:gte(t,n_forced*4)'` for 4-second GOPs at 30 fps, plus matching settings on the source-quality variant if that needs to be re-fragmented.

2. **Fragmented MP4 output.** The derivative MP4s would need to be written as fragmented MP4 (via the `-movflags` set above). This is compatible with the current "single file, byte-range serving via `serveFileWithRange`" — the `<media-player>` and direct download paths continue to work.

Audio is already aligned across variants for free: the current 720p / 1080p derivative recipes copy audio from the post-processed source (`-c:a copy`), so audio frames are bit-identical across variants. No work needed there.

## What would have to change on the serving side

- A new derivative step that writes `master.m3u8` plus per-variant media playlists (`source.m3u8`, `1080p.m3u8`, `720p.m3u8`) into `derivatives/`. These reference the existing MP4 files via `#EXT-X-BYTERANGE`.
- The viewer resolver (`server/src/routes/videos/resolve.ts`) picks the master playlist as the `src` when it exists, with the existing single-MP4 path as a fallback if the playlist generation step failed for any reason.
- A new entry in the `/:slug/stream/:file` (or possibly `/:slug/raw/:file`) allowlist for the new playlist filenames. Per-segment fetching still routes to the underlying MP4 file with byte ranges, so no new file-serving logic should be needed.
- The healing-window single-playlist path stays untouched — it serves while derivatives haven't landed.

## Open questions for whoever picks this up

- Is the byte-range fMP4 approach actually compatible with our specific encoding setup, or are there gotchas (init segments, `moov` placement, edit lists from `+faststart`)? Worth a small spike before committing to it. The fallback is duplicate per-variant segment files — works, but bloats disk.
- Does the master-playlist approach play correctly through Vidstack's default `<media-video-layout>` with the quality menu already wired up? It should — hls.js handles ABR transparently and exposes variants in `player.qualities`, the same property the manual menu uses today — but verify.
- Is any of this worth the effort? Re-evaluate before doing the work. If the manual quality menu has been in production for months without user complaints, the answer might be "no".

## Where the relevant code lives

- Derivative generation pipeline: `server/src/lib/derivatives.ts`
- Variant definitions and the `variantsForHeight` policy: same file, see `VARIANTS` constant.
- Viewer resolver (current MP4-vs-HLS selection): `server/src/routes/videos/resolve.ts`
- Media serving (byte-range support is already there): `server/src/routes/videos/media.ts` and `server/src/lib/file-serve.ts`
- Live-recording playlist builder (separate from this work, stays as-is): `server/src/lib/playlist.ts`
- Cleanup job (stays as-is): `server/src/lib/cleanup.ts`
- Streaming and healing reference: `docs/developer/streaming-and-healing.md`
- Server routes reference: `docs/developer/server-routes-and-api.md`
