# Task 2a: Dockerise the Server

Containerise the Hono/Bun server so it can run locally via Docker (alongside bare `bun run dev` for fast iteration) and is ready to deploy to a VPS.

## Context

- The server is a Bun + Hono app that receives HLS segments, stores video on disk, generates derivatives via ffmpeg, and serves viewer pages.
- It uses SQLite (file-based, at `data/app.db`) and stores video files in `data/<video-id>/`.
- In production, `data/` will live on a mounted Hetzner Storage Volume — but for local Docker, a bind mount to `./data` is fine.
- This is the first step toward deploying to a Hetzner VPS where multiple services will run in separate Docker Compose stacks behind a shared Caddy reverse proxy.

## What to Build

### `server/Dockerfile`

- Base image: `oven/bun` (Debian-based, so ffmpeg is easy to install)
- Install ffmpeg & ffprobe via apt
- Copy `package.json` + `bun.lock`, run `bun install --frozen-lockfile` (layer caching)
- Copy source
- Expose port 3000
- Entrypoint: `bun run src/index.ts`
- Keep it simple — no multi-stage build needed, the image is already small

### `server/docker-compose.yml`

- Single service: `loom-clone-server`
- Build context: `.` (relative to `server/`)
- Bind mount `./data` to the container's working `data/` directory
- Environment variables from `.env` (or `env_file: .env`)
- Port mapping: `3000:3000` for local access
- Include a commented-out `networks:` block showing how to join the shared Caddy network in production (so Task 2c has a clear starting point)

### `server/.dockerignore`

- `node_modules/`, `data/`, `.env`, `.DS_Store`, `*.db`, `*.db-wal`, `*.db-shm`

### Production-readiness considerations

- `HOST` must be `0.0.0.0` inside the container (not `127.0.0.1`) so Docker can route traffic in. The `docker-compose.yml` should set this.
- `PUBLIC_URL` will be set to `https://v.danny.is` in production. For local Docker, leave it unset (falls back to `http://localhost:3000`).
- The `data/` directory must be writable by the container user. The default `oven/bun` image runs as `bun` (uid 1000). The bind mount should work fine locally; for production, the storage volume permissions need to match.

## Acceptance Criteria

- `cd server && docker compose up --build` starts the server successfully
- `curl http://localhost:3000/api/health` returns `{ "ok": true, ... }`
- Recording a video from the macOS app against `localhost:3000` works (segments land in `./data/`, derivatives are generated, video is playable at `http://localhost:3000/<slug>`)
- `docker compose down` stops cleanly, data persists in `./data/` for next run
- Bare `bun run dev` still works exactly as before (Docker is additive, not a replacement)

## Notes

- User runs OrbStack locally for Docker.
- This task does NOT include deploying to the VPS — that's Task 2c.
- This task does NOT include Caddy, TLS, or networking with other services — that's Task 2b/2c.
