# Research: Cap Codebase Analysis

## Priority

Tier 1 — Cap has attempted to solve many of the same problems we're tackling. A thorough analysis of their codebase can inform our approach across multiple areas and help us avoid repeating their mistakes.

## Context

[Cap](https://github.com/CapSoftware/Cap) is an open-source screen recording and sharing tool. It has a Tauri-based desktop app (Rust + web frontend), a server for video hosting, and a web-based viewer. It's the closest open-source project to what we're building. Read `requirements.md` for full project context, so you understand what we're trying to achieve and can evaluate Cap's approach against our requirements.

The Cap codebase is available locally at `~/dev/Cap/`.

**Important**: This is not a surface-level overview. We need a deep read of the actual code — particularly the recording pipeline, upload mechanism, and server-side video handling. The goal is to understand what works, what's broken or hacky, and what lessons we can extract.

## Key Areas to Investigate

### Desktop App — Recording Pipeline

- How does Cap capture screen, camera, and microphone? What native APIs do they use under the Rust/Tauri bridge?
- How do they handle the capture pipeline? Is it a single pipeline or multiple coordinated pipelines?
- How do they composite the camera overlay (PiP) onto screen recordings?
- Can they switch recording modes mid-recording? If so, how? If not, what's their approach?
- How do they handle pause/resume?
- What output format do they produce? Do they write segments during recording, or a single file?

### Desktop App — Upload During Recording

- Does Cap stream video to the server during recording, or upload after recording stops?
- If streaming: what format are segments in? What upload protocol? How do they handle the playlist?
- If post-recording: how long does the upload take? How does this affect the "instant URL" experience?
- How do they handle network interruptions during upload?

### Server — Video Receiving & Processing

- What's the server stack? (Language, framework, database.)
- How does the server receive uploaded video?
- What processing does the server do? (Transcoding, HLS rendition generation, thumbnail creation?)
- What encoding settings do they use? What tools (FFmpeg, etc.)?
- How reliable is the processing pipeline? Is there error handling and recovery?

### Server — Storage & Delivery

- Where do they store videos? (Local disk, S3, R2, other?)
- How do they serve videos to viewers? Direct from server, or via CDN?
- What's their approach to the video page (viewer-facing)?
- How do they handle embedding and link previews?

### Architecture & Code Quality

- What's the overall architecture? How do desktop app, server, and viewer connect?
- Where does the codebase feel solid and well-engineered?
- Where does it feel hacky, broken, or incomplete? (The requirements doc notes Cap "feels half-baked" — what specifically causes that impression?)
- What are the most significant technical debts or limitations?
- Are there any clever solutions or patterns worth adopting?

### Features & Gaps

- What features does Cap have that we want?
- What features does Cap have that we don't want?
- What does Cap lack that we need (particularly: mode switching mid-recording, reliable streaming upload)?

## Research Approach

The Cap codebase is at `~/dev/Cap/`. Start by understanding the project structure:

- `apps/` — likely contains the desktop app and web app
- `crates/` — Rust crates, likely including the core recording logic
- Look for a Tauri configuration (tauri.conf.json) and Rust source files related to capture/recording
- Look for server code — could be in `apps/` or a separate directory
- Check their `package.json`, `Cargo.toml`, and any documentation for pointers

Read the actual source code. Don't just look at file names and directory structures — read the implementation of the recording pipeline, the upload mechanism, and the server-side processing. Trace the flow from "user hits record" to "video is playable at a URL."

Also skim their GitHub issues and recent commits for known problems and active development areas.

## Expected Output

A research document structured around the key areas above, with:

1. A clear description of Cap's architecture (desktop app, server, viewer).
2. A detailed analysis of their recording pipeline — how it works, what's good, what's problematic.
3. A detailed analysis of their upload and processing pipeline.
4. A list of specific lessons learned — things to adopt, things to avoid, things to do differently.
5. An assessment of code/approach quality in each area (solid / adequate / problematic).
6. Specific notes on anything relevant to our requirements that Cap handles well or poorly.

## Related Tasks

- Task 01 (macOS Recording APIs) — Cap's native capture code is directly relevant, even though it's Rust rather than Swift.
- Task 02 (Streaming Upload Architecture) — Cap's upload approach is a key comparison point.
- Task 04 (Video Hosting: Self-Hosted vs Managed) — Cap's server infrastructure choices are relevant context.
- Task 08 (Server & Admin Stack) — Cap's server stack is one data point.
