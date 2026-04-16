# AI Agent Instructions

## About This Project

Building a personal Loom replacement — a native macOS recording app, backend server, and video delivery system. See `docs/requirements.md` for full context.

## What This Is

A personal tool for recording, sharing, and hosting video — replacing Loom and Cap. It consists of three parts: a native macOS app for recording, a server for processing and management, and a CDN-backed delivery layer for serving videos to viewers.

This is a single-user tool. There are no team features, no social features, no viewer accounts. One person records videos; other people watch them via URLs.

### Why This Exists

Loom works, but: I don't own my URLs, I can't switch between camera and screen-share mid-recording, the interface is cluttered with features I don't use, Atlassian keeps adding AI bloat, and it costs more than it should for what I need.

Cap is open-source and lets me use my own domain, but it feels half-baked — things break randomly, the codebase feels uncared-for, and it's not something I'd bet my permanent video library on.

I want a tool I control completely, on a domain I own, that does exactly what I need and nothing more.

### How I Use Video

These are the real-world situations this tool needs to serve:

- **Quick Slack replacements** — One-off talking-head videos or quick screenshares shared in Slack in place of a text message. "Hey, here's how you do this." These are fast, often throwaway once the other person has watched them. Speed of recording and sharing is everything.
- **Async announcements and briefings** — Videos that go out in public Slack channels or get embedded in Google Docs and Notion pages. "Pre-brief for the senior leadership meeting" or "Welcoming Sarah to the company." These have a wider audience and a longer shelf life.
- **Document intros** — Short talking-head videos at the top of longer documents, whether internal or external (like client proposals). A personal way of introducing what's in the document below.
- **Evergreen learning content** — Screen shares and talking-head videos embedded in Notion, Google Docs, GitHub docs, and internal knowledge bases. Tutorials, process explanations, "why we do things this way" content. These are permanent — they'll still be in those knowledge bases years from now. Some of these I've historically exported and uploaded to YouTube just to ensure they remain publicly available long-term.
- **Longer assembled videos** — Product demos, detailed tutorials, help documents. These often involve recording multiple segments and assembling them into a single video. With good pause and mode-switching in the desktop app, the need for post-recording assembly is reduced — but it remains a use case for more polished content down the line.

## Architecture Overview

Three components exist today, plus a diagnostic tool:

- **macOS Desktop App** (`app/LoomClone/`) — Swift & SwiftUI menubar app. Captures screen (ScreenCaptureKit), camera (AVCaptureSession), and microphone. Composites frames via CIContext/Metal, encodes to HLS fMP4 segments via AVAssetWriter, streams segments to the server over HTTP during recording. Also writes raw masters (ProRes screen, H.264 camera, AAC audio) locally as a safety net. Actors: `RecordingActor` (orchestration + metronome), `CompositionActor` (Metal rendering), `WriterActor` (HLS encoding), `UploadActor` (segment streaming + healing).
- **Server** (`server/`) — Hono + Bun. Receives HLS segments during recording, assembles playlists, generates MP4 derivatives via ffmpeg after recording completes, and serves the viewer page. Currently also serves static files (segments, derivatives) with Range-request support. `server/data/` holds per-video directories.
- **Viewer Layer** — not yet built as a separate component. Currently the server handles playback directly at `/v/:slug` using Vidstack. Future plan is Cloudflare Workers + KV for CDN-backed delivery.
- **Test Harness** (`app/TestHarness/`, `test-runs/`) — diagnostic tool for probing AVFoundation/VideoToolbox/Metal configurations in isolation, without going through the real recording pipeline. Separate Xcode target (`LoomCloneTestHarness`), not a shipping component. Has its own `README.md` and `CLAUDE.md` with detailed usage instructions.

## Developer Docs

- `docs/developer/streaming-and-healing.md` — how segments flow client → server, what gets written where, and how the post-stop / startup healing works. Read before touching anything in `UploadActor`, `HealAgent`, or `server/src/routes/videos.ts`.
- `docs/requirements.md` — refined requirements for the whole system.
- `docs/research/` — initial research from the project's design phase (pre-prototype). Historical — unlikely to be needed now that the system is built and running.
- `docs/archive/` — incident records and completed research audits. Notable: `m2-pro-video-pipeline-failures.md` documents GPU hang failures on M2 Pro and their resolution.

## Building & Running

A Makefile at `app/Makefile` wraps common commands. Run `cd app && make help` to see all targets. Key ones:

- `make build` — build the main app (Debug)
- `make test` — run unit tests
- `make build-harness` — build the test harness (Debug)
- `make regen` — regenerate Xcode project from `project.yml`
- `make format` — run SwiftFormat on all Swift files
- `make lint` / `make lint-fix` — run SwiftLint / auto-fix violations

Direct commands (for reference or when you need different flags):

- **macOS app**: `xcodebuild -project app/LoomClone.xcodeproj -scheme LoomClone -configuration Debug -destination 'platform=macOS' build`. Do NOT run `bun run dev` or start the dev server unless explicitly asked.
- **Server**: see `server/CLAUDE.md` for scripts (lint, format, typecheck, test, dev) and testing conventions. `cd server && bun run dev` runs the hot-reload server on `http://localhost:3000`.
- **Test harness**: `xcodebuild -project app/LoomClone.xcodeproj -target LoomCloneTestHarness -configuration Debug build`. See `app/TestHarness/README.md` for usage.
- **Xcode project**: `app/project.yml` (XcodeGen) is the source of truth. After editing it, run `cd app && xcodegen generate` (or `make regen`) to regenerate `LoomClone.xcodeproj`.

## Task Management

- Uncompleted tasks live in `docs/tasks-todo/`. Tasks with a number that is or starts with `x` (eg `task-x-thing.md` or `task-x3-thing.md`) are unprioritised.
- Completed tasks are moved to `docs/tasks-done/` and have today's ISO date added to their title so `task-2-thing.md` → `task-2026-01-01-2-thing.md`.
- `task-0-scratchpad.md` is never completed and is a running scratchpad for smaller tasks and checklists. Never edit this file unless specifically asked to - leave that to the user.

## Project Structure

```
├── app/
│   ├── LoomClone/                        # macOS menubar app
│   │   ├── App/                          #   coordinator, app entry
│   │   ├── Capture/                      #   screen, camera, mic capture managers
│   │   ├── Helpers/                      #   timestamp adjuster, preview managers, utilities
│   │   ├── Models/                       #   recording timeline, presets, modes
│   │   ├── Pipeline/                     #   RecordingActor (+extensions), WriterActor, CompositionActor, UploadActor, HealAgent, H264Settings
│   │   └── UI/                           #   SwiftUI views, overlay window, popover
│   ├── TestHarness/                      # diagnostic tool (separate Xcode target)
│   │   ├── Scripts/                      #   tier runner scripts + test-configs/
│   │   ├── Sources/                      #   synthetic frame sources
│   │   ├── Compositor/                   #   isolated CIContext compositor
│   │   ├── Writers/                      #   isolated writer implementations
│   │   ├── Observability/                #   event log, watchdog, system snapshots
│   │   └── README.md                     #   full usage docs
│   ├── LoomCloneTests/                   # XCTest unit tests for pure-logic layers
│   ├── LoomClone.xcodeproj/             # generated — do not edit directly
│   └── project.yml                       # XcodeGen source of truth
├── server/                               # Hono + Bun server (see server/CLAUDE.md)
│   ├── CLAUDE.md                         #   scripts, layout, testing conventions
│   ├── biome.json                        #   lint + format config
│   └── src/
│       ├── index.ts                      #   createApp() factory + entry
│       ├── test-utils.ts                 #   temp-dir test isolation helpers
│       ├── lib/                          #   store, playlist, derivatives, constants — co-located __tests__/
│       └── routes/                       #   /api/videos, /v/:slug, /data/* — co-located __tests__/
├── docs/
│   ├── developer/                        # living developer docs
│   │   └── streaming-and-healing.md
│   ├── tasks-todo/                       # active/upcoming work
│   ├── tasks-done/                       # completed task write-ups
│   ├── research/                         # historical: initial research (pre-prototype)
│   ├── archive/                          # incident records, completed audits
│   └── requirements.md                   # refined system requirements
├── test-runs/                            # test harness output (gitignored except *.md summaries)
├── AGENTS.md                             # this file (also referenced by CLAUDE.md)
└── CLAUDE.md                             # points at AGENTS.md
```
