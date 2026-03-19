# Loom (loom.com) Technical & Product Research

*Research date: 2026-03-02*

---

## 1. Pricing Tiers

Loom (now owned by Atlassian) offers four main plans plus a discounted Education tier:

### Starter (Free) - $0/month
- 5-minute recording limit per video
- 25 video storage limit (previously 100, reportedly tightened)
- 720p max resolution
- 10-user workspace limit
- Screen recording, camera bubble, basic transcriptions (50+ languages)
- Basic collaboration features
- **Cannot download videos**

### Business - $15/user/month (billed annually)
- Unlimited recordings, no time limit
- Unlimited storage
- Up to 4K resolution
- Advanced editing: trim, stitch, custom branding
- Video uploads and downloads (MP4)
- Enhanced collaboration features
- **No AI features**

### Business + AI - $20/user/month (billed annually)
- Everything in Business, plus:
- AI-powered transcript editing
- Filler word and silence removal
- Auto-generated titles, summaries, and chapters
- AI workflows

### Enterprise - Custom pricing
- Everything in Business + AI, plus:
- SSO (Single Sign-On) and SCIM provisioning
- Advanced content privacy controls
- Custom data retention policies
- Workspace activity logs (CSV export)
- Salesforce integration (beta)
- Average contract value reportedly ~$138K/year for ~510 users

### Education - Discounted
- Special pricing for verified education users/institutions
- Admins-only download permission

### Notable 2026 Changes (post-Atlassian)
- "Creator Lite" free seats (view-only) are being converted to paid Creator seats -- potentially massive cost increases for large orgs
- Billing management migrating to Atlassian's admin console
- Annual billing uses fixed user tiers (50, 100, 250) -- small teams can overpay at tier boundaries

---

## 2. Key Technical Features

### Recording Modes
Three capture modes available on desktop and Chrome extension:
1. **Screen + Camera** -- screen capture with webcam bubble overlay
2. **Screen Only** -- screen capture, no webcam
3. **Camera Only** -- webcam-only "talking head" recording

Mobile adds additional modes:
- **iOS**: audio only, screen only, camera only
- **Android**: screen only, cam only, screen+cam, audio only

You can switch between Screen Only and Screen+Camera mid-recording. Camera bubble can be toggled via the recording menu.

### Recording Platforms
- **Desktop app** (Mac + Windows) -- highest quality, up to 4K
- **Chrome extension** -- up to 1080p, uses browser APIs
- **Mobile apps** (iOS + Android)
- **Web recorder** (via browser)

### Encoding & Video Pipeline

| Platform | Container | Video Codec | Audio Codec | Max Resolution | Streaming |
|----------|-----------|-------------|-------------|----------------|-----------|
| Mac Desktop | HLS (TS segments) | H.264 | AAC, 48kHz, stereo | 4K (2160p) | HLS |
| Windows Desktop | HLS (TS segments) | H.264 | AAC, 48kHz, mono | 4K (2160p) | HLS |
| Chrome Extension | DASH (WebM) | VP8/VP9 | Opus | 1080p | DASH |

All platforms target 30fps with variable bitrate. Minimum playback resolution is 480p. The web player uses adaptive bitrate streaming -- automatically selects highest quality the viewer's connection supports.

Uploaded videos support MV, AVI, WebM, MP4, MOV formats up to 4GB. Downloads are always MP4 (H.264 + AAC).

### CDN & Delivery
- Videos are served via CDN with signed URLs: `https://cdn.loom.com/sessions/raw/[VIDEO-ID].webm?Expires=...&Policy=...&Signature=...&Key-Pair-Id=...`
- The signed URL pattern (Expires, Policy, Signature, Key-Pair-Id) is consistent with **AWS CloudFront signed URLs**, strongly indicating Loom uses AWS CloudFront as its CDN with S3 as the origin store
- Time-limited, cryptographically signed access prevents unauthorized sharing

---

## 3. API Capabilities

### Public REST API: Does NOT Exist
Loom explicitly states: **"Loom does not offer an open API at this time."** There are no public REST endpoints for CRUD operations on videos, no webhook system, and no programmatic bulk access to video metadata, transcripts, or analytics.

### What They Do Offer: Two SDKs

#### Record SDK (`@loomhq/record-sdk`)
- Allows embedding Loom's recording functionality into third-party web apps
- Requires a developer account and Public App ID from dev.loom.com
- Two app types auto-created: Sandbox (localhost) and Live (production domains)
- Pre-compiled JavaScript package; ~20 lines of code to implement
- Uses browser MediaRecorder API; requires third-party cookies
- **Not SSR-compatible** -- must load asynchronously in browser
- Events: `insert-click`, `recording-start`, `cancel`, `complete`
- On recording completion, share URL is automatically copied to clipboard
- Two variants:
  - **SDK Standard**: Currently available, pre-compiled
  - **SDK Custom**: Deprecated, no longer available for new instances

#### Embed SDK (`@loomhq/loom-embed`)
- NPM package or CDN script tag (current version: 1.2.2)
- Four methods:
  - `oembed(linkUrl, options?)` -- returns OEmbedInterface (video HTML, dimensions, thumbnail URL/dimensions, duration, provider info)
  - `gifEmbed(linkUrl)` -- returns HTML string with GIF embed code
  - `linkReplace(selector?, options?, target?)` -- auto-replaces Loom links in DOM with embedded players
  - `textReplace(textString, options?)` -- finds/replaces Loom URLs in strings with embed HTML
- No authentication documented for the Embed SDK
- Configurable max dimensions and GIF thumbnail toggle

### Third-Party Workarounds
- Apify actors exist for scraping Loom video data, transcripts, and download links
- Node.js CLI tools like `loom-downloader` (GitHub: EcomGraduates/loom-downloader) reverse-engineer CDN URLs

---

## 4. Embedding & Unfurling

### oEmbed
Loom is a registered oEmbed provider in the official providers list at oembed.com:

- **Endpoint**: `https://www.loom.com/v1/oembed`
- **URL schemes**: `https://loom.com/i/*` and `https://loom.com/share/*`
- **Discovery**: enabled (`true`)
- Returns standard oEmbed video type response with: HTML iframe embed, dimensions (width/height), thumbnail URL + dimensions, duration in seconds, provider name ("Loom")

### Standard Embed Code
Responsive iframe with 16:10 aspect ratio (62.5% padding-bottom):
```html
<div style="left: 0; width: 100%; height: 0; position: relative; padding-bottom: 62.5%;">
  <iframe src="https://www.loom.com/embed/[VIDEO_ID]"
    style="top: 0; left: 0; width: 100%; height: 100%; position: absolute; border: 0;"
    allowfullscreen scrolling="no" allow="encrypted-media *;">
  </iframe>
</div>
```

### Platform-Specific Unfurling

**Slack**: Loom has a first-party Slack app (installed via `/loom` command or workspace settings). It uses Slack's `link_unfurling` event + `chat.unfurl` API to provide rich previews when Loom links are pasted. The Slack app registers `loom.com` as its domain -- when Slack detects a Loom URL, it sends an event to Loom's bot, which responds with Block Kit-formatted unfurl content. This is a proprietary integration, not generic oEmbed.

**Notion**: Loom is natively supported by Notion as an embed provider. Pasting a Loom URL auto-creates an inline embed player. Notion likely uses both oEmbed discovery and a hardcoded allowlist for Loom.

**Other platforms (Medium, Trello, WordPress, etc.)**: Supported through **Embedly** and **Iframely**, which are embed aggregator services. WordPress/Jetpack specifically added Loom as a registered oEmbed provider. Platforms that support oEmbed discovery will automatically find Loom's endpoint.

**General link previews** (Discord, Twitter, etc.): Loom serves Open Graph meta tags (`og:title`, `og:image`, `og:video`, `og:description`) on share pages. I was unable to inspect the exact tags, but standard OG tags + the oEmbed endpoint provide coverage for most unfurling scenarios.

### Summary of Unfurling Strategy
Loom uses a **layered approach**:
1. **oEmbed endpoint** (`/v1/oembed`) -- standards-based, discovered by compliant consumers
2. **Open Graph meta tags** -- fallback for platforms that read HTML `<head>` (Discord, Twitter, Facebook, etc.)
3. **First-party Slack app** -- custom unfurl via Slack's Events API + Block Kit for richer in-Slack experience
4. **Embedly/Iframely registration** -- covers platforms that delegate to embed aggregators
5. **Native integrations** -- hardcoded support in Notion, Trello, etc.

---

## 5. Desktop App Technology

### Framework: Electron
- Built on **Electron** (Chromium + Node.js), enabling cross-platform (Mac + Windows) with shared UI code
- Chosen because the team had JavaScript expertise and needed access to native OS APIs
- Not Tauri, not native Swift/C++

### Recording Stack
- Uses **native OS screen capture APIs** (not browser APIs), which is why the desktop app can record up to 4K vs the Chrome extension's 1080p cap
- OS APIs produce raw `.mp4` files during recording

### Video Processing: FFmpeg
- A **minimal FFmpeg build** is bundled with the Electron app
- FFmpeg is used to:
  - **Mux** the `.mp4` files produced by OS screen capture APIs
  - **Convert** to HLS format (TS segment files + M3U8 playlist)
- This transmuxing happens **client-side** on the user's machine, not on Loom's servers -- a deliberate architectural decision to reduce server-side transcoding costs

### HLS Architecture (Key Design Decision)
The conversion to HLS is central to Loom's "instant URL on stop" feature:
- HLS breaks video into a **playlist of small segment files** rather than one monolithic file
- Segments can be **uploaded progressively during recording** -- the video is being uploaded to the CDN *while you record*
- When you stop recording, the final segment is uploaded and the playlist is finalized -- the video is **already on the CDN**
- The share URL is generated before/during recording and becomes valid as soon as the HLS playlist is complete
- If recording fails mid-way, only the affected segment is lost; earlier segments survive
- HLS plays natively in all modern browsers without re-encoding

This replaced an earlier architecture where `.webm` files were uploaded after recording and required server-side conversion for cross-browser compatibility -- which introduced delays before the link was shareable.

---

## 6. Export Capabilities

### Individual Download
- Available to admins and creators on **Business, Business+AI, and Enterprise** plans
- Downloaded as **.MP4 format** only
- Free (Starter) plan users **cannot download**
- Creator Lite users cannot download on any plan
- Only signed-in Loom users can download (even if viewer download is enabled)
- Admins can toggle whether viewers can download

### What's Lost on Download
Downloaded MP4 files **do not include**: CTAs (calls to action), filler word/silence removal edits, chapters, or closed captions. Video trims are preserved.

### File Size Limits
- Videos over ~20GB (~3 hours at 4K) require contacting support to download
- Large files show a "Polishing pixels" processing message

### Bulk Export
- **No native bulk download feature exists**
- Loom's bulk operations are limited to: move, archive, delete (via checkbox selection in library)
- You cannot bulk-change privacy settings or titles either
- Data exports available (Business+): Engagement Insights as CSV
- Enterprise-only: workspace activity logs as CSV

### Workarounds for Bulk Export
- Manual: download one-by-one, re-upload to new account
- Third-party: Apify scrapers, browser extensions, CLI tools (e.g., `loom-downloader` on npm/GitHub)
- No official API to automate this

---

## 7. Known Technical Architecture Details

### Cloud Infrastructure
- **Highly likely AWS-based**: CDN URL patterns (`cdn.loom.com` with `Key-Pair-Id`, `Signature`, `Policy`, `Expires` parameters) are the exact format of AWS CloudFront signed URLs
- Video storage almost certainly uses **S3** (standard pattern for CloudFront-fronted video)
- CloudFront edge locations provide global CDN delivery

### The "Instant URL on Stop" Feature
This is Loom's most technically interesting feature. Here's how it works:

1. **URL is generated at recording start** (or even before) -- a unique video ID is allocated
2. **Recording produces HLS segments** -- FFmpeg on the client converts OS screen capture to HLS `.ts` segments in real time
3. **Segments are uploaded progressively** -- while you're still recording, segments are being uploaded to S3/CDN
4. **On stop**: the final segment is uploaded, the HLS playlist (`.m3u8`) is finalized
5. **URL is immediately shareable** -- because the content is already on the CDN; the player can begin streaming available segments
6. **Post-processing runs async** -- thumbnail generation, AI transcription, chapter extraction, multi-quality encoding happen after the fact, but the video is watchable immediately

### Adaptive Streaming
- Desktop recordings: **HLS** (H.264 + AAC in TS container)
- Chrome extension recordings: **DASH** (VP8/VP9 + Opus in WebM container)
- The web player auto-selects quality based on viewer bandwidth
- Multiple quality renditions (480p through source resolution) are encoded server-side post-upload

### Key Architectural Decisions
- **Client-side transmuxing**: Moving FFmpeg processing to the desktop app eliminated server-side transcoding for the initial upload, reducing infrastructure costs and enabling instant playback
- **HLS over monolithic files**: Enables streaming upload, fault tolerance, and instant sharing
- **Dual codec strategy**: H.264 for desktop (broad compatibility, hardware acceleration), VP8/VP9 for Chrome extension (royalty-free, native browser support)

---

## What I Could NOT Confirm

- **Exact Open Graph meta tag implementation**: I couldn't fetch/inspect the actual HTML `<head>` of a Loom share page to see the specific OG tags used
- **Server-side technology stack**: Backend language, framework, database -- no public information found
- **Exact CDN provider**: The signed URL pattern strongly suggests CloudFront, but Loom has never publicly confirmed this
- **WebSocket/SSE usage**: Whether Loom uses real-time connections for recording status, collaboration features, etc.
- **Authentication for the Embed SDK**: The docs don't mention auth requirements; it's unclear if it's fully open or rate-limited
- **SCIM/SSO implementation details**: Enterprise-only, no technical details publicly available
- **Post-processing pipeline specifics**: What infrastructure runs transcription, multi-quality encoding, thumbnail generation

---

## Sources

- [Atlassian Loom Pricing Page](https://www.atlassian.com/software/loom/pricing)
- [Available Loom Plans - Atlassian Support](https://support.atlassian.com/loom/docs/available-loom-plans/)
- [Loom Pricing in 2026 - Supademo](https://supademo.com/blog/loom-pricing)
- [Behind the Scenes: Building Loom for Desktop - Atlassian Blog](https://www.atlassian.com/blog/loom/behind-the-scenes-building-loom-for-desktop)
- [Loom Video Encoding Settings by Platform - Atlassian Support](https://support.atlassian.com/loom/docs/loom-video-encoding-settings-by-platform/)
- [Does Loom Have an Open API? - Atlassian Support](https://support.atlassian.com/loom/docs/does-loom-have-an-open-api/)
- [Loom Developer Portal - Record SDK](https://dev.loom.com/docs/record-sdk/getting-started)
- [Loom Developer Portal - Embed SDK API](https://dev.loom.com/docs/embed-sdk/api)
- [Loom Embed SDK - Getting Started](https://dev.loom.com/docs/embed-sdk/getting-started)
- [oEmbed Providers List](https://oembed.com/)
- [Loom on Iframely](https://iframely.com/domains/loom)
- [Loom Embed Provider - Embedly](https://embed.ly/provider/loom)
- [Loom Slack Integration - Atlassian Support](https://support.atlassian.com/loom/docs/use-looms-slack-integration/)
- [Use Loom's Different Capture Modes - Atlassian Support](https://support.atlassian.com/loom/docs/use-looms-different-capture-modes/)
- [Download Your Loom Video - Atlassian Support](https://support.atlassian.com/loom/docs/download-your-loom-video/)
- [Loom SDK FAQ - Atlassian Support](https://support.atlassian.com/loom/docs/loomsdk-faq/)
- [Loom SDK Standard - Developer Docs](https://dev.loom.com/docs/record-sdk/sdk-standard)
- [Loom Pricing - Tekpon](https://tekpon.com/software/loom/pricing/)
- [Loom Pricing - Arcade Blog](https://www.arcade.software/post/loom-pricing)
