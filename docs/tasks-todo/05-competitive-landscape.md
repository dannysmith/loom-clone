# Research: Competitive Landscape & UX Patterns

## Priority

Tier 1 — Product research that runs in parallel with the technical feasibility work. Understanding the competitive landscape and UX patterns is as foundational as understanding the APIs — the whole reason we're building this is UX dissatisfaction with existing tools, so studying what works and what doesn't should inform technical decisions from the start, not follow them.

## Context

We're building a personal video recording and sharing tool. Loom is the most direct comparison, but there are many other tools in this space — each with different strengths, tradeoffs, and design choices. Read `requirements.md` for full project context. Our existing Loom research is at `docs/research/loom-research.md`.

We already know Loom and Cap well. The primary value here is surveying what *else* exists — other tools and approaches we might not be aware of — and studying the publicly visible aspects of all these tools: feature sets, video page designs, embedding, link previews. This is a practical survey to inform our own design, not formal market research.

## Products to Evaluate

### Primary (deep look)

- **[Loom](https://www.loom.com)** — The industry standard for async video. We already have initial research; this should expand on UX patterns and pain points specifically.
- **[Cap](https://cap.so)** — Open source, closest to what we're building. Focus on their UX and viewer experience (the codebase is covered separately in Task 03).
- **[Screen Studio](https://www.screen.studio/)** — Mac-native screen recorder known for beautiful output (automatic zoom effects, smooth cursor tracking). Not a sharing platform, but excellent recording UX.
- **[Tella](https://www.tella.tv/)** — Browser-based recording with a focus on presentation-style videos. Interesting UX choices.

### Secondary (lighter evaluation)

- **[mmhmm](https://www.mmhmm.app/)** — Virtual camera / presentation tool. Different use case but interesting PiP and mode-switching UX.
- **[Zight (formerly CloudApp)](https://zight.com/)** — Screenshots and screen recordings for quick sharing. Good "speed of sharing" UX.
- **[Berrycast](https://www.berrycast.com/)** — Screen recording with instant sharing. Simpler tool, worth a quick look.
- **[Vidyard](https://www.vidyard.com/)** — More enterprise/sales-focused, but has good recording and sharing UX.
- **[CleanShot X](https://cleanshot.com/)** — Screenshot tool, not video. But their "instant share via link" flow is excellent and relevant to our UX goals.
- **[Komodo Decks](https://komododecks.com/)** — Screen recording for documentation/tutorials.

### Video Pages & Players (study the viewer experience)

- How does each tool's video page look and feel?
- How fast does the video load and start playing?
- What information is shown alongside the video?
- What does the embed experience look like?

## Key Questions

### Recording UX

- How does each tool handle the "start recording" flow? How many clicks/steps from intent to recording?
- How do they handle input selection (camera, mic, screen)?
- Which tools support mode switching during recording? How does it work?
- How do they handle PiP (camera overlay on screen recording)? Positioning, sizing, shape?
- How do they handle pause/resume?
- What keyboard shortcuts do they offer?
- What does the recording UI look like? (Menu bar? Floating toolbar? Full window?)

### Sharing UX

- How quickly is a URL available after recording stops?
- What's the "recording stopped → URL on clipboard" flow like?
- Do any tools show a post-recording dialog for editing title/slug before sharing?
- How do links unfurl in Slack, Notion, etc.?

### Video Page Design

- What elements appear on each tool's video page? (Player, title, description, transcript, CTA buttons, branding?)
- What's the page layout? Player sizing? Responsive behaviour?
- How does the player behave? (Autoplay? Controls? Quality selector? Playback speed? Subtitles?)
- What's the loading/buffering experience like?

### Management & Organisation

- How do these tools handle video libraries? (List view, grid view, search, filters, folders, tags?)
- What metadata can you edit? (Title, description, thumbnail, URL?)
- How do they handle video deletion, archiving, or privacy settings?

### Patterns Worth Stealing

- What UX patterns are particularly good across these tools?
- What's consistently annoying or poorly done?
- Are there any non-obvious features that significantly improve the experience?

## Research Approach

- For all products: study their marketing sites, feature pages, documentation, and pricing to understand capabilities and positioning.
- For video pages: find publicly shared video URLs and inspect them — page structure, meta tags (OG, Twitter Card), embed behaviour, player features.
- For recording UX: study product documentation, feature comparison pages, review articles, and product walkthrough videos to understand recording capabilities and UI patterns.
- For open-source tools (Cap, etc.): check their GitHub repos for architecture context, feature completeness, and community activity.
- Look for comparison articles, reviews, and "best screen recorder" roundups to surface tools not on our list.

## Expected Output

A research document that:

1. Profiles each evaluated product with its strengths, weaknesses, and notable UX patterns.
2. Identifies the best-in-class UX for each part of the workflow (recording, sharing, viewing, managing).
3. Lists specific patterns we should adopt, with reasoning.
4. Lists specific anti-patterns we should avoid, with reasoning.
5. Includes notes on video page designs and what works visually.
6. Highlights any non-obvious features or approaches worth considering.

## Related Tasks

- Task 09 (Viewer Experience) — competitive video pages directly inform our viewer experience design.
- Task 10 (Open Source Video Platforms) — some of these tools may have open-source components.
