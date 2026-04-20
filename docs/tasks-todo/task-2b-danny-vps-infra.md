# Task 2b: danny-vps-infra — VPS Infrastructure Setup

Set up a new Hetzner VPS with Docker, Caddy (reverse proxy + auto-TLS), and shared networking so multiple services can be deployed independently behind it. This task is self-contained and can be worked on in its own repo (`danny-vps-infra`) in a separate session.

## Context

- This is the foundation for running multiple personal services on a single Hetzner VPS: a loom-clone video server (at `v.danny.is`), and potentially other unrelated services in the future (n8n, custom tools, etc.), each on their own subdomain.
- Each service will live in its own repo with its own `Dockerfile` and `docker-compose.yml`. Services connect to Caddy via a shared Docker network.
- Caddy handles TLS termination (Let's Encrypt), reverse proxying, and routing by domain/subdomain.
- DNS for `danny.is` is managed on DNSimple. We're not using Cloudflare's proxy — just pointing A records directly at the VPS.

## Hetzner Setup

- **VPS**: CX22 (2 vCPU, 4GB RAM, 40GB disk, ~€4.50/month). Start small, upgrade later if needed.
- **Storage Volume**: Attach a Hetzner Storage Volume for persistent data (video files, databases). Mounted at something like `/mnt/data`. Survives VPS destruction, can be moved to a bigger box later.
- **Datacenter**: Pick one (Falkenstein, Nuremberg, or Helsinki — doesn't matter much, but Falkenstein is the cheapest).
- **OS**: Ubuntu 24.04 LTS (or latest LTS at time of setup).

## What to Build (in the `danny-vps-infra` repo)

### `setup.sh`

One-time bootstrap script to configure a fresh Ubuntu VPS. Should be idempotent (safe to re-run). Follow the structure and patterns from `~/dev/mc-infra/setup.sh` (pre-flight checks, numbered sections, summary output, idempotent guards). Key differences from mc-infra: no nginx (Caddy replaces it and handles TLS automatically), no certbot/acme-dns, no Java/minecraft stuff.

Covers:

- Pre-flight checks (must be root, correct OS)
- System updates (`apt update && apt upgrade`)
- Create the deploy user with sudo + SSH keys copied from root (same pattern as mc-infra)
- SSH hardening (disable root login, disable password auth)
- Timezone to UTC
- Install apt packages: `curl wget jq htop tmux git unzip tree ufw fail2ban unattended-upgrades apt-listchanges`
- Install Docker Engine (official Docker apt repo, not snap) + Docker Compose plugin
- Docker daemon.json with log rotation (10m x 3 — prevents log bloat)
- Add the deploy user to docker group
- Create the shared Docker network: `docker network create caddy-net`
- UFW firewall: allow 22, 80, 443; deny everything else
- fail2ban SSH jail
- unattended-upgrades (automatic security patches)
- Mount the storage volume at `/mnt/data` (add to `/etc/fstab` for persistence across reboots)
- Install user-level tools for the deploy user: GitHub CLI, Bun, Claude Code
- Configure bash environment (use `configure-bash.sh` pattern from mc-infra — Ghostty TERM support, git prompt, history size)
- Summary output showing installed versions + next steps

### `caddy/docker-compose.yml`

- Caddy service using the official `caddy:2` image
- Mounts `./Caddyfile` and a persistent `caddy_data` volume (for TLS certificates)
- Exposes ports 80 and 443
- Joins the `caddy-net` network (external)
- Restart policy: `unless-stopped`

### `caddy/Caddyfile`

Initial config with a hello-world site:

```
server.danny.is {
    respond "Hello from danny-vps-infra"
}
```

When loom-clone is added later (Task 2c), a new block gets added:

```
v.danny.is {
    reverse_proxy loom-clone-server:3000
}
```

Each new service is just another block + container name on the shared network.

### `README.md`

Document:
- What this repo is and how the multi-service architecture works
- How to run `setup.sh` on a fresh VPS
- How to add a new service (short checklist)
- DNS requirements (what A records to create)

## DNS

- Create an A record for `server.danny.is` pointing to the VPS IP (on DNSimple)
- Later (Task 2c): Create an A record for `v.danny.is` pointing to the same VPS IP

## Acceptance Criteria

- Fresh Hetzner CX22 is provisioned with Ubuntu 24.04 + storage volume attached
- `setup.sh` has been run successfully (Docker installed, shared network created, firewall configured, volume mounted)
- Caddy is running via `docker compose up -d` in the `caddy/` directory
- `https://server.danny.is` returns "Hello from danny-vps-infra" with a valid Let's Encrypt certificate
- The storage volume is mounted and writable at the expected path
- `docker network ls` shows the `caddy-net` network

## Notes

- This task doesn't touch loom-clone at all — it's purely infrastructure.
- Keep the setup script simple and readable. It's a personal VPS, not a fleet.
- Consider whether we want SSH key-based deploys (for GitHub Actions in Task 2c) configured here, or if that belongs in Task 2c. Probably here — the deploy user + authorized key is part of "setting up the box."
- Reference: `~/dev/mc-infra/setup.sh` and `~/dev/mc-infra/configure-bash.sh` are the primary pattern references. Same structure (numbered sections, idempotent, clear output), adapted for this box's purpose.
- Caddy's auto-TLS is a major simplification over the mc-infra approach (which uses nginx + certbot + acme-dns). No cert scripts needed — Caddy handles Let's Encrypt challenge + renewal automatically as long as ports 80/443 are reachable and DNS points to the box.
