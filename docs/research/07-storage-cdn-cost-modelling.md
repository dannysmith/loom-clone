# Storage, CDN & Infrastructure Cost Modelling

*Research date: 2026-03-30*

Concrete cost estimates for different architectural approaches to the personal video tool. All prices verified against current provider pricing pages as of March 2026. For project context, see `requirements.md`. For the build-vs-buy recommendation (Mux as primary, R2 as fallback), see `04-video-hosting-build-vs-buy.md`.

---

## Volume Assumptions

These numbers drive every calculation in this document. Derived from `requirements.md` constraints.

**Recording volume:**
- 75 videos/month, 3 min average = 225 minutes of new video/month
- 900 videos/year, 2,700 minutes/year

**Per-video storage footprint (source file):**
- 1080p H.264 at 5 Mbps: ~38 MB/min, so 3 min = ~113 MB per video
- Source files: 75 videos x 113 MB = ~8.5 GB of new source footage/month

**Per-video storage footprint (with HLS renditions):**
- Single-quality initial stream (1080p, uploaded during recording): ~113 MB
- Multi-bitrate HLS renditions (1080p + 720p + 480p): roughly 2x the source = ~226 MB
- Thumbnails, init segments, metadata: ~2 MB
- **Total per video (self-hosted): ~230 MB** (~17 GB new storage/month)
- With Mux, we only store source backup in R2: ~113 MB per video (~8.5 GB new/month)

**Cumulative storage growth:**

| Timeframe | Videos | Source only (R2 backup) | Full self-hosted (source + renditions) |
|---|---|---|---|
| Month 1 | 75 | 8.5 GB | 17 GB |
| 6 months | 450 | 51 GB | 102 GB |
| 12 months | 900 | 102 GB | 204 GB |
| 36 months | 2,700 | 306 GB | 612 GB |

**Existing library import:** ~300 videos from Loom/Cap. At ~113 MB each: ~34 GB of source files to import. This is a one-time addition.

**Delivery bandwidth:**
- Average 10 views per video (most get 1-2, some get 30-100)
- 75 videos x 10 views x 3 min average = 2,250 minutes delivered/month
- At mixed-quality delivery (~3 Mbps average accounting for ABR): ~50 GB/month bandwidth
- At single-quality 1080p (5 Mbps): ~85 GB/month bandwidth
- We use **85 GB/month** as the conservative estimate

**Delivery operations (for R2 Class B cost calculation):**
- Average HLS video has ~45 segments (3 min / 4 sec) + init segment + playlist
- Per view: ~47 GET requests for segments + ~3 playlist fetches = ~50 requests
- 750 views/month x 50 requests = ~37,500 requests/month
- This is well within R2's free tier of 10 million Class B operations/month

---

## Component-Level Pricing

### Object Storage

| Provider | Storage/GB/mo | Egress | Free tier | Notes |
|---|---|---|---|---|
| **Cloudflare R2** (Standard) | $0.015 | FREE | 10 GB storage, 10M reads/mo | Zero egress is the killer feature |
| **Cloudflare R2** (Infrequent Access) | $0.010 | FREE (+ $0.01/GB retrieval) | None | 30-day min storage duration |
| **Backblaze B2** | $0.006 | FREE to Cloudflare (Bandwidth Alliance), otherwise $0.01/GB | 10 GB storage | Cheapest raw storage |
| **AWS S3 Standard** | $0.023 | $0.09/GB (first 10 TB) | 5 GB for 12 months (new accounts) | Egress makes it expensive |
| **AWS S3 Infrequent Access** | $0.0125 | $0.09/GB + $0.01/GB retrieval | None | Still expensive with egress |
| **Hetzner Object Storage** | ~$0.008/GB (via base plan) | $1.20/TB overage | 1 TB storage + 1 TB egress included in $5.99/mo base | Great value with base plan |

**At our volumes (102 GB at 12 months, with delivery):**

| Provider | Storage cost/mo (12mo) | Egress cost/mo | Operations cost/mo | Total/mo |
|---|---|---|---|---|
| **Cloudflare R2** | $1.38 | $0.00 | $0.00 (within free tier) | **$1.38** |
| **Backblaze B2 + CF** | $0.55 | $0.00 (Bandwidth Alliance) | ~$0.00 | **$0.55** |
| **AWS S3 + CloudFront** | $2.35 | $7.23 (CF) or $0 (free tier) | ~$0.01 | **$2.36 - $9.58** |
| **Hetzner Object Storage** | $5.99 flat (includes 1 TB each) | Included | Included | **$5.99** |

**Winner: Cloudflare R2.** Zero egress fees, generous free tier for operations, and good integration with Cloudflare CDN. B2 is cheaper for raw storage but R2's zero egress and S3 API compatibility make it the better choice for a Cloudflare-centric setup.

**Note on R2 Infrequent Access:** Old, rarely-viewed videos could be moved to R2 IA ($0.01/GB vs $0.015/GB) for a 33% storage discount, but the $0.01/GB retrieval fee and 30-day minimum make it marginal at our volumes. Not worth the complexity initially.

---

### CDN / Bandwidth

| Provider | Price/GB (EU+NA) | Free tier | Video serving allowed? |
|---|---|---|---|
| **Cloudflare CDN (free plan)** | FREE | Unlimited bandwidth | Complicated -- see below |
| **Cloudflare R2 (direct egress)** | FREE | Unlimited | Yes, R2 is a paid service |
| **Bunny CDN** | $0.01/GB | None (but $1/mo minimum) | Yes |
| **AWS CloudFront (free plan)** | $0.00 | 100 GB/mo, 1M requests/mo | Yes |
| **AWS CloudFront (pay-as-you-go)** | $0.085/GB | None | Yes |

**The Cloudflare Video Serving Question:**

Cloudflare's Self-Serve Subscription Agreement states that the free CDN plan should not be used for serving video unless through a paid service. However, **R2 is a paid service**. Content served from R2 goes through Cloudflare's CDN with zero egress charges, and this is explicitly part of R2's value proposition. The old Section 2.8 restriction on non-HTML content has been removed from the current ToS.

Real-world evidence: screencasting.com publicly documents serving 15 TB of 4K video from R2 for $2.18/month. Multiple community posts confirm R2 video serving is accepted.

**Conclusion:** Serving HLS segments from R2 via Cloudflare's CDN is the intended use case for R2 and is within the terms of service. No separate CDN needed.

**At our volumes (85 GB/month):**

| CDN approach | Monthly cost |
|---|---|
| **R2 direct (Cloudflare CDN)** | $0.00 (egress is free) |
| **Bunny CDN** | $0.85 |
| **CloudFront free plan** | $0.00 (within 100 GB limit) |
| **CloudFront pay-as-you-go** | $7.23 |

---

### Compute / VPS

For the self-hosted scenarios, we need a server to run: the web application (metadata, admin, video pages), background processing (FFmpeg transcoding, thumbnail generation), and segment ingest (receiving uploads during recording).

For the Mux scenario, the server is thin: just metadata management, serving video pages, and receiving/forwarding the R2 backup upload.

| Provider | Plan | vCPUs | RAM | Disk | Traffic | Monthly cost |
|---|---|---|---|---|---|---|
| **Hetzner CX22** | Shared | 2 | 4 GB | 40 GB | 20 TB | **~$4.50** (€3.79 + IPv4) |
| **Hetzner CX32** | Shared | 4 | 8 GB | 80 GB | 20 TB | **~$7.80** (€6.80 + IPv4) |
| **DigitalOcean Basic** | Shared | 1 vCPU | 1 GB | 25 GB | 1 TB | **$6.00** |
| **DigitalOcean Basic** | Shared | 1 vCPU | 2 GB | 50 GB | 2 TB | **$12.00** |
| **Fly.io shared-cpu-1x** | Shared | 1 | 1 GB | rootfs only | Egress charged separately | **$5.70** |
| **Fly.io shared-cpu-2x** | Shared | 2 | 2 GB | rootfs only | Egress charged separately | **$11.39** |
| **Railway Hobby** | Usage-based | Up to 48 vCPU | Up to 48 GB | 5 GB vol | $0.05/GB egress | **$5 min** (credits) |
| **Railway Pro** | Usage-based | Up to 1000 vCPU | Up to 1 TB | 1 TB vol | $0.05/GB egress | **$20 min** (credits) |

**For a thin metadata server (Mux scenario):** Hetzner CX22 at ~$4.50/mo is more than sufficient. A Node.js/Go server handling metadata, serving HTML pages, and proxying the occasional R2 upload needs minimal resources.

**For a processing server (self-hosted scenario):** FFmpeg transcoding is CPU-intensive. A 3-minute 1080p video takes roughly 30-60 seconds to transcode to each rendition on a 2-vCPU shared server. With 75 videos/month (about 2.5/day), the transcoding workload is modest. Hetzner CX22 (2 vCPU, 4 GB RAM) at ~$4.50/mo would handle this with some headroom. CX32 (4 vCPU, 8 GB) at ~$7.80/mo provides comfortable margin for growth.

**Winner: Hetzner CX22 (~$4.50/mo).** Best value by a wide margin. DigitalOcean and Fly.io are more expensive for comparable specs. Railway's usage-based model is interesting but less predictable for an always-on server.

**Note on Fly.io:** Fly.io's per-second billing and auto-stop capability could save money if the server is truly idle most of the time. But for our use case (always-on for instant video page serving), a traditional VPS is simpler and cheaper.

---

### Managed Video Services

#### Mux

**Plan: Launch pre-pay ($20/mo for $100 credit)**

Detailed cost calculation at our volumes using Basic quality, 1080p:

| Component | Usage at 12 months | Unit price | Monthly cost |
|---|---|---|---|
| **Encoding** | 225 min new/mo | FREE (Basic) | $0.00 |
| **Storage** | 2,700 min stored | $0.003/min/mo | $8.10 gross |
| **Storage (with cold)** | ~70% cold (60% off) after 12mo | discount | ~$3.50 effective |
| **Delivery** | 2,250 min/mo | First 100K free | $0.00 |
| **Total actual usage** | | | **~$3.50/mo** |

The Launch plan costs $20/mo and gives $100/mo in credit. Our actual usage (~$3.50/mo) is well within the credit. We are paying $20/mo for what would cost ~$3.50 on pay-as-you-go ($20/mo credit there too).

**Custom domains:** $100/mo as an add-on (or included with annual contract). The Mux pricing page briefly listed $200/mo for this feature in some contexts, but the docs confirm $100/mo for non-contract customers. Either way, disproportionate for a personal project.

**What the $20/mo Launch plan buys in practice:**
- $100 in monthly credit (we use ~$3.50)
- The unused credit does not roll over
- In effect, we are paying $20/mo for zero operational burden on video encoding, storage, and CDN delivery
- Even at 3x volume (225 videos/mo), usage would be ~$10/mo, still within the $100 credit

#### Bunny Stream

| Component | Usage at 12 months | Unit price | Monthly cost |
|---|---|---|---|
| **Storage** | ~102 GB (source + renditions) | $0.01/GB | $1.02 |
| **CDN delivery** | ~85 GB/mo | $0.01/GB (EU+NA) | $0.85 |
| **Transcoding** | 225 min/mo | FREE (standard) | $0.00 |
| **Total** | | | **~$1.87/mo** |

Bunny Stream's standard transcoding is included free. Premium transcoding ($0.025-$0.15/min depending on resolution) exists for faster processing but is not required.

**Custom domains:** Included at no extra cost.
**oEmbed:** Native endpoint included.
**RTMP live ingest:** Supported, recordings auto-save as VOD.

#### Cost Comparison: Mux vs Bunny Stream

| | Mux (Launch) | Bunny Stream |
|---|---|---|
| **Monthly cost** | $20.00 fixed | ~$1.87 variable |
| **Annual cost** | $240 | ~$22 |
| **Custom domain** | +$100/mo or annual contract | Included |
| **Dev effort** | Low (best-in-class API) | Low (good API) |
| **RTMP-to-VOD quality** | Excellent (well-documented) | Good (less documented) |
| **JIT encoding** | Yes (instant playback) | No (standard transcode delay) |
| **Cold storage** | Auto 40-60% discount | No |
| **oEmbed** | Build your own | Native |

---

### Domain & SSL Costs

| Item | Cost | Notes |
|---|---|---|
| **Domain (v.danny.is)** | Already owned | Assumed $0 incremental |
| **SSL certificate** | $0 | Let's Encrypt (auto-renew) |
| **Cloudflare DNS** | $0 | Free plan |

---

## Cost Scenarios

### Scenario A: Mux + Thin Server + R2 Backup

The recommended architecture from `04-video-hosting-build-vs-buy.md`. Desktop app pushes RTMP to Mux. Server manages metadata and serves video pages. R2 stores backup copies of source files.

| Component | Provider | Monthly cost |
|---|---|---|
| Video hosting/encoding/CDN | Mux Launch plan | $20.00 |
| Metadata server | Hetzner CX22 | $4.50 |
| Source file backup | Cloudflare R2 | $0.49 (month 1) to $1.89 (month 12) |
| Domain/SSL/DNS | Cloudflare | $0.00 |
| **Total (month 1)** | | **~$25** |
| **Total (month 12)** | | **~$26** |
| **Total (month 36)** | | **~$30** |

**Growth scaling:** The main cost ($20/mo Mux) is fixed until usage exceeds $100/mo in credit (which would require ~28x our volume -- about 2,100 videos/month). R2 backup grows slowly. The Hetzner VPS is fixed.

**Pros:** Zero encoding pipeline to build. Instant playback via RTMP. Best API. Focus on desktop app development.
**Cons:** $20/mo floor regardless of usage. Custom stream domain adds $100/mo. ~$25/mo exceeds the $5-10/mo target.

### Scenario B: Fully Self-Hosted (FFmpeg + R2 + Cloudflare CDN)

Desktop app uploads HLS segments directly to R2 during recording. Server runs FFmpeg to generate multi-bitrate renditions in the background. Cloudflare CDN serves everything with zero egress.

| Component | Provider | Monthly cost |
|---|---|---|
| Storage (source + renditions) | Cloudflare R2 | $0.62 (month 1) to $3.42 (month 12) |
| CDN delivery | Cloudflare (via R2) | $0.00 |
| Server (web + FFmpeg) | Hetzner CX22 | $4.50 |
| Domain/SSL/DNS | Cloudflare | $0.00 |
| **Total (month 1)** | | **~$5.12** |
| **Total (month 6)** | | **~$6.39** |
| **Total (month 12)** | | **~$7.92** |
| **Total (month 36)** | | **~$14.04** |

Detailed R2 cost by timeframe (including 34 GB one-time import, minus 10 GB free tier):

| Timeframe | Stored (source + renditions + import) | R2 cost |
|---|---|---|
| Month 1 | 17 + 34 = 51 GB | $0.62 |
| Month 6 | 102 + 34 = 136 GB | $1.89 |
| Month 12 | 204 + 34 = 238 GB | $3.42 |
| Month 36 | 612 + 34 = 646 GB | $9.54 |

**Growth scaling:** Storage is the main growth driver. At 36 months, R2 reaches ~$9.54/mo. Adding a storage tiering strategy (deleting renditions for old unwatched videos, keeping only source files) would reduce this significantly.

**With storage tiering (delete renditions after 6 months unwatched):** Keeps ~150 GB of renditions + all source files. At 36 months: ~456 GB, R2 cost: ~$6.69/mo, total: ~$11.19/mo.

**Pros:** Cheapest viable approach. Full domain control. Zero vendor dependency. Meets $5-10/mo target for the first year.
**Cons:** Must build entire encoding pipeline (FFmpeg job queue, error handling, rendition management). More complex desktop app code for HLS segment upload. Initial playback is single-quality until processing completes. Operational burden.

### Scenario C: Bunny Stream + Thin Server + R2 Backup

A managed service compromise. Bunny Stream handles encoding, storage, and CDN delivery with custom domains. R2 stores backup copies.

| Component | Provider | Monthly cost |
|---|---|---|
| Video hosting/encoding/CDN | Bunny Stream | ~$1.30 (month 1) to ~$2.90 (month 12) |
| Metadata server | Hetzner CX22 | $4.50 |
| Source file backup | Cloudflare R2 | $0.49 (month 1) to $1.89 (month 12) |
| Domain/SSL/DNS | Cloudflare | $0.00 |
| **Total (month 1)** | | **~$6** |
| **Total (month 12)** | | **~$9** |
| **Total (month 36)** | | **~$16** |

**Growth scaling:** Both Bunny Stream and R2 costs grow linearly with storage. At 36 months: Bunny ~$7/mo + R2 ~$5/mo + VPS $4.50 = ~$16/mo.

**Pros:** Custom domain included. Native oEmbed. Cheapest managed option. No encoding pipeline to build.
**Cons:** Less polished API than Mux. RTMP-to-VOD flow less documented. Standard transcoding is slower (not JIT). Smaller company/higher vendor risk. Still depends on Bunny being reliable.

### Scenario D: Self-Hosted, No VPS (Process on Mac)

The absolute cheapest option. Process videos locally on the Mac after recording, upload HLS renditions directly to R2. No server at all for processing. Use a minimal server (or serverless function) just for the video page and API.

| Component | Provider | Monthly cost |
|---|---|---|
| Storage (source + renditions) | Cloudflare R2 | Same as Scenario B |
| CDN delivery | Cloudflare (via R2) | $0.00 |
| Video pages / API | Cloudflare Workers (free tier) | $0.00 |
| Domain/SSL/DNS | Cloudflare | $0.00 |
| **Total (month 1)** | | **~$0.62** |
| **Total (month 12)** | | **~$3.42** |
| **Total (month 36)** | | **~$9.54** |

**The catch:** This requires the desktop app to handle FFmpeg transcoding locally, and a Cloudflare Worker to serve video pages. Workers free tier allows 100K requests/day -- more than sufficient. But it pushes significant complexity into the desktop app and the Workers code. Transcoding on the Mac also means the multi-bitrate renditions are not available until local processing completes, which could take minutes for a 3-minute video.

**Pros:** Under $1/mo for the first year. Under $5/mo for the first two years.
**Cons:** No always-on server. Complex desktop app. Workers has limitations (execution time, KV storage). Admin interface would need to be serverless too. Not a practical primary approach, but interesting as a cost floor reference.

---

## Comparison Table

| | Scenario A (Mux) | Scenario B (Self-hosted) | Scenario C (Bunny) | Scenario D (No VPS) |
|---|---|---|---|---|
| **Month 1** | ~$25 | ~$5 | ~$6 | ~$1 |
| **Month 6** | ~$26 | ~$6 | ~$8 | ~$2 |
| **Month 12** | ~$26 | ~$8 | ~$9 | ~$3 |
| **Month 36** | ~$30 | ~$14 | ~$16 | ~$10 |
| **Year 1 total** | ~$306 | ~$78 | ~$96 | ~$24 |
| **Year 3 total** | ~$960 | ~$300 | ~$384 | ~$132 |
| **Dev effort** | Low | High | Low-Medium | Very High |
| **Custom domain (stream)** | No (+$100/mo) | Yes | Yes | Yes |
| **Custom domain (page)** | Yes | Yes | Yes | Yes |
| **Instant playback** | Yes (RTMP + JIT) | Yes (segments, single quality) | Yes (RTMP) | Yes (segments, single quality) |
| **ABR quality** | Automatic | DIY (FFmpeg) | Automatic | DIY (FFmpeg, local) |
| **Operational burden** | None | Moderate | None | Low (but complex app) |
| **Meets $5-10/mo target?** | No ($25/mo) | Yes (first 12 months) | Yes (first 12 months) | Yes (first 30+ months) |

---

## The $5-10/mo Target: Reality Check

The requirements specify a target of under $5-10/month. Here is what is achievable:

**$5-10/mo is realistic for:** Self-hosted with R2 (Scenario B) for the first 12 months, Bunny Stream (Scenario C) for the first 12 months, and the no-VPS approach (Scenario D) for 2+ years.

**$5-10/mo is not realistic for:** Mux (Scenario A) at $25/mo, or any approach that includes Mux's custom domain ($100/mo).

**The realistic floor is ~$5/mo** (Scenario B: Hetzner CX22 + R2, first few months). This requires building the entire encoding pipeline, which represents significant development time.

**The realistic floor for a managed approach is ~$6/mo** (Scenario C: Bunny Stream + Hetzner CX22 + R2 backup). This avoids building an encoding pipeline while staying near the budget target.

**The $20/mo Mux floor is defensible** when you factor in development time: the encoding pipeline you would otherwise need to build yourself is worth many hours of work. At a personal project scale, the $15/mo premium over self-hosted buys back significant development time to focus on the desktop app, which is where the actual novelty lies.

### Cost Levers

If costs need to come down:

1. **Drop VPS for Cloudflare Workers** (save $4.50/mo): Serve video pages and API from Workers. Feasible but adds complexity.
2. **Use B2 instead of R2 for backup** (save ~$0.50/mo at 12mo): Marginal savings, not worth the added complexity.
3. **Delete renditions for old unwatched videos** (save 30-40% on storage at 36mo): Keep source files only, re-transcode on demand if needed.
4. **Reduce rendition count** (save ~30% on storage): Generate only 720p + 1080p instead of 480p + 720p + 1080p. Most viewers are on broadband.
5. **Use Mux pay-as-you-go instead of Launch** (save $17/mo): Pay-as-you-go has a $20/mo credit too. Actual usage of ~$3.50/mo means you spend $20/mo either way. No savings here.
6. **Use Mux Free tier** (save $20/mo): Limited to 10 stored videos. Not viable for our volume.

---

## Hidden Costs and Gotchas

### Cloudflare R2
- **Class A operations (writes):** $4.50 per million. During recording, each 4-second segment is one PUT. A 3-min recording = 45 PUT operations. At 75 videos/month = 3,375 PUTs. Plus rendition uploads (~135 PUTs per video x 3 renditions = ~30,375). Total: ~34K PUTs/month, well within the 1 million free tier. Not a concern.
- **Class B operations (reads):** $0.36 per million. At ~37,500 reads/month for delivery, well within the 10 million free tier. Not a concern.
- **Operations only become costly at very high scale** (millions of views/month).

### Mux
- **Credit does not roll over.** Paying $20/mo for $100 credit when using $3.50 means $96.50 is wasted monthly.
- **Custom domain is $100/mo** (or included in annual contract, but annual pricing is not publicly listed).
- **Pay-as-you-go also has a $20/mo credit**, making it equivalent to Launch for our low usage. The Launch plan's 5x multiplier ($20 for $100) only helps if you exceed $20/mo in actual usage.
- **Live streaming latency modes:** Standard (30s), reduced (10-15s), low (5s). For our use case, standard is fine, but worth knowing the options.

### Bunny Stream
- **$1/mo minimum billing** regardless of usage.
- **Premium transcoding costs extra** ($0.025-$0.15/min). Standard transcoding is free but slower.
- **RTMP live ingest documentation is sparse** compared to Mux.

### Hetzner
- **IPv4 address costs extra:** €0.50/mo (~$0.60). Included in the prices above.
- **Shared vCPU means variable performance.** FFmpeg transcoding might be slower during peak hours. Not a problem at our volume (transcoding 2-3 videos/day is light work).
- **20 TB traffic included** is far more than we need (we deliver ~85 GB/month via R2, not via the VPS).

### AWS (if considered)
- **S3 egress is expensive:** $0.09/GB. At 85 GB/month delivery = $7.65/mo just for bandwidth.
- **CloudFront free plan (new in 2025-2026):** 100 GB/mo data transfer, 1M requests, includes WAF, DDoS protection, and 5 GB S3 Standard storage credits. This could work for our delivery volumes, but locks you into the AWS ecosystem.
- **MediaConvert is expensive at scale:** $0.015/min per rendition. 3 renditions x 225 min = $10/mo just for transcoding. Not competitive.

### General
- **No minimum commitments** for R2, B2, Bunny, Hetzner, or Fly.io. All are pay-as-you-go.
- **Mux Launch plan is a monthly commitment** ($20/mo) but can be cancelled anytime.
- **Domain costs are sunk** (already own v.danny.is).

---

## Recommendation

### Start with Scenario A (Mux) at $25/mo, with a clear path to Scenario B or C

The reasoning from `04-video-hosting-build-vs-buy.md` still holds: $20/mo for Mux buys back enormous development time. The RTMP ingest path is simpler to build in the desktop app than client-side HLS segmentation. JIT encoding means instant playback. The entire encoding pipeline disappears from scope.

**The $25/mo total ($20 Mux + $4.50 Hetzner + $0.55 R2) exceeds the $5-10/mo target, but it is the right tradeoff for a first version** where development time on the desktop app matters more than optimizing hosting costs.

### Migration Paths

**If $25/mo feels too expensive after launch:**

1. **Move to Scenario C (Bunny Stream):** ~$7/mo. Swap Mux for Bunny. RTMP ingest works the same way. Player switches from mux-player to Vidstack. Custom domain is free. Migration effort: moderate (update API integration, switch RTMP endpoint, update player).

2. **Move to Scenario B (Self-hosted):** ~$7/mo. Build the FFmpeg pipeline. Switch desktop app from RTMP push to HLS segment upload. All source files are already in R2 as backups. Migration effort: significant (build encoding pipeline, change desktop upload logic).

**The R2 backup in all scenarios is the insurance policy.** Every recording is backed up to R2 regardless of which managed service handles delivery. This means migration away from any service is a batch processing job, never a crisis.

### The Budget-Optimal Path (if cost is king from day one)

If the $5-10/mo target is a hard constraint rather than a goal:

1. **Start with Scenario C (Bunny Stream + Hetzner + R2)** at ~$6/mo
2. Accept slightly worse developer experience and documentation compared to Mux
3. Accept slower transcoding (not JIT) and less polished RTMP-to-VOD flow
4. Save $18-19/mo compared to the Mux approach

This is a viable path. Bunny Stream is a real, functional product. The cost savings are meaningful over a year (~$96 vs ~$306).

---

## Sources

- Cloudflare R2 pricing: https://developers.cloudflare.com/r2/pricing/
- Backblaze B2 pricing: https://www.backblaze.com/cloud-storage/pricing
- Hetzner Object Storage: https://www.hetzner.com/storage/object-storage
- Hetzner Cloud: https://www.hetzner.com/cloud/
- Mux pricing: https://www.mux.com/pricing/video and https://www.mux.com/docs/pricing/video
- Mux custom domains: https://www.mux.com/docs/guides/use-a-custom-domain-for-streaming
- Bunny CDN/Stream pricing: https://bunny.net/pricing/ and https://bunny.net/stream/
- AWS S3 pricing: https://aws.amazon.com/s3/pricing/
- AWS CloudFront pricing: https://aws.amazon.com/cloudfront/pricing/
- DigitalOcean Droplets: https://www.digitalocean.com/pricing/droplets
- Fly.io pricing: https://fly.io/docs/about/pricing/
- Railway pricing: https://railway.com/pricing
- R2 video hosting case study: https://screencasting.com/cheap-video-hosting
