# Competitive Landscape: Video Recording & Sharing Tools

*Research date: 2026-03-30*

---

## Overview

This document surveys the competitive landscape of video recording and sharing tools, with a focus on UX patterns, video page design, sharing workflows, and recording capabilities. It builds on our existing Loom research (`loom-research.md`) and is oriented toward informing the design of our personal video tool.

The market breaks down roughly into three categories:

1. **Async video messaging** (Loom, Cap, Supercut, Berrycast, Zight) -- record and share instantly via link, optimised for speed.
2. **Professional screen recording / editing** (Screen Studio, Tella, CleanShot X) -- record locally, edit before sharing, optimised for output quality.
3. **Presentation / virtual camera** (Airtime/mmhmm, Vidyard) -- more specialised tools that overlap with our use case in specific ways.

Our tool spans categories 1 and 2: instant-share for quick Slack replacements, but with the quality and flexibility to produce polished content when needed.

---

## Primary Products (Deep Evaluation)

### Loom (loom.com)

*The incumbent. See `loom-research.md` for full technical analysis. This section focuses on UX patterns and pain points.*

**Pricing**: Free tier (5-min limit, 25 videos, 720p), Business at $15/user/month, Business + AI at $20/user/month, Enterprise custom.

#### Recording UX

- **Start flow**: Click menu bar icon or use keyboard shortcut. Select capture mode (Screen + Camera, Screen Only, Camera Only), choose screen/window, pick camera and mic. Hit record. Roughly 3-4 clicks from intent to recording.
- **Mode switching**: Can toggle camera bubble on/off mid-recording. Cannot switch between full camera-only and screen recording mid-recording -- this is a hard limitation.
- **PiP**: Circular camera bubble, positioned in a corner. Movable during recording by dragging. Size is adjustable. Shape is always circular.
- **Pause/resume**: Supported via recording toolbar and keyboard shortcut.
- **Recording UI**: Floating control bar at bottom of screen with stop, pause, trash, and drawing tools. Timer visible. Relatively unobtrusive but can interfere with content near screen edges.
- **Keyboard shortcuts**: Configurable global shortcuts for start/stop, pause, cancel. Works from any app.

#### Post-Recording / Sharing

- URL is available almost instantly after stopping (the HLS streaming architecture means video is already on the CDN during recording).
- Post-recording shows a brief dialog with the video title (auto-generated from transcript), a copy-link button, and options to edit or share.
- Link is copied to clipboard automatically on stop -- this is the gold standard for "stop and share" speed.
- Title is auto-generated from transcript using AI (Business + AI plan).

#### Video Page Design

- **Layout**: Full-width video player at top. Title below. Creator avatar and name. Auto-generated summary below title (AI tier). Transcript to the right of the video on desktop, expandable. Chapters shown in player timeline and as a list below the video.
- **Player**: Custom player with quality selector, playback speed control (0.5x to 2x), closed captions toggle, fullscreen. Autoplay on page load (muted until interaction in some contexts).
- **CTA**: Optional call-to-action button shown below the video. Auto-generated based on the webpage you recorded.
- **Comments/reactions**: Emoji reactions and timestamped comments below the video. Viewers can react without an account; commenting requires a Loom account.
- **Branding**: Custom logo in top-left of player, custom play button colour (Business+ plans).

#### Known Pain Points (Post-Atlassian)

- **Stability**: Frequent crashes, failed uploads, recordings that won't save. Multiple service outages in late 2025 (6-hour degradation Oct 27, widespread outage Nov 17, 7-hour audio issue Nov 19, another outage Dec 16).
- **Account migration**: Forced merge to Atlassian accounts causing login loops, lost access to recordings, confusing billing via Atlassian's admin console.
- **Bloat**: Constant AI upsell prompts, increasingly cluttered interface, features being gated behind progressively higher tiers.
- **Free tier degradation**: Reduced from 100 to 25 video limit, 5-minute cap, 720p, no downloads. Creator Lite seats being converted to paid.
- **Electron jank**: Desktop app is Electron-based and frequently feels sluggish. Resource usage when not recording is higher than it should be.
- **No bulk operations**: Cannot bulk download, bulk change privacy, or bulk edit titles. Library management for large collections is painful.

#### What Loom Gets Right

- Instant URL on stop (the core UX innovation).
- Auto-copy link to clipboard.
- AI-generated titles and summaries reduce friction for quick recordings.
- Layered unfurling strategy (oEmbed + OG tags + Slack app + Embedly/Iframely).
- Transcript synced to video playback with clickable timestamps.
- The recording-starts-immediately feeling -- no waiting for processing.

---

### Cap (cap.so)

*Open-source Loom alternative. Closest to what we're building. Codebase analysis is covered separately in Task 03.*

**Pricing**: Free tier (limited features), Desktop License $58 lifetime (or $29/year) for local recording/editing, Cap Pro $8.16/mo (annual) or $12/mo for cloud sharing + AI features. Enterprise available.

**Platforms**: Native macOS (Apple Silicon + Intel) and Windows. Web app for viewing/management.

**GitHub**: 17.6k stars. Open source under permissive license.

#### Two Recording Modes

Cap has a distinctive split between two fundamentally different recording workflows:

1. **Instant Mode** -- Loom-like. Records and uploads simultaneously. Shareable link available immediately when you stop. Cloud processing. AI-generated titles, summaries, chapters, and transcripts. Limited to 5-minute recordings on free tier. Best for quick async communication.

2. **Studio Mode** -- Records locally at highest quality (4K 60fps). No upload during recording. Full local editing suite: custom backgrounds, padding, rounded corners, shadow, cursor effects, motion blur, zoom effects. Export to MP4, GIF, or shareable link. Best for polished content.

This dual-mode approach is directly relevant to our design. Cap lets you choose upfront whether you need speed (Instant) or quality (Studio), rather than trying to serve both from a single workflow.

#### Recording UX

- **Start flow**: Open app, select mode (Instant or Studio), choose inputs. Hit record. Clean, minimal interface.
- **Mode switching during recording**: Not supported. You choose Instant or Studio before starting.
- **PiP**: Camera overlay supported in both modes. Positioning and sizing configurable.
- **Keyboard shortcuts**: Global shortcuts for start/stop (`Cmd+Shift+2`), pause/resume (`Cmd+Shift+3`), restart (`Cmd+Shift+4`), open app (`Cmd+Shift+1`). Fully customisable.
- **Pause/resume**: Supported.
- **Screenshot mode**: Built-in screenshot capture with backgrounds, padding, annotations -- sharing the same beautification engine as Studio Mode.

#### Sharing & Video Page

- **Instant Mode sharing**: Link available immediately on stop. Uploads happen during recording.
- **Studio Mode sharing**: Must export first (local processing), then optionally upload.
- **Video page URL pattern**: `cap.so/s/[video-id]`.
- **Embed URL**: `cap.so/embed/[video-id]`. Standard iframe embed with responsive wrapper.
- **Video page elements**: Player, title (AI-generated), creator info, timestamp. AI summary, chapters, and transcript. Comments with timestamp-linked discussions and emoji reactions. Analytics (who watched, how long, engagement).
- **Custom domain**: Cap Pro supports `cap.yourdomain.com`.
- **Custom S3**: Bring your own S3 bucket for storage.
- **Self-hosting**: Full self-hosting via Docker Compose.
- **Loom importer**: Built-in tool to import existing Loom videos.

#### Strengths

- Open source and self-hostable -- full data ownership.
- Custom domain and custom S3 support -- you own your infrastructure.
- The Instant/Studio mode split is a clean solution to the speed-vs-quality tradeoff.
- Cross-platform (Mac + Windows) with native code.
- Active development, responsive maintainer.
- Loom importer is a smart acquisition feature.
- Screenshot mode with beautification shares the same engine as Studio Mode.
- REST API and webhooks for programmatic integration.

#### Weaknesses

- Still beta-quality in places -- users report random breakages.
- No mode switching during recording.
- Instant Mode has a 5-minute limit on free tier.
- Studio Mode requires local export before sharing -- no streaming upload.
- The codebase quality has been flagged as inconsistent (per project requirements).
- No iOS/Android apps.

---

### Screen Studio (screen.studio)

*Mac-native screen recorder known for beautiful, polished output. Not a sharing platform -- a recording and editing tool.*

**Pricing**: Subscription-only as of 2026. $29/month, or $108/year ($9/month billed annually). Previously offered a $229 one-time license (discontinued). macOS only.

#### What Makes It Different

Screen Studio is opinionated about output quality. Its core innovation is automatic post-processing that makes raw screen recordings look professional:

- **Automatic zoom**: Follows cursor and clicks, automatically zooming into areas of activity. No manual keyframing needed.
- **Smooth cursor movement**: Raw shaky cursor movements are transformed into smooth, natural glides.
- **Cursor resizing**: Cursor size adjustable after recording.
- **Auto-hide static cursor**: If cursor isn't adding value, it fades out automatically.
- **High-quality system cursors**: Replaces system cursors with hi-res versions when enlarged.
- **Motion blur**: Adds natural motion blur to movements.
- **Background and padding**: Custom backgrounds, adjustable padding, rounded corners, shadow.
- **Horizontal/vertical output**: One-click switch between landscape and portrait output. All animations auto-adjust.

#### Recording & Editing

- Records screen, webcam, microphone, and system audio.
- Webcam overlay with automatic zoom-out when cursor approaches the overlay.
- Built-in transcript generation (on-device, no data sent to servers).
- iOS device recording via USB cable with automatic device frame detection.
- Timeline editor for trimming, cutting, speed adjustment.
- Export up to 4K 60fps. Video and GIF exports. Copy-to-clipboard.
- Export presets for web, social media, or further editing in other tools.
- Keyboard shortcut recording and display.

#### Sharing

- **No cloud sharing platform**. Screen Studio is purely a local recording and editing tool.
- Export to file (MP4, GIF) or copy to clipboard.
- "Shareable links" feature exists but details are limited -- likely a basic upload-and-get-link feature, not a full video page experience.
- No embed system, no video page, no analytics, no comments.

#### Strengths

- Output quality is best-in-class. The automatic zoom and cursor smoothing create genuinely professional-looking videos with zero effort.
- Mac-native. Fast, reliable, feels like a proper macOS app.
- On-device transcription respects privacy.
- The "record once, output multiple formats" approach (landscape, portrait, GIF) is efficient.

#### Weaknesses

- Mac only.
- No instant sharing -- you must record, edit, export, then manually share the file.
- No video hosting or video page.
- Subscription pricing is steep for a local tool ($108/year minimum).
- Not suitable for quick async communication -- it's a content creation tool, not a messaging tool.

#### Relevance to Our Project

Screen Studio's automatic zoom, cursor smoothing, and beautification features are the benchmark for what "polished output" looks like. We should study these effects as aspirational nice-to-haves for our Studio-equivalent workflow. However, Screen Studio solves a fundamentally different problem -- it's about making content look good, not about instant sharing.

---

### Tella (tella.tv)

*Browser-based recording with strong editing and presentation features. Positioned between Loom (speed) and Screen Studio (quality).*

**Pricing**: No free plan. 7-day free trial. Pro at $12/month (annual) or $19/month -- 5-minute export limit. Premium at $39/month (annual) or $49/month -- no export limit, custom branding, custom domain, analytics.

**Platforms**: Browser-based web app (primary). Also has a native macOS app.

#### Core Innovation: Clips-Based Recording

Tella's key UX insight is that you don't need to record in one continuous take. Instead:

- Record your video as a series of short clips.
- Rearrange, re-record individual clips, or add new ones after the fact.
- Edit transitions between clips.
- The final output is assembled automatically.

This eliminates the anxiety of one-take recording. Mess up? Just re-record that one clip. Want to add something? Insert a new clip between existing ones.

#### Recording UX

- **Speaker notes**: Visible during recording. Write talking points or a full script, and they appear on screen while you record (not in the final video).
- **Multiple layouts**: Switch between layouts during recording (camera only, screen only, screen + camera, side-by-side, etc.). Layout switching is a first-class feature.
- **Zoom effects**: Add zoom into specific areas, applied during editing.
- **Backgrounds**: Custom backgrounds from presets, Unsplash, or uploads.

#### AI Editing

- **Remove silences**: One-click deletion of all silent pauses.
- **Remove filler words**: Automatically detect and cut "um", "ah", etc.
- **Text-based editing**: Edit the video by editing the transcript. Delete words from the transcript and the corresponding video is cut.
- **Auto-trim**: Automatically trim dead air from start and end.

#### Sharing

- Export in 4K. Download as MP4.
- Embed videos on websites with iframe.
- Shareable links for browser playback.
- Not as instant as Loom/Cap -- Tella is designed for edited content that you spend time on before sharing.

#### Strengths

- Clips-based recording removes the pressure of one-take perfection.
- Speaker notes during recording are brilliant for structured content.
- Text-based video editing (edit transcript = edit video) is a powerful paradigm.
- AI filler word and silence removal saves significant editing time.
- Browser-based -- no install required, works everywhere.
- Layout switching during recording is well-implemented.

#### Weaknesses

- No free plan. $12/month minimum, with a 5-minute export cap on Pro.
- Not designed for quick async sharing -- the UX optimises for edited, polished content.
- Browser-based recording has inherent quality limitations vs. native apps.
- No instant link-on-stop -- videos need to be exported/processed first.
- The 5-minute export limit on the cheaper plan is frustrating.

#### Relevance to Our Project

Tella's clips-based recording and speaker notes are worth studying as potential future features. Text-based editing (edit the transcript to edit the video) is a particularly compelling pattern. However, Tella's workflow is fundamentally oriented toward "considered content" -- it's not a tool for quick Slack replacements.

---

## Secondary Products (Lighter Evaluation)

### Supercut (supercut.video)

*Emerging async video messaging tool positioning itself as the modern Loom replacement.*

**Pricing**: Free plan available. Paid starts at ~$15/user/month.

**Platforms**: Native macOS and Windows apps. Chrome extension.

**Notable features**:
- Custom branded layouts with multiple layout options.
- Auto-editing: one-click cleanup to remove mistakes and filler.
- Auto-chapters for smart video navigation.
- Timeline-based commenting and emoji reactions.
- Call-to-action links from within videos.
- View tracking and engagement analytics.
- Up to 4K recording.
- Instant sharing with public/private links.
- ISO 27001 and SOC 2 Type II certified.

**Why it matters**: Supercut is the most direct Loom competitor in terms of UX philosophy. It combines instant sharing with quality touches (custom branding, auto-editing). The auto-chapters feature for navigation is particularly well-done. Worth watching as a benchmark for what "modern Loom replacement" looks like in practice.

---

### Airtime / mmhmm (airtime.com)

*Virtual camera and presentation tool. mmhmm rebranded to Airtime in April 2025.*

**Pricing**: $10/month (annual) or $12/month. 14-day free trial. Airtime Camera is free (or $20 one-time after promotion period).

**Platforms**: Mac and Windows.

**Four tools in one**:
1. Airtime Camera -- virtual camera for looking polished in video calls.
2. Airtime Creator -- build presentations where you're the focus (successor to mmhmm).
3. Airtime Recorder -- async video recording with cloud hosting.
4. Airtime Studio -- multi-person recording.

**Relevance**: The presentation-style approach (you in front of your content with multiple layout options) is interesting for the "document intro" use case. Airtime's layout switching (presenter only, presenter + content, content only, side-by-side) during live presentation is smooth. However, Airtime is primarily a meeting/presentation tool, not a screen recording + sharing tool.

---

### Zight (zight.com) -- formerly CloudApp

*Screenshots, screen recordings, GIFs, and annotations for quick sharing.*

**Pricing**: Free tier available. Paid plans for teams with AI features.

**Platforms**: Desktop (Mac + Windows), Chrome extension, mobile.

**Key features**:
- Screen recording with webcam overlay.
- GIF creation.
- Screenshot with annotation tools.
- Auto-generated titles, descriptions, and transcriptions via AI.
- Instant cloud upload and link generation.
- Smart Actions: auto-convert video transcripts into meeting notes, step-by-step guides, bug reports, SOPs.
- Request Video: let others record and send videos to you.
- Video editing (trim, crop, filter, merge clips).
- Integrations with Slack, Teams, Zendesk, Jira, etc.

**Relevance**: Zight's "Smart Actions" feature (auto-generating structured documents from video) is an interesting pattern. The "Request Video" feature (giving someone else a link to record and send you a video) is a non-obvious use case. The tool is more focused on enterprise communication than personal use.

---

### Berrycast (berrycast.com)

*Simple screen recording with instant sharing.*

**Pricing**: Starter $5/month, Professional $12/month, Enterprise $29/month. 14-day free trial.

**Platforms**: Mac, Windows, Chrome.

**Key features**:
- One-click recording (screen + webcam + mic).
- Automatic upload and shareable link.
- Video library with folders and password protection.
- AI Writer: auto-generate summaries, action items, and emails from transcripts.
- MP4 download.

**Relevance**: Berrycast is notable for its simplicity -- it does the core "record and share" loop with minimal friction. The AI Writer feature (generating action items and follow-up emails from video content) is a smart extension of transcription. However, it's a relatively basic tool with limited editing capabilities.

---

### CleanShot X (cleanshot.com)

*Screenshot and screen recording tool for macOS. Not a video sharing platform, but excellent for the "capture and share" workflow.*

**Pricing**: $29 one-time (1 year of updates, 1GB cloud). Cloud Pro $10/user/year for unlimited cloud + custom domain. macOS only.

**Key features**:
- Quick Access Overlay: after capturing, a small popup appears for instant copy, save, annotate, or drag-and-drop to other apps.
- Screen recording as MP4 or GIF with webcam overlay, click capture, keystroke display.
- Built-in video editor (trim, quality, resolution, audio).
- CleanShot Cloud: upload captures and get an instant shareable link.
- Custom domain and branding for shared links.
- Password protection and self-destruct on shared links.
- OCR (on-device text recognition from screenshots).
- Annotation tool with extensive drawing, highlighting, pixelation, and markup tools.
- Scrolling capture, frozen screen capture, floating screenshots.
- Capture history (up to 1 month).

**Relevance**: CleanShot X is the gold standard for the "capture something and share it instantly" workflow on macOS. The Quick Access Overlay is a masterclass in post-capture UX -- it appears immediately, gives you one-click access to the most common actions, and stays out of the way. The cloud sharing with custom domain at $10/user/year is remarkably affordable. Even though CleanShot is primarily a screenshot tool, its screen recording + instant cloud link workflow is worth studying closely.

---

### Vidyard (vidyard.com)

*Enterprise sales-focused video platform with AI avatar features.*

**Pricing**: Enterprise-focused. Demo required.

**Key features**:
- AI-powered video avatars for personalised outreach at scale.
- Video hosting, publishing, and organisation.
- Engagement analytics with CRM integration.
- Integrations with Salesforce, HubSpot, Outreach, etc.

**Relevance**: Minimal for our use case. Vidyard has moved heavily into AI sales automation territory. The engagement analytics (who watched, how long, when they dropped off) are relevant conceptually, but the tool is designed for sales teams, not personal async communication.

---

### Komodo Decks / Kommodo (komododecks.com)

*Screen recording for documentation and tutorials. Appears to have rebranded to "Kommodo" with AI features.*

**Pricing**: Free tier available. Paid plans not clearly listed.

**Key features**:
- AI meeting recorder (syncs with Google Calendar).
- AI assistant that answers questions from your video library.
- Auto-generated SOPs and step-by-step guides from recordings.
- Video library with search across all recordings.
- Browser-based recording.
- "CaptureFusion" technology for editing, re-recording, and overdubbing parts of videos.

**Relevance**: The "search across your entire video library" and "AI assistant that answers questions from your recordings" features are interesting future-state ideas. The auto-SOP generation from recordings is similar to Zight's Smart Actions. Not directly relevant to our core use case but worth noting as a direction the market is moving.

---

## Cross-Product Analysis

### Best-in-Class UX by Workflow Stage

#### Recording

| Aspect | Best-in-Class | Why |
|--------|---------------|-----|
| Time from intent to recording | Loom, CleanShot X | Fewest clicks. Global keyboard shortcut straight to recording. |
| Mode switching during recording | Loom (limited), Tella | Loom can toggle camera on/off. Tella supports full layout switching. Neither supports switching between camera-only and screen recording mid-take. |
| Camera overlay (PiP) | Loom | Draggable, resizable circle during recording. Natural and intuitive. |
| Recording quality | Screen Studio | 4K 60fps with automatic polish (zoom, cursor smoothing, motion blur). |
| Clips-based recording | Tella | Record in segments, rearrange and re-record later. Eliminates one-take pressure. |
| Speaker notes | Tella | See your talking points while recording. Not visible in output. |
| Keyboard shortcuts | Cap, Loom | Global shortcuts that work from any app. Customisable. |

#### Post-Recording / Sharing

| Aspect | Best-in-Class | Why |
|--------|---------------|-----|
| Speed: recording stop to shareable URL | Loom | URL available instantly because video streams to CDN during recording. Auto-copied to clipboard. |
| Post-recording editing (before share) | Screen Studio, Tella | Screen Studio auto-polishes. Tella enables text-based editing. |
| AI cleanup (filler words, silences) | Tella | One-click removal of silences and filler words. Text-based editing of transcript. |
| Auto-metadata | Cap, Loom | AI-generated titles, summaries, chapters, and transcripts. |

#### Video Page / Viewer Experience

| Aspect | Best-in-Class | Why |
|--------|---------------|-----|
| Page design | Loom | Clean layout with video, title, summary, transcript, chapters. Well-established pattern. |
| Transcript integration | Loom | Transcript synced to playback, clickable timestamps, searchable. |
| Chapters / navigation | Supercut | Auto-generated chapters shown in sidebar with timestamps and descriptions. |
| Comments | Cap, Loom, Supercut | Timestamped comments and emoji reactions on the timeline. |
| Embed experience | Cap, Loom | Standard iframe embeds with responsive wrappers. Cap has good documentation. |
| Link unfurling | Loom | Layered strategy: oEmbed + OG tags + Slack app + Embedly registration. Best coverage across platforms. |

#### Management

| Aspect | Best-in-Class | Why |
|--------|---------------|-----|
| Quick sharing overlay | CleanShot X | Immediate post-capture popup with copy, save, annotate, drag-and-drop. |
| Video library | Loom, Zight | Search, folders, tags, bulk operations (though Loom's bulk ops are limited). |
| Data ownership | Cap | Self-hosting, custom S3, custom domain. Full control. |
| Privacy controls | CleanShot X, Cap | Password protection, self-destruct links, private/unlisted/public settings. |

---

## Patterns to Adopt

### 1. Instant URL on Stop (Loom, Cap Instant Mode)

The single most important UX pattern in this space. When recording stops, a URL should be on the clipboard within seconds. This is what makes async video viable as a Slack replacement. Our streaming upload architecture (HLS segments during recording) should prioritise this above all else.

### 2. Auto-Copy Link to Clipboard (Loom)

After stopping a recording, the shareable link should be on the clipboard automatically -- no extra click required. This tiny detail saves a step on every single recording and makes the paste-into-Slack workflow seamless.

### 3. AI-Generated Metadata (Cap, Loom, Supercut)

Auto-generated titles, summaries, and chapters from the transcript dramatically reduce the friction of the "quick recording" workflow. The user hits stop and the video already has a sensible title and description. This should be a priority feature, ideally done on-device via Apple Intelligence or a local model.

### 4. Quick Access Overlay (CleanShot X)

After recording, show a small, unobtrusive overlay with the most common actions: copy link, edit title, open video page, trash. CleanShot X's version of this is the gold standard -- it appears immediately, gives you what you need, and gets out of the way.

### 5. Dual-Mode Architecture (Cap)

Cap's split between Instant Mode (speed-optimised, cloud-streaming) and Studio Mode (quality-optimised, local recording) is a clean way to serve both "quick Slack replacement" and "polished tutorial" use cases. Rather than trying to make one workflow serve both, let the user choose upfront. Our mode switching during recording goes further than Cap's approach, but the principle of speed-vs-quality as an explicit choice is sound.

### 6. Transcript-Synced Playback (Loom)

Clickable, searchable transcript alongside the video with timestamps that sync to playback. This makes long videos navigable and makes content discoverable via text search.

### 7. Auto-Chapters (Supercut, Loom, Cap)

Automatically segment the video into chapters with descriptions. Show these in the player timeline and as a navigable list. This is especially valuable for longer recordings.

### 8. Global Keyboard Shortcuts (Loom, Cap)

Record start/stop/pause accessible from any app via global keyboard shortcuts, without switching to the recording app. Essential for the "stay in your flow" recording experience.

### 9. Layered Unfurling Strategy (Loom)

Don't rely on a single mechanism for link previews. Implement:
- OG meta tags (og:title, og:description, og:image, og:video)
- Twitter Card tags
- oEmbed endpoint with discovery tag
- Embedly/Iframely registration (future)
- Custom Slack app (future, if worthwhile)

This ensures good link previews everywhere.

### 10. Custom Domain (Cap, CleanShot X)

This is already in our requirements (`v.danny.is`), but it's worth noting that Cap and CleanShot X both offer this as a feature. The market validates this as desirable.

---

## Anti-Patterns to Avoid

### 1. Forced Account Creation for Viewers (Loom)

Loom requires viewers to have a Loom account to comment or download. This creates friction for the viewer. Our tool should never require viewer accounts -- viewing, and ideally all viewer-facing features, should work without sign-up.

### 2. AI Upsell Gating (Loom)

Loom gates AI features (titles, summaries, filler word removal) behind a $20/user/month plan. Since we're building a personal tool, all features should be available. But more broadly: don't make basic quality-of-life features feel like premium add-ons.

### 3. Electron Jank (Loom)

Loom's Electron-based desktop app feels sluggish and resource-heavy. This is a core motivation for building native Swift. Don't compromise on this -- the app should feel invisible when not recording.

### 4. Post-Atlassian Bloat (Loom)

Loom has accumulated features (AI workflows, team workspaces, custom branding, CTAs, comment threads, reactions, engagement analytics, Salesforce integration) that clutter the interface for simple use cases. A personal tool should have zero features that serve team or enterprise needs.

### 5. No Bulk Operations (Loom)

Loom has no bulk download, no bulk privacy changes, no bulk title editing. If you have hundreds of videos, managing them is painful. Even for a personal tool, basic bulk operations (select multiple, change visibility, delete) are important.

### 6. Subscription Pricing for Local Tools (Screen Studio)

Screen Studio moved from a $229 one-time purchase to a $108/year subscription for a tool that runs entirely on your machine. Users resent this. Our tool is personal and self-hosted -- there should be no recurring cost beyond infrastructure.

### 7. Free Tier Degradation (Loom)

Loom has progressively made the free tier worse (100 to 25 videos, 5-minute limit, 720p, no downloads). This erodes trust. Since our tool is personal, this doesn't apply directly, but it's a reminder: don't build something you'll resent using.

### 8. Single-Take Anxiety (Most Tools)

Most tools assume you'll record in a single continuous take. If you mess up, you start over. Tella's clips-based approach and our planned pause/resume and mode-switching features address this, but it's worth remembering: the recording experience should be forgiving.

---

## Video Page Design Notes

### Common Elements Across Tools

Every video sharing tool with a video page includes roughly the same elements, with variation in emphasis and layout:

| Element | Loom | Cap | Supercut |
|---------|------|-----|----------|
| Video player (full width) | Yes | Yes | Yes |
| Title | Below player | Below player | Below player |
| Creator info (avatar, name) | Yes | Yes | Yes |
| Auto-generated summary | Yes (AI tier) | Yes (Pro) | No |
| Transcript (synced) | Sidebar, expandable | Below player | No |
| Chapters | Timeline + list | Timeline + list | Sidebar list |
| Comments / reactions | Below video | Below video | Timeline |
| CTA button | Optional | No | Yes |
| Embed code | Available | Available | Available |
| Download option | Admin-controlled | Admin-controlled | Unknown |
| View count | Yes | Yes | Yes |
| Custom branding | Logo + colours | Logo (Pro) | Brand layouts |

### Design Principles for Our Video Page

Based on this survey, our video page should:

1. **Video first**: The player should dominate the viewport. No distractions above it.
2. **Title and description below**: Concise metadata immediately below the player.
3. **Transcript accessible but not dominant**: Expandable or in a sidebar -- valuable for long videos but shouldn't compete with the video itself.
4. **No sign-up friction**: Everything viewable without an account. No login prompts, no sign-up nudges, no "create an account to comment" barriers.
5. **Fast loading**: The video should start playing as quickly as possible. HLS adaptive streaming handles this naturally.
6. **Minimal chrome**: No reactions, no comments (single-user tool), no CTA buttons, no related videos, no branding beyond what's appropriate for a personal domain. Clean, intentional, fast.
7. **Responsive embed**: `/embed/{slug}` serves just the player. Responsive iframe with 16:9 aspect ratio wrapper.

---

## Non-Obvious Features Worth Considering

### Text-Based Video Editing (Tella)

Edit the transcript and the video cuts correspondingly. Delete a sentence from the transcript, and the video segment containing that sentence is removed. This is a genuinely novel editing paradigm that could be a powerful future feature.

### Speaker Notes During Recording (Tella)

Display talking points or a script on screen during recording, invisible in the final output. Useful for structured content like tutorials and announcements.

### Smart Actions / AI Document Generation (Zight, Kommodo)

Automatically convert a video's transcript into structured documents: meeting notes, SOPs, step-by-step guides, bug reports, follow-up emails. This extends the value of every recording beyond the video itself.

### Automatic Zoom and Cursor Effects (Screen Studio)

Post-recording automatic zoom into areas of activity, smooth cursor movement, and cursor resizing. These make screen recordings dramatically more watchable with zero manual editing effort.

### Request Video (Zight)

Give someone a link where they can record a video and send it to you. Inverts the typical workflow -- instead of you recording for them, they record for you. Interesting for support and feedback scenarios.

### Video Library AI Search (Kommodo)

An AI assistant that can answer questions by searching across your entire video library and linking to the relevant moment in the relevant video. Transforms a video library from a collection of files into a searchable knowledge base.

### Clips-Based Recording (Tella)

Record in segments that can be rearranged and individually re-recorded. Eliminates one-take anxiety for longer, structured content. This maps well to our pause/resume and mode-switching requirements.

### Post-Capture Overlay (CleanShot X)

A small floating widget that appears immediately after capture with the most common actions (copy, save, share, annotate). Much faster than opening a separate window or dialog.

---

## Emerging Competitor: Supercut

Supercut deserves a special mention. It launched relatively recently and is gaining traction as a direct Loom replacement for teams. Key differentiators:

- Native apps (Mac + Windows) built with native code, not Electron.
- One-click auto-editing to clean up recordings.
- Custom branding with multiple layout templates.
- Auto-generated chapters for video navigation.
- Timeline-based commenting (not just below the video, but on the video timeline).
- SOC 2 Type II and ISO 27001 certified (enterprise-ready from day one).
- Instant sharing with public/private links.

Supercut's approach validates several of our design decisions: native apps for performance, instant sharing for async communication, and AI-powered cleanup as a default rather than a premium add-on. It's the product most likely to eat Loom's market share, and its growth should be monitored.

---

## Summary: What We Should Take Away

1. **The recording-to-URL speed is everything.** Loom proved this. Cap validates it. Supercut builds on it. Our streaming upload architecture must make this feel instant.

2. **AI metadata should be automatic, not optional.** Auto-titles, auto-summaries, auto-chapters, auto-transcripts. These should happen on every recording by default, ideally on-device.

3. **The video page should be minimal and fast.** Video, title, description, transcript. Nothing else. No social features, no sign-up prompts. Fast loading, CDN-backed.

4. **The desktop app must be genuinely native.** Loom's Electron jank is a primary motivator for building this. Screen Studio and CleanShot X prove that native macOS apps can feel fast and lightweight. Our Swift app should aim for that standard.

5. **Post-recording UX matters more than people think.** CleanShot X's overlay, Loom's auto-copy, Cap's AI metadata -- these small touches after recording stops define how the tool feels in daily use.

6. **Unfurling is a layered problem.** OG tags for basic coverage, oEmbed for rich embeds, platform-specific integrations for best results. Plan for all three layers from the start.

7. **Mode switching during recording is our key differentiator.** No tool does this well today. Loom can toggle camera on/off. Tella can switch layouts. Neither supports full mode switching (camera-only to screen+camera to screen-only) during a single recording. Getting this right is our biggest opportunity.

---

## Sources

- [Cap.so](https://cap.so) -- homepage, pricing, features, documentation
- [Cap Documentation](https://cap.so/docs) -- recording modes, keyboard shortcuts, embeds, sharing
- [Cap GitHub](https://github.com/CapSoftware/Cap) -- 17.6k stars, open source
- [Screen Studio](https://www.screen.studio/) -- homepage, features
- [Screen Studio Pricing Research](https://matte.app/blog/screen-studio-review) -- subscription model, discontinued one-time license
- [Tella](https://www.tella.tv/) -- homepage, features, clips-based recording
- [Tella Pricing](https://efficient.app/apps/tella) -- Pro and Premium plans
- [Supercut](https://supercut.video/) -- homepage, features
- [Supercut Review](https://efficient.app/apps/supercut) -- features, pricing, positioning
- [Airtime / mmhmm](https://www.airtime.com/) -- rebrand announcement, features, pricing
- [Zight](https://zight.com/) -- homepage, features, Smart Actions
- [Berrycast](https://www.berrycast.com/) -- features, pricing via G2/Capterra
- [CleanShot X](https://cleanshot.com/) -- features page, pricing, cloud sharing
- [Vidyard](https://www.vidyard.com/) -- homepage, AI video selling focus
- [Kommodo / Komodo Decks](https://komododecks.com/) -- homepage, AI features
- [Efficient App: Best Screen Recording Apps 2026](https://efficient.app/best/screen-recording) -- comparison and rankings
- [Loom Support: Auto titles, summaries, chapters](https://support.loom.com/hc/en-us/articles/15509755870621)
- [Loom Support: Custom branding](https://support.atlassian.com/loom/docs/configure-custom-branding-for-your-videos/)
- [Loom Support: Embedding](https://support.loom.com/hc/en-us/articles/360002208317)
- [Supademo: Loom Pricing in 2026](https://supademo.com/blog/loom-pricing) -- post-Atlassian changes
- [Supademo: Loom Alternatives 2026](https://supademo.com/blog/loom-alternatives) -- stability issues, migration pain
