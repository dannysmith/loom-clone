# Research: Storage, CDN & Infrastructure Cost Modelling

## Priority

Tier 2 — Informed by Task 04 (Build vs Buy), but can be researched in parallel. The cost target in the requirements is $5-10/month. We need to verify this is realistic and understand the cost structure of different approaches.

## Context

The requirements specify ~75 videos/month at ~3 minutes average, with modest viewership (most videos get 1-2 views, some get 30-100/day, occasional spikes to a few thousand). Infrastructure costs should be under $5-10/month. Read `requirements.md` for full project context, particularly the "Constraints" section.

We need concrete numbers, not hand-waving. This task should produce actual cost estimates for different architectural approaches.

## Key Questions

### Storage Options

- **Cloudflare R2** — S3-compatible, zero egress fees, pay only for storage and operations. What does it cost at our volumes?
- **Backblaze B2** — Cheap storage, free egress to Cloudflare via Bandwidth Alliance. Pricing?
- **AWS S3** — The standard. What's the realistic cost including egress? (Standard vs Infrequent Access vs Glacier for archival.)
- **Hetzner Object Storage** — European, very cheap. Viable?
- How much storage do we actually need? Estimate: 75 videos/month × 3 min × (source size + HLS renditions). What's the per-video storage footprint?
- How does storage grow over time? After 6 months? A year? 3 years?
- Do we need a tiering strategy? (Hot storage for recent/popular videos, cold for old/rarely-viewed?)

### CDN Options

- **Cloudflare** — Free tier is generous. What are the limitations for video? Do they throttle large file delivery on the free plan?
- **Bunny CDN** — Known for video-friendly pricing. Per-GB pricing by region.
- **CloudFront** — AWS's CDN. Pricing at our volumes?
- **Cloudflare R2 + Cloudflare CDN** — The zero-egress combo. Does this actually work well for video delivery?
- What's the bandwidth cost at our expected viewership? Estimate: average video is 3 min, maybe 50-100MB in HLS multi-rendition, average ~200-500 views/month total.

### Server/Compute

- What does a small VPS cost for running the server and processing? (Hetzner, DigitalOcean, Fly.io, Railway?)
- Do we need dedicated compute for video processing, or can it run on the same VPS as the web server?
- If using a managed video service, the server becomes much lighter — what's the cheapest viable option then?

### Cost Modelling

- **Scenario A: Fully self-hosted** — VPS + object storage + CDN + own encoding pipeline. Monthly cost?
- **Scenario B: Managed video service** — Mux/Cloudflare Stream/Bunny Stream for video + minimal VPS for admin. Monthly cost?
- **Scenario C: Hybrid** — Self-hosted processing, managed CDN delivery. Monthly cost?
- How do costs scale? What happens at 2× or 5× the expected volume?
- What's the cost to store the existing video library? (Hundreds of videos to import from Loom/Cap.)

### The $5-10/month Target

- Is this realistic? For which approaches?
- If not, what's the realistic floor for each approach?
- Where are the cost levers? What tradeoffs can reduce costs? (e.g. fewer renditions, aggressive cleanup of old videos, lower CDN tier)

## Research Approach

- Visit pricing pages for each service and calculate actual costs at our volumes.
- Estimate per-video storage sizes based on typical encoding outputs (source file + 3-4 HLS renditions + thumbnails).
- Model bandwidth based on expected viewership patterns.
- Look for blog posts or case studies from people running personal video hosting at similar scale.
- Check for any hidden costs (API request charges, minimum commitments, etc.).

## Expected Output

A research document that:

1. Provides concrete cost estimates for each scenario (self-hosted, managed, hybrid).
2. Breaks down costs by component (storage, CDN/bandwidth, compute, managed service fees).
3. Shows how costs scale with volume (both video count and viewership).
4. Identifies the cheapest viable approach that meets our requirements.
5. Flags any surprises or gotchas in pricing (e.g. Cloudflare's ToS around serving video on free plans).
6. Includes a simple spreadsheet-style breakdown that's easy to compare.

## Related Tasks

- Task 04 (Build vs Buy) — the cost comparison is a major input to the build-vs-buy decision.
- Task 05 (Video Processing & Encoding) — encoding settings affect storage sizes and bandwidth.
- Task 07 (Server & Admin Stack) — compute costs depend on what the server needs to do.
