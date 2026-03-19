# Video Hosting Platform Research for Personal Loom Clone

**Use case**: Single user records videos on macOS, uploads them, needs reliable public URLs with good playback performance, CDN delivery, and embedding/unfurling support. Estimated ~50-100 videos/month, average 3 minutes, with modest viewership (most videos get 1-10 views, some get 50-100).

**Estimated monthly volume for cost calculations:**
- ~75 videos/month x 3 min = ~225 minutes of new video/month
- Cumulative storage grows over time; assume ~1,000 minutes stored after ~4 months
- Delivery: ~75 videos x avg 10 views x 3 min = ~2,250 minutes delivered/month (modest estimate)
- At 1080p, 1 minute of video ~ 38MB (5 Mbps), so 225 min encoded ~ 8.5 GB, 2,250 min delivered ~ 85 GB

---

## 1. Mux (mux.com)

### Pricing Model
Usage-based, billed per minute. Three quality tiers: Basic (free encoding), Plus, and Premium. Resolution-based multipliers.

**Encoding (one-time, per input minute):**
- Basic quality: FREE
- Plus quality @ 1080p: $0.03125/min
- Premium quality @ 1080p: $0.046875/min

**Storage (per minute stored per month):**
- Plus quality @ 1080p: $0.003/min/month
- Premium quality @ 1080p: $0.0045/min/month
- **Automatic Cold Storage**: 40% discount after 30 days unwatched, 60% discount after 90 days. New uploads start in cold storage immediately until first view.

**Delivery (per minute delivered):**
- First 100,000 minutes/month: FREE
- Plus/Basic @ 1080p: $0.001/min after free tier
- Premium @ 1080p: $0.0015/min after free tier

**Plans:**
- Free: 100K delivery min, up to 10 videos stored
- Pay-as-you-go: Usage-based with $20 monthly credit
- Launch pre-pay: $20/mo for $100 in credit (5x multiplier)
- Scale pre-pay: $500/mo for $1,000 in credit (2x multiplier)

### Estimated Monthly Cost (~75 videos, 3 min avg, Basic quality, 1080p)
- Encoding: FREE (Basic quality)
- Storage: 1,000 min x $0.003 = $3.00/mo (less with cold storage -- most videos rarely rewatched, so ~60% discount on older ones; realistically ~$1.50-2.00/mo)
- Delivery: 2,250 min delivered, well under 100K free tier = FREE
- **Total: ~$2-3/mo** (covered by the $20 monthly credit on pay-as-you-go)
- With Launch pre-pay ($20/mo for $100 credit): essentially $20/mo but you'd use only ~$3 of it

### API Quality
Excellent. Mux is developer-focused and widely considered the gold standard for video APIs. Clean REST API, comprehensive SDKs (Node, Python, Go, Ruby, etc.), webhook support, and the `mux-player` web component. Upload via direct upload URLs (tus protocol for resumable uploads). Very well-documented.

### Custom Domains
**Yes.** Mux supports custom domains for both streaming and image delivery. You set up `stream.yourdomain.com` and `image.yourdomain.com` via CNAME records. The `mux-player` web component has a `custom-domain` attribute.

### HLS / Adaptive Bitrate
**Yes, native.** All videos are automatically transcoded into HLS with multiple renditions for adaptive bitrate streaming. This is core to how Mux works. No configuration needed.

### Embedding / Unfurling
- **Mux Player iframe**: `player.mux.com/{playbackId}` -- comes pre-loaded with Open Graph tags and LD-JSON structured data.
- **OG tags**: Built into the iframe embed page, enabling link previews on social platforms.
- **oEmbed**: Not natively provided as a standard oEmbed endpoint, but the iframe page has OG metadata. You would need to build your own oEmbed endpoint if you want full oEmbed support.
- **Mux Player web component**: `<mux-player>` for embedding in your own pages.

### Gotchas / Limitations
- The Launch pre-pay plan ($20/mo) is great value but credits don't roll over.
- Basic quality encoding is free but gives you less control over quality settings.
- No built-in video page / share page -- you need to build your own share page that includes `<mux-player>`.
- oEmbed requires building your own endpoint on top of Mux.

---

## 2. Cloudflare Stream

### Pricing Model
Simple two-dimensional pricing: storage and delivery, both per 1,000 minutes.

- **Storage**: $5 per 1,000 minutes stored (prepaid in $5 increments)
- **Delivery**: $1 per 1,000 minutes delivered (post-paid, usage-based)
- **Encoding/ingress**: FREE
- **Bandwidth/egress**: Included in delivery price (no separate bandwidth fees)

### Estimated Monthly Cost
- Storage: 1,000 min stored / 1,000 x $5 = $5.00/mo
- Delivery: 2,250 min / 1,000 x $1 = $2.25/mo
- **Total: ~$7-8/mo**

Storage is prepaid in $5 increments, so minimum storage cost is $5 for up to 1,000 minutes.

### API Quality
Decent but more basic than Mux. REST API with token-based auth. Supports direct creator uploads (tus resumable uploads). The API is straightforward for upload/manage/play workflows but lacks some of the richer features (analytics, QoE monitoring) that Mux offers. Well-integrated with the broader Cloudflare ecosystem (Workers, Pages, R2).

### Custom Domains
**NO for playback.** This is a significant limitation. Cloudflare Stream serves video from `videodelivery.net` and `customer-{hash}.cloudflarestream.com`. Custom playback domains are NOT supported for VOD content as of early 2026. Custom ingest domains ARE supported for live streaming only. Multiple community requests have been filed for this feature. A Workers-based proxy is a potential workaround but adds complexity.

### HLS / Adaptive Bitrate
**Yes.** Cloudflare Stream automatically transcodes uploads into multiple quality levels with HLS and DASH output. Adaptive bitrate is automatic.

### Embedding / Unfurling
- **Stream Player embed**: `<iframe src="https://customer-{id}.cloudflarestream.com/{videoId}/iframe">` or use the Stream Player SDK.
- **oEmbed**: Supported via third-party services (Embedly, Iframely) but not a native first-party oEmbed endpoint.
- **OG tags**: The iframe embed page at `cloudflarestream.com` includes basic metadata, but since you can't use a custom domain, unfurling will show the Cloudflare domain.
- You can build your own share page with OG tags that embeds the Cloudflare player.

### Gotchas / Limitations
- **No custom domain for playback** -- a deal-breaker if you want branded share URLs.
- Storage is prepaid in $5 increments (minimum $5 even for a few videos).
- Less sophisticated analytics compared to Mux.
- Player customization is more limited.
- The `videodelivery.net` domain is blocked by some corporate networks.

---

## 3. Bunny Stream (bunny.net)

### Pricing Model
Pay-as-you-go based on storage (per GB) and bandwidth (per GB). All features included -- no separate transcoding, player, or security fees.

- **Storage**: $0.01/GB/month (Europe - Frankfurt primary). Geo-replication adds $0.01/GB for second region, $0.005/GB for additional.
- **Bandwidth (CDN delivery)**: $0.01/GB (Europe & North America), $0.03/GB (Asia & Oceania), $0.045/GB (South America), $0.06/GB (Middle East & Africa). Volume discounts start at $0.005/GB for 0-500TB.
- **Transcoding**: Premium transcoding from $0.025/min (lower resolutions) to $0.15/min (4K/2K). Standard transcoding details less clear from docs.
- **Transcription**: $0.10/minute per language.

### Estimated Monthly Cost
- Storage: 225 min/month x ~38MB/min = ~8.5 GB new/month; ~34 GB after 4 months. $0.34/mo
- Bandwidth: 2,250 min x 38MB = ~85 GB. At $0.01/GB = $0.85/mo
- Transcoding: 225 min x ~$0.025/min = ~$5.63/mo (this is the biggest cost)
- **Total: ~$5-7/mo** (transcoding dominates)

Without premium transcoding (if standard transcoding is included free or cheaper), this could be as low as ~$1-2/mo for just storage + bandwidth.

### API Quality
Good and improving. REST API for video management, upload, and library operations. Supports direct upload and tus resumable uploads. The API is less polished than Mux but fully functional. Dashboard is user-friendly. Player.js support for programmatic player control.

### Custom Domains
**Yes.** Bunny Stream supports custom CDN hostnames. You can serve the player and video content from your own domain via the Bunny dashboard (Delivery > Stream > API settings).

### HLS / Adaptive Bitrate
**Yes.** Bunny Stream automatically transcodes into multiple quality levels for adaptive bitrate streaming via HLS.

### Embedding / Unfurling
- **Embed iframe**: `<iframe src="https://iframe.mediadelivery.net/embed/{libraryId}/{videoId}">` (or via custom hostname).
- **oEmbed**: Bunny has a native oEmbed endpoint at `https://video.bunnycdn.com/OEmbed`. Accepts `url`, `maxWidth`, `maxHeight`, `token`, and `expires` parameters.
- **Iframely**: Also supported via Iframely for broader embedding compatibility.
- Player is highly customizable (colors, language, controls).

### Gotchas / Limitations
- Transcoding costs can add up and are less transparent than Mux/Cloudflare's per-minute model.
- Documentation quality is below Mux's level (though improving).
- Smaller company / less ecosystem compared to Cloudflare or AWS.
- The oEmbed endpoint exists but its behavior with Slack/Discord/Notion hasn't been widely documented.

---

## 4. AWS Stack (S3 + CloudFront + MediaConvert)

### What's Involved
This is a DIY approach. You would need to:
1. Upload source video to S3
2. Trigger MediaConvert to transcode into HLS (multiple bitrate renditions)
3. Store transcoded outputs back to S3
4. Serve via CloudFront CDN
5. Build your own player page, embed logic, OG tags, oEmbed endpoint -- everything

### Pricing Components

**S3 Storage**: $0.023/GB/month (Standard), $0.0125/GB (Infrequent Access)
- 34 GB stored (after 4 months, source + transcoded) ~ $0.78/mo

**MediaConvert (Basic tier, AVC/H.264, HD 1080p)**:
- $0.015/min for HD (720p-1080p) output
- For 3 HLS renditions (1080p, 720p, 480p) per video: each rendition is billed separately
- 225 min input x 3 renditions = 675 output minutes
- 675 min x $0.015 = ~$10.13/mo

**CloudFront**:
- $0.085/GB for first 10TB (North America/Europe)
- 85 GB delivered = ~$7.23/mo
- First 1TB/month is free tier eligible (new accounts for 12 months)

**S3 Data Transfer**: Free to CloudFront from same region.

### Estimated Monthly Cost
- S3 storage: ~$0.80/mo
- MediaConvert: ~$10/mo
- CloudFront: ~$7/mo (or ~$0 if within free tier)
- **Total: ~$11-18/mo** (plus significant development time)

### API Quality
AWS APIs are comprehensive but complex. You're stitching together 3+ services with different APIs, IAM policies, and billing models. SDKs available for all languages. MediaConvert is configured via JSON job templates. Event-driven pipeline typically requires Lambda + EventBridge/SNS.

### Custom Domains
**Yes.** CloudFront supports custom domains via CNAME + ACM certificate. Full control over the domain.

### HLS / Adaptive Bitrate
**Yes**, but you configure it yourself. MediaConvert outputs HLS manifests with the renditions you specify. You choose the bitrate ladder.

### Embedding / Unfurling
**Entirely DIY.** You build everything: the player page (using hls.js or Video.js), OG meta tags, oEmbed endpoint, share URLs, etc. Full control but full responsibility.

### Gotchas / Limitations
- **Significant development and maintenance overhead.** You're building and operating a video platform, not using one.
- MediaConvert pricing with multiple renditions adds up quickly.
- No built-in player, analytics, or embed functionality.
- Error handling, retry logic, pipeline monitoring all on you.
- Transcoding pipeline takes time to build right (Lambda triggers, status tracking, error handling).
- **Not recommended unless you have specific requirements that managed platforms can't meet.**

---

## 5. Backblaze B2 + Cloudflare (Bandwidth Alliance)

### How It Works
Backblaze B2 is cheap object storage. Cloudflare is a CDN. Through the Bandwidth Alliance, egress from B2 to Cloudflare is **free** (normally B2 charges $0.01/GB for egress, but it's waived for Bandwidth Alliance partners). You store files in B2, put Cloudflare CDN in front, and pay only for B2 storage.

### Pricing
- **B2 Storage**: $0.006/GB/month ($6/TB). First 10GB free.
- **B2 Egress to Cloudflare**: FREE (Bandwidth Alliance)
- **B2 API calls**: Class B (downloads): first 2,500 free/day, then $0.004 per 10,000. Class C (uploads): first 2,500 free/day, then $0.004 per 1,000.

### Estimated Monthly Cost
- Storage: 34 GB x $0.006 = $0.20/mo
- Egress: FREE via Cloudflare
- **Total: ~$0.20/mo** (essentially free)

### The Catch: No Transcoding, No Player, No HLS
This gives you cheap static file hosting with a CDN. You get:
- Raw MP4 file delivery
- No transcoding / no adaptive bitrate
- No HLS streaming (unless you transcode locally before upload)
- No player (use your own)
- No embed page (build your own)
- No oEmbed (build your own)

### What You'd Need to Build
1. **Local transcoding**: Use FFmpeg on macOS to transcode to HLS before upload, or just upload a single well-encoded MP4.
2. **Upload pipeline**: B2 CLI or API to upload files.
3. **Player page**: Build a web page with hls.js or just an HTML5 `<video>` tag for MP4.
4. **Custom domain**: Configure via Cloudflare DNS (CNAME to B2 bucket).
5. **OG tags / oEmbed**: Build your own share page and oEmbed endpoint.

### A Practical Middle Ground: Upload Single MP4
Instead of HLS, you could encode a single high-quality MP4 locally (e.g., 1080p H.264, 3-5 Mbps) and serve it directly. Modern browsers handle progressive MP4 download well, and for 3-minute videos with low viewership, adaptive bitrate is arguably unnecessary. This dramatically simplifies the pipeline.

### Gotchas / Limitations
- **Maximum DIY effort.** You're building everything from scratch.
- No adaptive bitrate unless you pre-generate HLS segments locally.
- Single MP4 means viewers on slow connections get a subpar experience (but for short 3-min videos with few viewers, this may be acceptable).
- B2 is not designed as a video platform -- no video-specific features.
- Cloudflare's free plan has a theoretical limit on serving "non-HTML" content from Workers/Pages, though B2-backed content served through Cloudflare CDN is generally fine in practice.

---

## 6. Other Notable Options

### api.video
- **Pricing**: Pay-as-you-go: encoding FREE, storage $0.00285/min, delivery $0.0017/min. Free sandbox tier with 30-second watermarked videos.
- **Estimated cost**: Storage 1,000 min x $0.00285 = $2.85/mo. Delivery 2,250 min x $0.0017 = $3.83/mo. **Total: ~$6-7/mo.**
- **API**: Clean REST API, good documentation, SDKs for major languages.
- **Custom domains**: Not well-documented; appears limited.
- **HLS/ABR**: Yes, automatic.
- **Embedding**: Provides embed codes and a player. oEmbed support unclear.
- **Notable**: AI transcription and summarization included. Good middle-ground between Mux's polish and Cloudflare's simplicity. Less mature ecosystem than Mux.

### Vimeo (Developer API)
- **Pricing**: Starter $12/mo (100GB lifetime storage cap), Standard $25/mo (2TB cap), Advanced $75/mo (7TB cap). API access at all tiers.
- **Estimated cost**: Starter plan at $12/mo would cover the use case for a while, but lifetime storage caps are concerning for long-term use. 75 videos x 3 min at ~38MB/min = ~8.5GB/mo; the 100GB Starter cap lasts ~12 months.
- **API**: Full REST API for programmatic upload, management, and analytics. Mature and well-documented.
- **Custom domains**: No (videos are on vimeo.com or player.vimeo.com).
- **HLS/ABR**: Yes, automatic.
- **Embedding**: Excellent. Vimeo has native oEmbed support, is on Slack's whitelist for inline video playback, embeds natively in Notion, and unfurls nicely everywhere. This is Vimeo's biggest advantage.
- **Gotchas**: Lifetime storage caps are a real constraint. Vimeo branding on free/low tiers. The platform is oriented toward creators/marketers, not developers building tools. API rate limits can be restrictive.

### Gumlet
- **Pricing**: Free tier with 100 storage minutes and 250GB bandwidth/month. Creator plan at $10/mo with 4,000 storage minutes.
- **Estimated cost**: Free tier might work initially; Creator plan at $10/mo for growth.
- **API**: REST API, decent documentation. Dashboard with video CMS.
- **Custom domains**: Yes, supported.
- **HLS/ABR**: Yes, up to 4K HDR10.
- **Notable**: Multi-CDN delivery, DRM support, simpler pricing than Mux. Less well-known but growing.

---

## oEmbed, Unfurling, and Platform Behavior

### How oEmbed Works

oEmbed is a protocol that lets a **consumer** (Slack, Notion, WordPress, etc.) fetch an embeddable representation of a URL from a **provider** (your video service).

**The flow:**

1. **Discovery**: The consumer fetches your video page URL and looks for a `<link>` tag in the HTML `<head>`:
   ```html
   <link rel="alternate" type="application/json+oembed"
         href="https://yourdomain.com/oembed?url=https://yourdomain.com/v/abc123" />
   ```

2. **Request**: The consumer makes a GET request to your oEmbed endpoint:
   ```
   GET https://yourdomain.com/oembed?url=https://yourdomain.com/v/abc123&maxwidth=600
   ```

3. **Response**: Your endpoint returns JSON describing how to embed the content:
   ```json
   {
     "version": "1.0",
     "type": "video",
     "title": "My Screen Recording",
     "author_name": "Danny",
     "provider_name": "MyLoom",
     "provider_url": "https://yourdomain.com",
     "thumbnail_url": "https://yourdomain.com/thumb/abc123.jpg",
     "thumbnail_width": 1280,
     "thumbnail_height": 720,
     "html": "<iframe src=\"https://yourdomain.com/embed/abc123\" width=\"640\" height=\"360\" frameborder=\"0\" allowfullscreen></iframe>",
     "width": 640,
     "height": 360
   }
   ```

4. **Rendering**: The consumer either renders the iframe HTML directly, or uses the thumbnail + metadata for a preview card.

**Provider Registry**: There are 369+ registered providers at oembed.com/providers.json. Getting listed here improves discovery, but most consumers also support the `<link>` tag discovery method.

### How Slack Decides What to Show

Slack's unfurling pipeline works in this priority order:

1. **oEmbed**: Slack checks if the domain has an oEmbed endpoint (via `<link>` tag discovery or a known provider). If found, it uses the oEmbed response.
2. **Twitter Cards meta tags**: `twitter:card`, `twitter:title`, `twitter:description`, `twitter:image`, etc.
3. **Open Graph tags**: `og:title`, `og:description`, `og:image`, `og:video`, etc.
4. **HTML `<meta>` tags**: `<meta name="description">`, `<title>`, etc.

**Critical detail about video in Slack**: Slack only renders inline video players for a **whitelist of approved services**. Currently this includes YouTube, Vimeo, and a small number of other major platforms (the approval process is restrictive and primarily limited to "mass-adopted services"). For non-whitelisted domains:

- Slack will show a **rich link preview** (thumbnail image + title + description) using your OG tags or oEmbed metadata.
- It will NOT show an inline video player, even if your oEmbed response includes `type: "video"` with an iframe HTML snippet.
- Users can click the link to open in browser, but there's no in-Slack playback.

**Workaround for Slack**: Build a Slack app that listens to `link_shared` events on your domain and uses the `chat.unfurl` API to post a custom unfurl with a [Video Block](https://docs.slack.dev/reference/block-kit/blocks/video-block/), which CAN render video inline. This requires a Slack app with the right scopes and domain registrations (up to 5 domains). The `video_url` must point to an embeddable iframe on your registered domain.

### How Discord Handles Video Links

Discord uses Open Graph tags, NOT oEmbed. For video embeds specifically:

- Discord requires `og:video` (or `og:video:url`) pointing to a **direct MP4/WebM/MOV file URL**.
- The file should be under ~20MB for reliable inline playback (some reports suggest up to 50MB works).
- Required OG tags: `og:type` (video.other), `og:video:url`, `og:video:type` (video/mp4), `og:video:width`, `og:video:height`, `og:image` (thumbnail), `og:title`, `og:description`.
- Discord does NOT embed iframes from arbitrary domains. It has an internal whitelist for iframe embeds (YouTube, Twitch, etc.).
- For non-whitelisted domains, you can get a thumbnail + link preview, OR if your `og:video:url` points to a direct MP4, Discord will try to embed it as an inline video player.

**Practical implication**: To get inline video playback in Discord from your own domain, you either need to serve a direct MP4 URL in `og:video:url` (not HLS, not an iframe) or be on Discord's whitelist (effectively impossible for a personal tool).

### How Notion Handles Video Links

Notion uses [Iframely](https://iframely.com/) to power its embed functionality, which supports over 1,900 domains. Iframely supports oEmbed, OG tags, and Twitter Cards.

- **Known domains** (YouTube, Vimeo, Loom, etc.): Notion shows an inline video player via embed.
- **Unknown domains**: Notion shows a bookmark (link preview with title/description/thumbnail) rather than an embed.
- **Manual embed**: Users can use `/embed` and paste a URL to force an iframe embed, but this only works if the URL returns embeddable content.

**To get auto-embed in Notion**: Your domain needs to be in Iframely's provider database, or you need to implement oEmbed discovery that Iframely can detect. Getting added to Iframely as a provider is possible but requires reaching out to them.

### What a Custom Video Tool Needs for Good Unfurling

At minimum, your video share pages should include:

```html
<head>
  <!-- Open Graph (works in most platforms) -->
  <meta property="og:type" content="video.other" />
  <meta property="og:title" content="My Screen Recording" />
  <meta property="og:description" content="3 min recording from Mar 4, 2026" />
  <meta property="og:image" content="https://yourdomain.com/thumb/abc123.jpg" />
  <meta property="og:image:width" content="1280" />
  <meta property="og:image:height" content="720" />
  <meta property="og:video" content="https://yourdomain.com/raw/abc123.mp4" />
  <meta property="og:video:type" content="video/mp4" />
  <meta property="og:video:width" content="1920" />
  <meta property="og:video:height" content="1080" />
  <meta property="og:url" content="https://yourdomain.com/v/abc123" />

  <!-- Twitter Cards -->
  <meta name="twitter:card" content="player" />
  <meta name="twitter:title" content="My Screen Recording" />
  <meta name="twitter:image" content="https://yourdomain.com/thumb/abc123.jpg" />
  <meta name="twitter:player" content="https://yourdomain.com/embed/abc123" />
  <meta name="twitter:player:width" content="1920" />
  <meta name="twitter:player:height" content="1080" />

  <!-- oEmbed Discovery -->
  <link rel="alternate" type="application/json+oembed"
        href="https://yourdomain.com/oembed?url=https://yourdomain.com/v/abc123" />
</head>
```

**Platform-by-platform expectations:**

| Platform | Inline Video? | Mechanism | What You Get Without Whitelist |
|----------|--------------|-----------|-------------------------------|
| Slack | No (unless whitelisted or Slack app) | oEmbed > Twitter Cards > OG | Rich card with thumbnail, title, description. Click to open in browser. |
| Discord | Maybe (if og:video points to direct MP4 < 20MB) | OG tags only | Thumbnail + title card, possibly inline MP4 player |
| Notion | Maybe (if in Iframely DB or oEmbed discoverable) | Iframely (oEmbed + OG) | Bookmark preview; manual `/embed` may work |
| Twitter/X | Player card (if approved) | Twitter Cards | Summary card with image |
| iMessage | Thumbnail preview | OG tags | Rich link preview with thumbnail |
| Generic | Varies | OG tags | Link preview with thumbnail |

---

## Comparison Summary

| Feature | Mux | CF Stream | Bunny Stream | AWS Stack | B2 + CF | api.video | Vimeo |
|---------|-----|-----------|-------------|-----------|---------|-----------|-------|
| **Est. monthly cost** | ~$2-3 | ~$7-8 | ~$5-7 | ~$11-18 | ~$0.20 | ~$6-7 | $12+ |
| **Encoding** | Free (Basic) | Free | $0.025/min+ | $0.015/min/rendition | DIY (FFmpeg) | Free | Included |
| **HLS/ABR** | Auto | Auto | Auto | DIY config | DIY | Auto | Auto |
| **Custom domain** | Yes | NO (VOD) | Yes | Yes | Yes | Limited | No |
| **oEmbed** | No (build own) | Via 3rd party | Yes (native) | DIY | DIY | Unclear | Yes (native) |
| **OG tags on share page** | Yes (iframe) | Basic | Customizable | DIY | DIY | Unclear | Yes |
| **Slack inline video** | No | No | No | No | No | No | YES (whitelisted) |
| **Notion auto-embed** | No | No | Possible | No | No | No | YES |
| **API quality** | Excellent | Good | Good | Complex | N/A | Good | Good |
| **Dev effort** | Low | Low | Low | Very High | Very High | Low | Low |
| **Player** | mux-player | CF player | Bunny player | DIY | DIY | api.video player | Vimeo player |
| **Cold storage** | Auto (60% off) | No | No | S3 tiers | No | No | No |

---

## Recommendations

### Best Overall: Mux
**Why**: Best API, free encoding on Basic tier, free delivery under 100K min/month (you'll never hit this), automatic cold storage saves on older videos, custom domain support, and the `player.mux.com/{id}` iframe page comes with OG tags for unfurling. The $20/mo pay-as-you-go plan includes a $20 credit that more than covers the estimated usage. Developer experience is unmatched.

**Trade-off**: No native oEmbed endpoint (you build a simple one), no Slack inline video (you'd build a Slack app or accept thumbnail previews), and you need to build your own share page.

### Best Budget: Bunny Stream
**Why**: Extremely cheap for storage and bandwidth, native oEmbed endpoint, custom domain support, good player with customization. The main cost driver is transcoding (~$5-6/mo at the estimated volume).

**Trade-off**: Less polished API/docs than Mux, transcoding costs are less predictable, smaller ecosystem.

### Best for Unfurling Out-of-the-Box: Vimeo
**Why**: Only platform on Slack's video whitelist (besides YouTube). Native oEmbed, auto-embeds in Notion, Twitter, everywhere. Zero effort on embedding/unfurling. The $12/mo Starter plan works.

**Trade-off**: 100GB lifetime storage cap (runs out in ~12 months at this volume), Vimeo branding, not designed for programmatic/API-first workflows, rate limits on API.

### Most Cost-Effective for Pure Storage: Backblaze B2 + Cloudflare
**Why**: Essentially free (~$0.20/mo). If you're willing to encode locally with FFmpeg and build everything yourself, this can't be beat on price.

**Trade-off**: Maximum DIY effort. No transcoding, no player, no HLS, no embed, no oEmbed -- you build it all.

### Avoid: AWS Stack
Unless you specifically need AWS ecosystem integration, the complexity and cost ($11-18/mo plus significant development time) make this a poor choice for a personal tool. Mux exists precisely to abstract away this complexity.
