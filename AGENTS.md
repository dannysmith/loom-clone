# AI Agent Instructions

## About This Project

Building a personal Loom replacement — a native macOS recording app, backend server, and CDN-backed video delivery system. Self-hosted on Hetzner + Cloudflare R2. See `requirements.md` for full context.

## Important Files

- `requirements.md` — Product requirements. Read at the start of every session.
- `docs/plan.md` — Architecture, technology choices, and phased implementation plan. The authoritative technical reference.
- `docs/research/` — 10 research documents from the research phase, plus the architecture synthesis.
- `docs/archive/initial-requirements.md` — Original requirements before refinement. Reference only.

## Skills

Always load the `obsidian:defuddle` skill at the start of a session.

## Web Content Fetching

When fetching content from web pages (documentation, articles, blog posts, etc.), use `defuddle parse <url> --md` instead of `curl` or `WebFetch`. Defuddle strips navigation, ads, and clutter from HTML pages and returns clean markdown, which uses far fewer tokens.

Use `WebFetch` only when you need a high-level summary of a page rather than its full content, or when dealing with non-HTML resources (JSON APIs, raw files, etc.).
