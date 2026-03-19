# AI Agent Instructions

## About This Project

Research and experimentation towards building a personal Loom replacement — a native macOS recording app, backend server, and CDN-backed video delivery system. See `requirements.md` for full context.

## Important Files

- `requirements.md` — The current product requirements. Read this at the start of every session for project context.
- `docs/research/` — Research documents (Loom analysis, video hosting research).
- `docs/archive/initial-requirements.md` — The original requirements doc before refinement. Kept for reference only.

## Skills

Always load the `obsidian:defuddle` skill at the start of a session.

## Web Content Fetching

When fetching content from web pages (documentation, articles, blog posts, etc.), use `defuddle parse <url> --md` instead of `curl` or `WebFetch`. Defuddle strips navigation, ads, and clutter from HTML pages and returns clean markdown, which uses far fewer tokens.

Use `WebFetch` only when you need a high-level summary of a page rather than its full content, or when dealing with non-HTML resources (JSON APIs, raw files, etc.).
