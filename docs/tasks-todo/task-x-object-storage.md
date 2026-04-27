# Task X: Video Files on Object Storage

Move video files to S3-compatible object storage as a secondary store alongside the Hetzner volume. Motivated by three things: CDN-origin resilience (if Hetzner is down, videos can still be served from object storage through BunnyCDN), off-site backup of video assets on geographically separate infrastructure, and long-term portability (files in a standard S3-compatible store are easy to migrate).

This task is separate from and builds on Task 1 (BunnyCDN edge layer). Task 1 sets up BunnyCDN with Hetzner as origin. This task adds object storage as a secondary origin for video files.

## Background

Primary video storage is the Hetzner volume (bind-mounted at `data/`). Backups go to a Hetzner Storage Box BX11 via restic (see `docs/tasks-done/task-2026-04-26-3-storage-and-backups.md`). The backup task explicitly ruled out object storage for primary storage — that decision stands. Object storage here is a *secondary* store for CDN resilience and geographic separation, not a replacement for the volume.

Per-video file inventory on the volume (post storage-cleanup task):

| File                              | Immutable? | Backed up to Storage Box? |
| --------------------------------- | ---------- | ------------------------- |
| `recording.json`                  | Yes        | Yes                       |
| `derivatives/source.mp4`          | Yes        | Yes                       |
| `derivatives/thumbnail.jpg`       | Yes        | Yes                       |
| `derivatives/720p.mp4`            | Yes        | No (regenerable)          |
| `derivatives/1080p.mp4`           | Yes        | No (regenerable)          |
| `derivatives/storyboard.jpg`      | Yes        | No (regenerable)          |
| `derivatives/storyboard.vtt`      | Yes        | No (regenerable)          |
| `captions.srt` / `captions.vtt`   | No         | No (regenerable)          |

HLS segments (`init.mp4`, `seg_*.m4s`, `stream.m3u8`) are cleaned up 10 days after completion.

## Research Findings (April 2026)

### Cloudflare R2

**Pricing:** $0.015/GB/month storage. 10GB free tier. **Zero egress fees** regardless of who's fetching — including BunnyCDN pulling from R2 as origin. At 50GB stored: ~$0.75/month. At 100GB: ~$1.50/month.

**S3 compatibility:** Works with `@aws-sdk/client-s3` using `forcePathStyle: true` and `region: "auto"`. Multipart uploads supported (up to 5TB per object). Each part counts as a Class A operation — use large part sizes (50-100MB) to conserve the 1M/month free tier.

**Upload from Hetzner:** "R2 Local Uploads" terminates uploads at the nearest Cloudflare PoP (European PoP from Hetzner). 75% p50 latency reduction for cross-region writes. Fast enough for post-derivative uploads.

**Region:** Single-region storage (not edge-distributed). Region is chosen by location hint at bucket creation — EU available. Cold cache misses go to the storage region, but with BunnyCDN caching in front this only matters for the first viewer per edge PoP.

**Access control:** No per-object ACLs. Bucket is either public or private. All fine-grained access control must be in application code (Worker or server). Presigned URLs supported (max 7 days). Encrypted at rest by default.

**Custom domains:** Requires Cloudflare DNS. Not needed here since BunnyCDN would use the S3 API URL as origin.

### Hetzner Object Storage

**Pricing:** €6.49/month flat, includes 1TB storage + 1TB egress. Additional egress €1.00/TB. Same-datacenter uploads from VPS are free (internal network).

**Location:** Available in Falkenstein (same DC as VPS), Helsinki, Nuremberg. Co-location with VPS means fastest possible uploads.

**The problem:** Same datacenter as the VPS. A Falkenstein-wide outage takes down both the VPS and object storage simultaneously. This defeats the geographic separation goal. Egress savings vs R2 are negligible at personal scale with BunnyCDN caching in front.

### Verdict

**R2 is the better choice** for this project's goals. Geographic separation from Hetzner infrastructure is the primary advantage. The cost difference is minimal (~$1-2/month vs €6.49/month flat), and R2's zero egress simplifies cost prediction. Hetzner Object Storage would make sense if the goal were purely "fast local storage tier" rather than "resilient secondary store."

## Open Design Questions

### What gets stored in R2?

All viewer-facing immutable files for completed videos make sense: `source.mp4`, resolution variants, `thumbnail.jpg`, `storyboard.jpg`, `storyboard.vtt`. Captions too (not immutable, but lightweight and worth having off-site).

Open question: should `recording.json` go to R2 as well? It's tiny and irreplaceable. Currently only backed up via restic to the Storage Box.

HLS segments (`init.mp4`, `seg_*.m4s`) probably don't belong in R2 — they're only used during recording and the healing window, then cleaned up. By the time a video is "complete" with derivatives, HLS segments are redundant.

### Bucket structure

**Slug-based** (e.g., `calm-dogs-dream/raw/source.mp4`): Enables BunnyCDN to proxy URL paths directly to R2 as origin (path maps 1:1). Downside: slug renames require copying objects. Upside: simplest CDN integration — BunnyCDN Edge Rule just swaps origin, same path.

**UUID-based** (e.g., `<uuid>/source.mp4` or flat `<uuid>-source.mp4`): Stable, slug-agnostic, no rename problem. Downside: BunnyCDN can't translate slug→UUID at the edge. The Hono server must stay in the request path (BunnyCDN → Hono → R2), which means Hetzner-down breaks cache misses even with R2.

**Trade-off:** UUID-based is better for storage management and portability. Slug-based is better for CDN-origin resilience (BunnyCDN → R2 without Hetzner in the path). The right choice depends on how much we value origin-down resilience vs storage simplicity. Slug renames are rare (admin-initiated), so the rename-copy cost may be acceptable.

### Security model for mixed-visibility content

R2 has no per-object ACLs — the bucket is public or private. Options:

- **Public-only in R2:** Only upload files for public/unlisted videos. Private videos stay on Hetzner volume only. When visibility changes to private → delete from R2 + purge CDN cache. Simple but means private videos can't benefit from R2 backup.
- **Private bucket + gatekeeper:** Keep the bucket private. Access via a Worker or the Hono server that checks visibility before serving. BunnyCDN authenticates to the gatekeeper via a shared secret header. More complex but all videos get R2 backup regardless of visibility.
- **Separate buckets:** One public-origin bucket (for CDN), one private bucket (for backup of all videos). More operational overhead but cleanest separation.

### Sync pipeline

When to upload to R2:
- After derivatives pipeline completes for a new video (source.mp4, variants, thumbnail, storyboard generated)
- After caption upload/change
- After thumbnail admin override

Implementation: a post-derivatives hook using `@aws-sdk/client-s3` + `@aws-sdk/lib-storage` for multipart upload of large files. R2's Local Uploads means Hetzner → nearest European CF PoP → fast.

### Deletion and lifecycle

When a video is trashed:
1. Purge from BunnyCDN cache (immediate — privacy/security critical)
2. Delete from R2 (can be async, but should happen promptly)
3. Video remains in restic backup per existing retention policy

When a video is hard-deleted (if we ever implement that): same as above.

### Relationship to existing backup strategy

R2 complements rather than replaces the Storage Box BX11 backup:
- Storage Box: encrypted restic snapshots with retention policy, point-in-time restore, Hetzner-managed snapshots as safety net. Contains `source.mp4`, `recording.json`, `thumbnail.jpg`, and the DB.
- R2: live secondary store, files individually accessible, serves as CDN origin. Contains all viewer-facing derivatives.

The two serve different purposes. Storage Box is the "disaster recovery" backup. R2 is the "live resilient serving" store.

### Integration with BunnyCDN (Task 1)

Once R2 is populated, BunnyCDN Edge Rules can route video media paths to R2 as origin instead of Hetzner. This is a configuration change in BunnyCDN (Edge Rule: "Change Origin URL" for matching paths → R2 S3 API endpoint). The existing BunnyCDN setup from Task 1 doesn't need to be rebuilt — just augmented with an origin-switching rule.
