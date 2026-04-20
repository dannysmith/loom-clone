# Task 2c: Deploy LoomClone to VPS + CI/CD

Connect the dockerised loom-clone server (from Task 2a) to the VPS infrastructure (from Task 2b). Set up GitHub Actions to auto-deploy on push to `main`.

## Prerequisites

- Task 2a complete: `server/Dockerfile` and `server/docker-compose.yml` exist and work locally
- Task 2b complete: Hetzner VPS running with Docker, Caddy, shared `caddy-net` network, storage volume mounted

## What to Build

### Production `docker-compose.yml` adjustments

The `server/docker-compose.yml` from Task 2a is designed for local dev. For production, we need:

- Join the shared `caddy-net` network (so Caddy can reach the container)
- Container name: `loom-clone-server` (what the Caddyfile references)
- Mount the storage volume path (e.g., `/mnt/data/loom-clone/`) instead of local `./data`
- Set `HOST=0.0.0.0`, `PUBLIC_URL=https://v.danny.is`
- Set the API key (or mount a secrets file)
- Restart policy: `unless-stopped`
- No port mapping needed (Caddy proxies via the Docker network, not host ports)

Options for handling dev vs prod:
- A `docker-compose.prod.yml` override file (used with `docker compose -f docker-compose.yml -f docker-compose.prod.yml up`)
- Or a simple env-var-driven approach where the compose file works for both (using `${VARIABLE:-default}` syntax)
- Pick whichever is cleaner.

### Caddy config update (in danny-vps-infra)

Add to the Caddyfile:

```
v.danny.is {
    reverse_proxy loom-clone-server:3000
}
```

Restart Caddy to pick it up.

### DNS

- Create an A record for `v.danny.is` pointing to the VPS IP (on DNSimple)

### GitHub Actions workflow (`.github/workflows/deploy.yml`)

Trigger: push to `main` with changes in `server/`

Steps:
1. Checkout
2. Run tests: `cd server && bun install && bun run check && bun run typecheck && bun test`
3. If green: SSH into VPS, pull latest, rebuild and restart the container

The deploy step is roughly:
```bash
ssh deploy@<vps-ip> "cd /opt/loom-clone && git pull && cd server && docker compose up -d --build"
```

Needs:
- SSH private key stored as a GitHub Actions secret
- The VPS has the repo cloned at `/opt/loom-clone` (or wherever)
- The deploy user has Docker permissions

### First deploy

- Clone this repo on the VPS at the agreed location
- Create `.env` with production values (`PUBLIC_URL`, API key, etc.)
- `docker compose up -d --build`
- Verify: `curl https://v.danny.is/api/health` returns OK
- Test a recording from the macOS app pointed at `https://v.danny.is`

## Acceptance Criteria

- `https://v.danny.is/api/health` returns `{ "ok": true, ... }` with valid TLS
- Recording from the macOS app against `https://v.danny.is` works end-to-end (upload segments, complete, derivatives generated, video playable)
- Pushing a change to `server/` on `main` triggers the GitHub Actions workflow
- If tests pass, the new version is automatically deployed and running within a couple of minutes
- The container auto-restarts on crash or VPS reboot (`unless-stopped` + Docker daemon restart policy)
- Video data persists on the storage volume (survives container rebuild)

## Notes

- No staging environment for now. Push to main = deploy to production. Acceptable for a single-user tool.
- Keep an eye to future CDN integration — the current setup serves video directly from the VPS. When a CDN layer is added later, Caddy config or DNS would change, but the server itself wouldn't.
- The macOS app's server URL setting (from task 1) will need updating to point at `https://v.danny.is` once this is live.
- Consider: should the GitHub Actions workflow also rebuild if the Dockerfile itself changes? Probably yes — the trigger should be `paths: ['server/**']`.
