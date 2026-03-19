# Research: Server & Admin Stack Options

## Priority

Tier 2 — The scope of the server depends heavily on Task 04 (Build vs Buy). If we use a managed video service, the server becomes a thin metadata/admin layer. If we self-host video processing, it's significantly more complex. Either way, we need a server.

## Context

The server has several responsibilities: receive video uploads from the desktop app, manage video metadata (titles, slugs, tags, visibility), serve an admin web interface, and (potentially) process and encode video. It also serves the public-facing video pages and handles URL routing (including slug redirects). Read `requirements.md` for full project context, particularly "Processing & Management Requirements" and "Admin Web Interface."

This is a single-user application. There are no team features, no multi-tenancy, no complex auth. The admin is one person. The server's job is to be reliable and simple, not scalable to thousands of users.

## Key Questions

### Language & Framework

- What language/framework makes sense for a single-user video management server?
- **Go** — Simple, fast, good standard library, excellent for APIs. Minimal dependencies. Good for long-running processes (video processing workers).
- **Node.js / TypeScript** — Familiar ecosystem, huge package library, good for web UIs (Next.js, Remix, etc.). But: single-threaded, not ideal for CPU-heavy video processing.
- **Python (Django/FastAPI)** — Rapid development, good admin frameworks (Django Admin is excellent for this kind of thing). Slower runtime.
- **Ruby (Rails)** — Rapid development, conventions for admin UIs, Active Storage for file handling. Similar to Django in tradeoffs.
- **Rust** — Fast, safe. But: slower development, overkill for an admin interface.
- What does Cap use for their server? What does Loom use?
- Is there a strong reason to match the desktop app's ecosystem (Swift on server with Vapor)?

### Database

- **SQLite** — Simplest possible option for a single-user app. No separate database server. Good enough? Are there limitations for our use case?
- **PostgreSQL** — The standard. More operational overhead than SQLite but more capable.
- Do we need full-text search (for video titles/descriptions/transcripts)? If so, does that push us toward Postgres?
- What schema do we need? (Videos, slugs/redirects, tags, transcripts — it's not complex.)

### Admin Interface

- Do we build a custom admin UI, or use a framework that provides one?
- **Django Admin** — Gets you a functional admin with minimal code. Might be enough.
- **Rails ActiveAdmin / Administrate** — Similar.
- **Custom React/Next.js UI** — More flexibility, more work.
- **Retool / Tooljet** — Low-code admin panels. Overkill?
- What's the minimum viable admin UI? (List videos, edit metadata, copy URL, delete, upload.)

### Job Queue / Processing

- If we self-host video processing, we need a reliable job queue.
- **Options**: Sidekiq (Ruby), Celery (Python), Bull (Node), Temporal, or just a simple database-backed queue.
- How do we handle failed jobs? Retries? Dead letter queue?
- If we use a managed video service, do we still need a job queue? (Maybe for webhook processing, thumbnail generation, etc.)

### API Design

- What API does the desktop app need? (Upload segments, finalise recording, get upload credentials.)
- What API does the admin UI need? (CRUD for videos, search, tag management.)
- REST? GraphQL? Something simpler?
- Authentication — what's the simplest secure auth for a single-user app? (API key for desktop app, session-based for admin UI?)

### Deployment

- Where do we deploy? (VPS, container service, PaaS?)
- How simple can we make deployment and updates?
- Do we need Docker, or can we deploy a single binary?

## Research Approach

- Evaluate each language/framework option against our specific requirements: simplicity, reliability, ability to handle video file operations, admin UI generation.
- Look at what similar single-user or small-scale video tools use for their server stack.
- Consider developer experience — this needs to be maintainable by one person with AI assistance.
- Weight simplicity and reliability heavily. This is not a startup — we don't need to optimise for team scaling.

## Expected Output

A research document that:

1. Evaluates 3-4 realistic stack options (language + framework + database + deployment).
2. Considers both scenarios: managed video service (thin server) and self-hosted processing (thicker server).
3. Recommends a stack with clear reasoning.
4. Outlines the basic architecture: API endpoints, database schema sketch, job processing approach.
5. Addresses deployment and operational simplicity.
6. Considers how the choice integrates with the desktop app (upload API) and viewer-facing pages.

## Related Tasks

- Task 04 (Build vs Buy) — directly determines the server's scope and complexity.
- Task 05 (Video Processing & Encoding) — if self-hosting, the server needs to run FFmpeg and manage a processing pipeline.
- Task 08 (Viewer Experience) — the server likely serves (or generates) the public-facing video pages.
