# AI Agent Instructions

## About This Project

Building a personal Loom replacement — a native macOS recording app, backend server, and CDN-backed video delivery system. Self-hosted on Hetzner + Cloudflare R2. See `requirements.md` for full context.

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

## Probable Architecture

Three layers: a native macOS desktop app for recording, a server for processing and management, and a viewer layer that operates independently of the server.

- macOS Desktop App (Swift & SwiftUI)
- Server (Hono + Bun + SQLite, Hetzner)
- Viewer Layer (Cloudflare Workers + KV)

## Project Structure

```
├── app                                   # macOS Menubar app
│   ├── LoomClone
│   │   ├── App/
│   │   ├── Capture/
│   │   ├── Helpers/
│   │   ├── Info.plist
│   │   ├── Models/
│   │   ├── Pipeline/
│   │   └── UI/
├── docs
│   ├── archive                           # Archived docs
│   │   └── initial-requirements.md.      # Original Requirements before refinement
│   ├── plan-notes.md
│   ├── requirements.md                   # Refine overall requirements docs for whole system
│   ├── research/                         # Research Notes
│   ├── tasks-done/                       # Completed tasks
│   └── tasks-todo/                       # Uncompleted tasks
├── README.md
└── server                                # Hono Server
    ├── data                              # Data for each recording
    ├── src
    │   ├── index.ts
    │   ├── lib
    │   └── routes
    └── tsconfig.json
```
