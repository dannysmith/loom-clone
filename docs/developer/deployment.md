# Deployment

The server runs in a Docker container on a Hetzner VPS, behind a Caddy reverse proxy that handles TLS. Viewer-facing traffic reaches it through BunnyCDN at `https://v.danny.is`.

## Why Docker

The VPS hosts multiple unrelated services (not just loom-clone), each in its own Docker Compose stack. Docker gives us clean isolation between services, independent deploys, and a single shared Caddy instance that routes traffic by hostname. The alternative — running everything bare-metal with systemd units — gets messy once you have more than one or two things on the same box.

## Architecture

```
Viewers → BunnyCDN (edge cache) → Caddy (TLS + reverse proxy) → loom-clone-server (:3000)
                                                               → other services...
```

- **BunnyCDN** is a pull-through CDN in front of the origin. `v.danny.is` CNAMEs to BunnyCDN; BunnyCDN fetches from the origin at `https://origin.v.danny.is`. It caches all viewer-facing routes and bypasses cache for `/api/*` and `/admin/*` (via Edge Rules). "Optimize for large object delivery" is enabled (5MB cache slicing for video seeking). The server purges CDN cache on video state changes via `src/lib/cdn.ts`.
- **Caddy** runs in its own Docker Compose stack, managed by the [danny-vps-infra](https://github.com/dannysmith/danny-vps-infra/blob/main/README.md) repo. It terminates TLS via Let's Encrypt and routes `origin.v.danny.is` to the `loom-clone-server` container over a shared Docker network (`caddy-net`).
- **loom-clone-server** runs in its own Docker Compose stack from this repo. It joins `caddy-net` so Caddy can reach it, but doesn't expose any ports to the host directly.
- **Video data** lives on a Hetzner Storage Volume mounted at `/mnt/data`. The container bind-mounts `/mnt/data/loom-clone` to its internal `data/` directory. This volume survives container rebuilds and can be detached and moved to a different VPS if needed.

The VPS setup (Docker, firewall, shared network, Caddy) is documented in the [danny-vps-infra README](https://github.com/dannysmith/danny-vps-infra/blob/main/README.md).

## Docker Compose files

The server has three compose files in `server/`:

| File | Purpose |
| --- | --- |
| `docker-compose.yml` | Base: build context, container name, env vars, restart policy |
| `docker-compose.override.yml` | Local dev: port mapping (`3000:3000`), bind mount to `./data` |
| `docker-compose.prod.yml` | Production: joins `caddy-net`, mounts storage volume, sets `PUBLIC_URL` and `BUNNY_CDN_API_KEY` |

**Locally**, just `docker compose up --build` works — Docker Compose auto-loads the override file. This is useful for verifying the container builds and runs, but isn't needed for day-to-day development. Bare `bun run dev` is faster for iterating.

**On the VPS**, the production override is specified explicitly:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

## CI/CD

`.github/workflows/deploy.yml` runs on every push to `main` that touches `server/**`:

1. **Test job**: installs deps, runs `bun run check` (lint + format), `bun run typecheck`, and `bun test`
2. **Deploy job** (only if tests pass): SSHs into the VPS as the configured deploy user, pulls latest, rebuilds and restarts the container

The whole pipeline takes ~40 seconds.

### GitHub Actions secrets

| Secret | Value |
| --- | --- |
| `VPS_HOST` | The VPS IPv4 address |
| `VPS_SSH_USER` | The system username on the VPS that owns the deploy key |
| `VPS_SSH_KEY` | A dedicated ed25519 private key (no passphrase) that can SSH as that user |

The corresponding public key lives in `~/.ssh/authorized_keys` of the deploy user on the VPS. This is a purpose-specific key — not a personal SSH key used for other things.

## Setting up from scratch

If the VPS dies or you need to recreate this setup:

1. **Provision infrastructure** following the [danny-vps-infra README](https://github.com/dannysmith/danny-vps-infra/blob/main/README.md) — new VPS, storage volume, run `setup.sh`, start Caddy.

2. **Point DNS** (on DNSimple):
   - `origin.v.danny.is` → A record → VPS IP (Caddy origin hostname)
   - `v.danny.is` → CNAME → `<zone>.b-cdn.net` (BunnyCDN pull zone)

3. **Clone this repo on the VPS**:
   ```bash
   git clone https://github.com/dannysmith/loom-clone.git ~/loom-clone
   ```

4. **Create the data directory** on the storage volume:
   ```bash
   sudo mkdir -p /mnt/data/loom-clone
   sudo chown "$USER:$USER" /mnt/data/loom-clone
   ```

5. **Create `server/.env`** on the VPS:
   ```bash
   cat > ~/loom-clone/server/.env <<'EOF'
   PUBLIC_URL=https://v.danny.is
   ADMIN_USERNAME=<choose a username for the admin web panel>
   ADMIN_PASSWORD=<choose a long password and save it somewhere>
   SESSION_SECRET=<generate with: openssl rand -base64 48>
   BUNNY_CDN_API_KEY=<from BunnyCDN dashboard: Account → Settings → API Keys>
   EOF
   ```

6. **Start the container**:
   ```bash
   cd ~/loom-clone/server
   docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
   ```

7. **Generate an API key** for the macOS app:
   ```bash
   docker compose -f docker-compose.yml -f docker-compose.prod.yml exec loom-clone-server bun run keys:create "macbook"
   ```

8. **Add `origin.v.danny.is` to the Caddyfile** (in `~/danny-vps-infra/caddy/Caddyfile`):
   ```
   origin.v.danny.is {
       reverse_proxy loom-clone-server:3000
   }
   ```
   Then restart Caddy: `cd ~/danny-vps-infra/caddy && docker compose restart caddy` (restart, not reload — bind-mounted files need a container restart to pick up inode changes from git pull).

9. **Set up CI/CD**: generate a deploy SSH key (`ssh-keygen -t ed25519 -C "github-actions-deploy" -f ~/.ssh/loom-clone-deploy`), add the public key to `~/.ssh/authorized_keys` of the deploy user on the VPS, then add three GitHub repo secrets: `VPS_HOST` (the VPS IP), `VPS_SSH_USER` (the deploy user), and `VPS_SSH_KEY` (the private key).

10. **Set up BunnyCDN** pull zone with origin `https://origin.v.danny.is`, enable "Optimize for large object delivery" and "Serve stale while origin offline", add Edge Rules to bypass cache for `/api/*` and `/admin/*`, add `v.danny.is` as a custom hostname, and activate SSL. See `docs/tasks-todo/task-1-view-layer.md` for the full setup details.

11. **Verify**: `curl https://v.danny.is/api/health` and `curl -I https://v.danny.is/<any-slug>` (should show BunnyCDN headers).
