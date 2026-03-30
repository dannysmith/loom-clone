# Video Hosting: Build vs Buy

*Research date: 2026-03-30*

This is the single most impactful architectural decision for the project. The choice determines the scope and complexity of the entire server and delivery layer, what the desktop app uploads to, and how quickly videos become playable.

For prior research on individual services and platform embedding behavior, see `video-hosting-research.md`. This document builds on that foundation with deeper investigation into streaming ingest, current pricing, custom domain support, and a clear recommendation.

---

## Volume Assumptions

These numbers drive all cost calculations below:

- ~75 videos/month, ~3 min average = **225 minutes of new video/month**
- Cumulative storage grows: ~1,000 minutes stored after 4 months, ~3,000 after 12 months
- At 1080p/5 Mbps: 1 min ~ 38 MB, so 225 min ~ 8.5 GB new/month
- Delivery: ~75 videos x avg 10 views x 3 min = **2,250 minutes delivered/month** (~85 GB)
- Occasional spikes: a popular video might get 500+ views in a day

---

## The Core Tension: Streaming Ingest

The "instant URL" requirement is the hardest constraint to satisfy. Loom achieves this by converting to HLS segments on the client, uploading them during recording, and finalizing the playlist when recording stops. The video is on the CDN before you stop recording.

There are three possible approaches to achieving instant (or near-instant) playback:

**Approach A: HLS segment upload during recording (Loom's approach)**
The desktop app converts to HLS client-side and uploads segments individually. When recording stops, the playlist is finalized and the video is immediately playable. This requires either self-hosted storage (S3/R2) or a service that can receive HLS segments.

**Approach B: Live stream ingest (RTMP/SRT to managed service)**
Treat each recording as a "live stream" sent via RTMP to a service like Mux or Bunny. The service handles HLS conversion and CDN delivery in real time. When the stream ends, it automatically becomes a VOD asset. Video is watchable *during* recording.

**Approach C: Fast post-upload processing (Mux's just-in-time encoding)**
Upload the completed video file and rely on the service making it playable within seconds via JIT encoding. Not truly instant, but potentially fast enough if upload completes quickly.

Approach B is the most interesting discovery from this research. Using RTMP live ingest to a managed service gives us real-time HLS conversion and CDN delivery without building any of that ourselves, and the recording is watchable even *before* it ends.

---

## Service Evaluations

### Mux

**What it does**: Ingest, encoding, storage, CDN delivery (multi-CDN), player SDK, analytics. The most complete managed video platform for developers.

**Pricing (at our volumes, Basic quality, 1080p)**:
- Encoding: FREE (Basic quality)
- Storage: 1,000 min x $0.003/min = $3.00/mo (with cold storage discounts on older unwatched videos, realistically ~$1.50-2.00/mo)
- Delivery: 2,250 min delivered, well under the 100K free tier = FREE
- **Base cost: ~$2-3/mo, covered by the $20 monthly credit on pay-as-you-go**

**Custom domain**: Yes, but $100/month as an add-on for non-annual-contract customers. For annual contract customers, it's included. This is a significant cost for a personal project.

**Streaming ingest**: Yes, via RTMP/SRT live streaming. Create a live stream object via API, push RTMP from the desktop app, and the stream is watchable immediately via HLS. When recording stops, the stream automatically becomes a VOD asset with no re-encoding delay. This is the cleanest path to "instant URL."

**Just-in-time encoding**: Mux's JIT approach means even standard file uploads become playable within seconds. The video starts playing while encoding happens on-demand. For the fallback path (uploading a completed file), this is nearly instant.

**HLS/ABR**: Automatic. All videos get adaptive bitrate HLS with multiple renditions. No configuration needed.

**API quality**: Best in class. Clean REST API, comprehensive SDKs, webhooks, the `mux-player` web component. Well-documented.

**CDN independence**: Yes. Videos served from Mux's multi-CDN infrastructure. Independent of our server.

**Tradeoffs**:
- Custom domain at $100/mo is expensive for personal use
- Without custom domain, playback URLs are on `stream.mux.com` -- we still own `v.danny.is` for the video page, but the underlying HLS stream comes from Mux's domain
- No native oEmbed endpoint (we build our own, which is straightforward)
- Mux is a dependency: if Mux goes down, videos are unavailable (though Mux has excellent uptime)

---

### Cloudflare Stream

**Pricing (at our volumes)**:
- Storage: 1,000 min stored / 1,000 x $5 = $5.00/mo (prepaid in $5 increments)
- Delivery: 2,250 min / 1,000 x $1 = $2.25/mo
- Encoding/ingress: FREE
- **Total: ~$7-8/mo**

**Custom domain**: **NO for VOD playback.** This is confirmed as of late 2025 -- custom playback domains are available for live streaming ingest only, not for video-on-demand content. Videos serve from `customer-{hash}.cloudflarestream.com`. Community requests for VOD custom domains remain unaddressed. This is a deal-breaker for our "own domain" requirement unless we accept proxying through Workers (added complexity, potential TOS concerns).

**Streaming ingest**: RTMP live streaming supported, which auto-saves to VOD. Similar to Mux's approach.

**HLS/ABR**: Automatic.

**Verdict**: The lack of custom playback domains for VOD eliminates Cloudflare Stream from consideration. The `videodelivery.net` / `cloudflarestream.com` domain is also blocked by some corporate networks, which is problematic for a tool used in professional contexts.

---

### Bunny Stream

**Pricing (at our volumes)**:
- Storage: ~34 GB after 4 months x $0.01/GB = $0.34/mo
- CDN delivery: ~85 GB x $0.01/GB (EU/NA) = $0.85/mo
- Transcoding: FREE (standard transcoding included; premium is $0.05/min for 1080p if needed for faster encoding)
- **Total: ~$1-2/mo** (with free standard transcoding)

**Custom domain**: Yes. Bunny Stream supports custom CDN hostnames. Player and video content can be served from your own domain.

**Streaming ingest**: Yes, via RTMP. Bunny supports live streaming with RTMP ingest, and recordings automatically become VOD assets.

**HLS/ABR**: Automatic. Standard transcoding generates multiple renditions.

**API quality**: Good and improving. REST API, tus resumable uploads. Less polished than Mux but fully functional.

**Native oEmbed**: Yes, Bunny has a native oEmbed endpoint.

**CDN independence**: Yes. Videos served from Bunny's CDN (250 Tbps+ backbone, 119 PoPs). Independent of our server.

**Tradeoffs**:
- Standard (free) transcoding is slower than Mux's JIT approach -- there will be a delay between upload and multi-bitrate availability. The initial RTMP recording will be playable, but optimized renditions take time.
- Smaller company than Cloudflare or AWS -- higher vendor risk, though they've been around since 2015 and serve 85,000+ customers
- Documentation quality is below Mux
- The RTMP-to-VOD flow is less well-documented than Mux's

---

### api.video

**Pricing (at our volumes)**:
- Encoding: FREE
- Storage: 1,000 min x $0.00285 = $2.85/mo
- Delivery: 2,250 min x $0.0017 = $3.83/mo
- **Total: ~$6-7/mo**

**Custom domain**: Yes, supported. Requires separate subdomains for video, embed, and collector services.

**Streaming ingest**: RTMP/SRT for live streaming, progressive upload for VOD. Live streams auto-save as VOD.

**HLS/ABR**: Automatic.

**Notable features**: AI transcription and summarization included in the platform.

**Tradeoffs**:
- Less mature ecosystem than Mux
- Custom domain setup more complex (multiple subdomains)
- oEmbed support unclear from documentation
- Smaller developer community

---

### Self-Hosted: FFmpeg + R2 + Cloudflare CDN

**What you build**: Desktop app uploads HLS segments directly to Cloudflare R2. Server runs FFmpeg to generate multi-bitrate renditions. Cloudflare CDN serves everything with zero egress fees.

**Pricing (at our volumes)**:
- R2 storage: 34 GB x $0.015/GB = $0.51/mo (first 10 GB free)
- R2 egress: FREE (Cloudflare's zero-egress policy)
- R2 Class B operations (reads): ~85 GB / 0.375 MB per segment x 10,000 views = ~2.3M requests/mo x $0.36/million = $0.83/mo
- VPS for FFmpeg processing: $5-7/mo (Hetzner CX22 or similar)
- **Total: ~$6-8/mo** (including VPS)

Without a VPS (processing on local Mac after recording):
- **Total: ~$1.50/mo** (R2 storage + operations only)

**Custom domain**: Full control. R2 custom domains via Cloudflare DNS.

**Streaming ingest**: This is where it gets interesting. The desktop app can upload HLS segments directly to R2 during recording. Each segment is independently accessible via CDN as soon as it's uploaded. The M3U8 playlist is updated with each new segment. This is Loom's architecture but with our own infrastructure.

**HLS/ABR**: We build it. FFmpeg generates multi-bitrate renditions as a post-processing step. The initial recording plays as single-bitrate from the uploaded segments; optimized renditions replace them later.

**CDN independence**: Perfect. R2 + Cloudflare CDN is fully independent of our server. If the server is down, all previously published videos remain accessible.

**Tradeoffs**:
- We build and maintain the entire processing pipeline: FFmpeg job queue, error handling, retry logic, thumbnail generation, HLS manifest management
- We build the HLS segment upload mechanism in the desktop app (this is needed regardless -- it's how the recording pipeline works)
- We handle monitoring, debugging failed encodes, storage lifecycle management
- No managed player (we use Vidstack, which is our plan anyway)
- Operational burden scales with our ambition: basic FFmpeg transcoding is straightforward, but edge cases (corrupt files, codec issues, resolution detection) take time to handle well
- R2 free egress is the killer advantage -- at our volumes, bandwidth costs dominate other approaches

---

### Self-Hosted: B2 + Cloudflare CDN

**Pricing (at our volumes)**:
- B2 storage: 34 GB x $0.006/GB = $0.20/mo
- B2 egress to Cloudflare: FREE (Bandwidth Alliance)
- VPS for FFmpeg: $5-7/mo
- **Total: ~$5-7/mo**

Slightly cheaper storage than R2, but B2 is not as well integrated with Cloudflare as R2. Custom domain configuration is more complex. R2 is the better choice for a Cloudflare-centric setup.

---

## Comparison Matrix

| Requirement | Mux | Bunny Stream | api.video | CF Stream | Self-hosted (R2) |
|---|---|---|---|---|---|
| **Instant URL** | Yes (RTMP live ingest + JIT encoding) | Yes (RTMP live ingest) | Yes (RTMP live) | Yes (RTMP live) | Yes (direct HLS segment upload) |
| **Own domain (v.danny.is)** | Video page: yes. HLS stream: $100/mo add-on | Yes (custom CDN hostname) | Yes (multiple subdomains) | NO (deal-breaker) | Yes (full control) |
| **CDN independence** | Yes (Mux multi-CDN) | Yes (Bunny CDN) | Yes (api.video CDN) | Yes (CF CDN) | Yes (R2 + CF CDN) |
| **Cost/month** | ~$2-3 (or $20 with custom domain + Launch plan) | ~$1-2 | ~$6-7 | ~$7-8 | ~$1.50-8 |
| **HLS + ABR** | Automatic | Automatic | Automatic | Automatic | DIY (FFmpeg) |
| **Streaming ingest** | RTMP/SRT | RTMP | RTMP/SRT | RTMP | Direct HLS segment upload |
| **oEmbed** | Build own | Native | Unclear | Via 3rd party | Build own |
| **Custom metadata** | Via API | Via API | Via API | Via API | Full control |
| **Dev effort** | Low | Low | Low | Low | High |
| **Operational burden** | None | None | None | None | Moderate |
| **Migration out** | Download MP4s via API | Download via API | Download via API | Download via API | Already own files |
| **Vendor risk** | Low (well-funded) | Medium | Medium | Low (Cloudflare) | None |

---

## Cost Comparison at 12 Months

After 12 months: ~2,700 minutes stored, ~27,000 minutes delivered/year.

| Option | Monthly cost | Annual cost | Notes |
|---|---|---|---|
| **Mux (no custom domain)** | ~$2-3 | ~$24-36 | Covered by $20/mo credit; effectively $20/mo for the plan |
| **Mux (with custom domain)** | ~$120 | ~$1,440 | $100/mo custom domain add-on dominates |
| **Mux (Launch plan, no custom domain)** | $20 | $240 | $100 credit/mo, only ~$3 used |
| **Bunny Stream** | ~$1-2 | ~$12-24 | Cheapest managed option |
| **api.video** | ~$6-7 | ~$72-84 | AI features included |
| **Cloudflare Stream** | ~$7-8 | ~$84-96 | No custom domain (eliminated) |
| **Self-hosted (R2, no VPS)** | ~$1.50 | ~$18 | Process locally on Mac |
| **Self-hosted (R2 + VPS)** | ~$6-8 | ~$72-96 | VPS for server-side transcoding |

---

## The Streaming Ingest Question: Deep Dive

This is the most critical technical question. How does each option support the "recording streams up during recording, video is playable when you stop" requirement?

### Mux: RTMP Live Stream as Recording

Create a Mux live stream via API before recording starts. The desktop app pushes RTMP to `rtmps://global-live.mux.com:443/app` with the stream key. Mux immediately transcodes to HLS and makes it watchable at `https://stream.mux.com/{PLAYBACK_ID}.m3u8`. When the stream ends, it automatically becomes a VOD asset via `new_asset_settings` -- no re-encoding delay.

**Latency**: Standard ~30s glass-to-glass, reduced mode ~10-15s, low mode ~5s. For our use case (not real-time interaction), standard latency is fine -- the viewer doesn't need to watch in sync with recording.

**The clever bit**: The recording is watchable *during* recording, not just after. Someone could open the URL while you're still recording and see the video with ~30s delay.

**Desktop app requirement**: Push RTMP from the Swift app. This is well-supported -- AVFoundation can produce H.264+AAC and push via RTMP. Libraries like `HaishinKit` (Swift RTMP library) make this straightforward.

### Bunny Stream: RTMP Live Stream

Similar to Mux. Push RTMP to Bunny's ingest endpoint, stream is watchable live, recording saved as VOD. Less documentation around the specifics (reconnect windows, automatic VOD conversion settings).

### Self-Hosted: Direct HLS Segment Upload to R2

The desktop app converts to HLS locally (FFmpeg transmux to TS segments + M3U8 playlist) and uploads each segment to R2 as it's produced. The M3U8 playlist is updated after each segment upload. This is Loom's approach.

**Desktop app requirement**: More complex than RTMP push. Need to manage FFmpeg transmuxing, segment creation, S3-compatible upload for each segment, playlist management. This is doable but requires more desktop app code.

**Tradeoff**: More work on the desktop side, but zero dependency on any service for the ingest path. The segments go directly to storage/CDN.

### Hybrid: RTMP to Managed Service + Self-Hosted Storage

Push RTMP to Mux/Bunny for instant playback during and after recording. Meanwhile, keep a full local copy and upload to R2 for permanent storage. The managed service handles the real-time delivery; R2 handles long-term hosting.

This is interesting but adds complexity: two storage locations, need to synchronize, eventual migration from managed service URLs to self-hosted URLs. Not recommended unless the managed service pricing becomes a constraint.

---

## The Custom Domain Problem

This is where the decision gets sharp.

**The requirement**: Videos live at `v.danny.is`. The underlying HLS stream doesn't necessarily need to come from `v.danny.is` -- the video *page* is ours, and the HLS player loads the stream from wherever it lives. But ideally, the stream URL itself is on our domain too, for brand consistency and to avoid corporate firewall issues.

**Mux**: The video page at `v.danny.is/welcome-to-the-team` is ours. It embeds `mux-player` which loads HLS from `stream.mux.com/{id}.m3u8`. The viewer never sees the Mux domain (the player hides it). Custom domain ($100/mo) would change this to `stream.v.danny.is/{id}.m3u8`. For a personal project, the $100/mo for custom domain is hard to justify. But the video page URL is ours regardless.

**Bunny Stream**: Custom CDN hostname means the HLS stream itself can come from `cdn.v.danny.is` or similar. No extra cost.

**Self-hosted (R2)**: Full control. Everything on our domain.

**Practical reality**: Most viewers never see or care about the underlying HLS stream URL. They see `v.danny.is/welcome-to-the-team` in their browser. The player loads the stream transparently. The custom-stream-domain issue matters mainly for: (1) corporate firewalls that might block `stream.mux.com`, (2) technical purity. For a personal tool, this is a minor concern.

---

## Recommendation

### Primary: Mux (RTMP ingest, no custom stream domain)

**Use Mux's live streaming as the ingest mechanism.** The desktop app pushes RTMP to Mux. The recording is instantly watchable via HLS. When recording stops, it becomes a VOD asset with zero delay. Our server manages metadata (title, slug, description, tags, visibility) and serves the video page at `v.danny.is`. Mux handles encoding, storage, CDN delivery, and adaptive bitrate.

**Why Mux over self-hosted**:
- Eliminates the entire encoding pipeline from our scope. No FFmpeg job queue, no failed encode debugging, no rendition management.
- The RTMP ingest path is simpler to implement in the desktop app than client-side HLS segmentation + S3 upload. Push RTMP with a Swift library vs. manage FFmpeg transmuxing + segment uploads + playlist updates.
- JIT encoding means even file uploads (for MP4 imports) are playable in seconds.
- 100K free delivery minutes/month means we never pay for delivery at our volumes.
- Cold storage automatically discounts older unwatched videos.
- The $20/mo Launch plan gives $100/credit, which far exceeds our ~$3/mo actual usage. We're paying $20/mo for what amounts to zero operational burden.

**Why not the custom stream domain**:
- $100/mo is disproportionate for a personal project. The video page URL (`v.danny.is/{slug}`) is ours regardless.
- If corporate firewalls blocking `stream.mux.com` becomes a real problem, we can add the custom domain later or migrate to self-hosted.

**Monthly cost**: $20/mo (Launch plan). Actual usage ~$3/mo, but the $20/mo buys peace of mind and $100 in credit headroom.

### Fallback: Self-Hosted (R2 + Cloudflare CDN)

If Mux's pricing model changes unfavorably, or if the custom domain issue becomes a real problem, or if we simply want full control later, the self-hosted path with R2 is the clear second choice.

**Why R2 as the fallback, not Bunny**:
- Zero egress fees make it the cheapest option at any scale
- Full domain control
- Cloudflare's CDN infrastructure is world-class
- We already need to manage R2 for other storage (thumbnails, metadata, backups)
- The migration path from Mux is clean: download MP4s via Mux API, transcode to HLS with FFmpeg, upload segments to R2

**What the fallback requires**:
- FFmpeg transcoding pipeline on a VPS (~$5-7/mo)
- HLS segment upload logic in the desktop app (more complex than RTMP push)
- Job queue for background processing
- Monitoring and error handling for encodes

### Why Not Bunny Stream?

Bunny is tempting -- cheapest managed option ($1-2/mo), custom domain included, native oEmbed. But:

- Mux's developer experience, documentation, and API quality are meaningfully better
- Mux's JIT encoding means faster upload-to-playback
- Mux's Live Stream RTMP-to-VOD flow is better documented and tested
- The price difference ($20/mo vs $2/mo) is not meaningful for a personal project where development time matters far more than hosting costs
- If we're going to use a managed service, use the best one

### Why Not Cloudflare Stream?

No custom playback domain for VOD. Eliminated.

### Why Not api.video?

Viable option but doesn't offer anything Mux doesn't do better, at a higher price point. The included AI transcription is nice but not a differentiator -- we can add transcription separately via Whisper or Deepgram.

---

## Architecture with Mux

```
Desktop App (Swift)
    |
    |-- RTMP push --> Mux Live Stream --> HLS playback (instant)
    |                     |
    |                     v
    |               VOD Asset (automatic on stream end)
    |
    |-- Local copy --> Upload to R2 (backup/archive)
    |
    v
Our Server (manages metadata, serves v.danny.is)
    |
    |-- Video page at v.danny.is/{slug}
    |-- Embeds mux-player pointing to Mux HLS URL
    |-- oEmbed endpoint at v.danny.is/oembed
    |-- Admin interface for metadata management
```

**Recording flow**:
1. Desktop app calls our API to create a video record + get a Mux live stream object
2. API returns: video ID, slug (auto-generated), Mux stream key, Mux playback ID
3. Desktop app starts RTMP push to Mux
4. URL is on clipboard immediately: `v.danny.is/{hash}` (unlisted by default)
5. Video is watchable at that URL within seconds (the page embeds the Mux live stream HLS)
6. Recording stops: Mux converts live stream to VOD asset automatically
7. Desktop app uploads the full local copy to R2 as backup
8. Server triggers post-processing: thumbnail generation, transcription (optional)

**Viewing flow**:
1. Viewer hits `v.danny.is/{slug}`
2. Server renders video page with OG tags, oEmbed discovery, and `mux-player`
3. `mux-player` loads HLS from Mux's CDN
4. Adaptive bitrate, quality selection, all handled by Mux

---

## Migration Path

### From Mux to Self-Hosted

If we need to migrate away from Mux:

1. All videos have local copies in R2 (uploaded as backup during recording)
2. Run FFmpeg on each R2 file to generate HLS renditions
3. Update the video page to point to R2-hosted HLS instead of Mux playback IDs
4. Swap `mux-player` for `Vidstack` with `hls.js` pointed at R2 URLs

The R2 backup means migration is a batch processing job, not a crisis. No data is locked in Mux.

### From Mux to Bunny Stream

If we want a cheaper managed service:

1. Upload existing MP4s from R2 to Bunny Stream via API
2. Update video records with Bunny playback URLs
3. Switch player from `mux-player` to Bunny's player (or keep Vidstack)

---

## What We Give Up and What We Get

### With Mux (recommended)

**We give up**:
- Full control over the encoding pipeline (Mux's Basic quality is good but we don't choose exact settings)
- Custom HLS stream domain without paying $100/mo
- $20/mo in costs (vs ~$1.50/mo for self-hosted)
- Some vendor dependency (Mux is well-funded and stable, but it's still a dependency)

**We get**:
- Zero encoding pipeline to build or maintain
- Instant playback via RTMP live ingest (the simplest path to "instant URL")
- Automatic adaptive bitrate HLS
- 100K free delivery minutes/month (we'll never exceed this)
- Cold storage discounts
- JIT encoding for imported MP4s
- Best-in-class API and developer experience
- More time to focus on the desktop app (where the real novelty and difficulty are)

### With Self-Hosted (fallback)

**We give up**:
- Many hours building the FFmpeg pipeline
- Operational simplicity (monitoring, debugging, maintenance)
- Immediate adaptive bitrate (initial playback is single-quality until post-processing completes)

**We get**:
- Full control over everything
- Lowest possible cost (~$1.50/mo)
- Complete domain ownership
- Zero vendor dependency
- Direct HLS segment upload (though more complex to implement)

---

## Decision

**Start with Mux. Keep R2 as the backup/archive layer. Design the system so migration to self-hosted is straightforward if needed.**

The $20/mo cost is negligible compared to the development time saved. The RTMP ingest path is the simplest way to achieve the instant-URL requirement. The desktop app and admin interface are where the real work is -- we should not be spending weeks building a video encoding pipeline when Mux eliminates it entirely.

The architecture is designed for migration: local copies go to R2, video pages are on our domain, the player can be swapped. We're renting Mux's encoding and CDN, not locking into it.
