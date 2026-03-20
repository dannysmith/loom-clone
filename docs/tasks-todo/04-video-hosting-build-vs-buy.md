# Research: Video Hosting — Self-Hosted vs Managed Services

## Priority

Tier 1 — This is the single most impactful architectural decision for the project. The answer determines the scope and complexity of the entire server and delivery layer.

## Context

Our project needs to encode, store, and serve video via CDN with adaptive bitrate streaming (HLS). We can build this ourselves (FFmpeg + object storage + CDN) or use a managed video hosting service that handles it for us. Read `requirements.md` for full project context, particularly the "Processing & Management Requirements" and "Delivery Requirements" sections.

The key tension: managed services could eliminate a huge amount of complexity (encoding pipeline, CDN configuration, HLS rendition management, player SDKs), but they add cost, dependency, and potentially reduce control. For a personal tool with modest traffic, the tradeoff calculation is different from a commercial product.

## Services to Evaluate

### Primary Candidates

- **Cloudflare Stream** — Video hosting and delivery via Cloudflare's CDN. Pay per minute stored and minute watched. Integrated with Cloudflare's broader ecosystem (Workers, R2, DNS).
- **Mux** — Developer-focused video API. Encoding, hosting, delivery, player SDK, analytics. Used by many startups and products. Pay per minute.
- **Bunny Stream** — Part of Bunny CDN. Video hosting, encoding, and delivery. Known for being cost-effective.
- **api.video** — Video API platform. Encoding, hosting, delivery, player. Has a free tier.

### Secondary Candidates (lighter evaluation)

- **AWS MediaConvert + CloudFront + S3** — The AWS-native approach. Maximum control, significant configuration complexity.
- **Backblaze B2 + Cloudflare CDN** — Often cited as the cheapest storage + delivery combo (B2's Bandwidth Alliance partnership with Cloudflare means zero egress fees). Requires running your own encoding.

### Self-Hosted Approach

- FFmpeg for encoding, S3/R2/B2 for storage, CDN (Cloudflare/Bunny/CloudFront) for delivery. Full control but we build and maintain the entire pipeline.

## Key Questions

### For Each Managed Service

- What does it actually do? (Ingest, encoding, storage, CDN delivery, player, analytics — which of these?)
- What does it cost at our expected volumes? (~75 videos/month, ~3 min average, modest viewership — maybe 200-500 views/month total across all videos, with occasional spikes)
- Can we use our own domain (`v.danny.is`) for delivery?
- Does it support HLS with adaptive bitrate and multiple renditions?
- Can it receive streamed uploads (HLS segments during recording), or does it only accept completed files?
- What's the processing latency? How long from upload to playable?
- Does it provide a player, or do we use our own?
- What's the API like? How much control do we have over encoding settings, thumbnail generation, etc.?
- Does it support custom metadata, webhooks for processing events, etc.?
- Can we export/migrate our videos out if we want to leave?
- What's the reliability and track record?

### For the Self-Hosted Approach

- What's the realistic complexity of building and maintaining an encoding pipeline?
- What would the infrastructure look like? (VPS for processing, object storage, CDN configuration)
- What's the realistic cost at our volumes?
- What's the operational burden? (Monitoring, debugging failed encodes, storage management)

### Comparison Questions

- At our volumes, what's the actual monthly cost difference between managed and self-hosted?
- How much server-side code does a managed service eliminate?
- What control do we give up with a managed service? Does any of it matter for our use case?
- Can we start with a managed service and migrate to self-hosted later if needed? How painful would that be?
- Which approach better supports the "instant URL" requirement? (Some services may not support streaming ingest.)
- Which approach better supports the "videos work when backend is down" requirement?

## Research Approach

- Visit each service's documentation and pricing pages. Calculate actual costs at our expected volumes.
- Look for developer experience reports, blog posts, and comparisons.
- Check if any of these services support receiving HLS segments during recording (streaming ingest) vs only accepting completed files — this is critical for the instant-URL requirement.
- Look at how Cap and similar open-source projects handle this. Do they use managed services or self-host?
- Consider hybrid approaches — e.g. self-host the ingest/processing but use a CDN service for delivery.

## Expected Output

A research document that:

1. Provides a clear comparison matrix of the evaluated services and the self-hosted approach.
2. Includes actual cost estimates at our expected volumes for each option.
3. Evaluates each option against our specific requirements (instant URL, own domain, CDN independence, cost target).
4. Makes a clear recommendation (or narrows to 2-3 viable options) with reasoning.
5. Identifies the tradeoffs honestly — what we gain and what we give up with each approach.
6. Addresses the streaming ingest question specifically — which options support it?
7. Considers the hybrid approach (e.g. managed CDN/delivery, self-hosted processing).

## Related Tasks

- Task 02 (Streaming Upload Architecture) — the upload destination depends on this decision.
- Task 06 (Video Processing & Encoding) — scope depends heavily on whether we self-host.
- Task 07 (Storage, CDN & Cost Modelling) — cost analysis overlaps; this task focuses on the build-vs-buy decision while Task 07 goes deeper on infrastructure specifics.
- Task 08 (Server & Admin Stack) — server complexity depends directly on this decision.
