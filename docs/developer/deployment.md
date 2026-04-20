# Deployment

The server runs in a Docker container on a Hetzner VPS, behind a Caddy reverse proxy that handles TLS. It's accessible at `https://v.danny.is`.

## Why Docker

The VPS hosts multiple unrelated services (not just loom-clone), each in its own Docker Compose stack. Docker gives us clean isolation between services, independent deploys, and a single shared Caddy instance that routes traffic by hostname. The alternative — running everything bare-metal with systemd units — gets messy once you have more than one or two things on the same box.

## Architecture

```
Internet → Caddy (TLS + reverse proxy) → loom-clone-server container (:3000)
                                        → other services...
```

- **Caddy** runs in its own Docker Compose stack, managed by the [danny-vps-infra](https://github.com/dannysmith/danny-vps-infra/blob/main/README.md) repo. It terminates TLS via Let's Encrypt automatically and routes `v.danny.is` to the `loom-clone-server` container over a shared Docker network (`caddy-net`).
- **loom-clone-server** runs in its own Docker Compose stack from this repo. It joins `caddy-net` so Caddy can reach it, but doesn't expose any ports to the host directly.
- **Video data** lives on a Hetzner Storage Volume mounted at `/mnt/data`. The container bind-mounts `/mnt/data/loom-clone` to its internal `data/` directory. This volume survives container rebuilds and can be detached and moved to a different VPS if needed.

The VPS setup (Docker, firewall, shared network, Caddy) is documented in the [danny-vps-infra README](https://github.com/dannysmith/danny-vps-infra/blob/main/README.md).

## Docker Compose files

The server has three compose files in `server/`:

| File | Purpose |
| --- | --- |
| `docker-compose.yml` | Base: build context, container name, env vars, restart policy |
| `docker-compose.override.yml` | Local dev: port mapping (`3000:3000`), bind mount to `./data` |
| `docker-compose.prod.yml` | Production: joins `caddy-net`, mounts storage volume, sets `PUBLIC_URL` |

**Locally**, just `docker compose up --build` works — Docker Compose auto-loads the override file. This is useful for verifying the container builds and runs, but isn't needed for day-to-day development. Bare `bun run dev` is faster for iterating.

**On the VPS**, the production override is specified explicitly:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

## CI/CD

`.github/workflows/deploy.yml` runs on every push to `main` that touches `server/**`:

1. **Test job**: installs deps, runs `bun run check` (lint + format), `bun run typecheck`, and `bun test`
2. **Deploy job** (only if tests pass): SSHs into the VPS as the deploy user, pulls latest, rebuilds and restarts the container

The whole pipeline takes ~40 seconds.

### GitHub Actions secrets

| Secret | Value |
| --- | --- |
| `VPS_HOST` | The VPS IPv4 address |
| `VPS_SSH_KEY` | A dedicated ed25519 private key (no passphrase) that can SSH as the deploy user |

The corresponding public key lives in `~/.ssh/authorized_keys` on the VPS. This is a purpose-specific key — not a personal SSH key used for other things.

## Setting up from scratch

If the VPS dies or you need to recreate this setup:

1. **Provision infrastructure** following the [danny-vps-infra README](https://github.com/dannysmith/danny-vps-infra/blob/main/README.md) — new VPS, storage volume, run `setup.sh`, start Caddy.

2. **Point DNS**: A record for `v.danny.is` → VPS IP (on DNSimple).

3. **Clone this repo on the VPS**:
   ```bash
   git clone https://github.com/dannysmith/loom-clone.git ~/loom-clone
   ```

4. **Create the data directory** on the storage volume:
   ```bash
   sudo mkdir -p /mnt/data/loom-clone
   sudo chown $USER:$USER /mnt/data/loom-clone
   ```

5. **Create `server/.env`** on the VPS:
   ```bash
   cat > ~/loom-clone/server/.env <<'EOF'
   PUBLIC_URL=https://v.danny.is
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

8. **Add `v.danny.is` to the Caddyfile** (in `~/danny-vps-infra/caddy/Caddyfile`):
   ```
   v.danny.is {
       reverse_proxy loom-clone-server:3000
   }
   ```
   Then reload: `cd ~/danny-vps-infra/caddy && docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile`

9. **Set up CI/CD**: generate a deploy SSH key (`ssh-keygen -t ed25519 -C "github-actions-deploy" -f ~/.ssh/loom-clone-deploy`), add the public key to `~/.ssh/authorized_keys` on the VPS, add the private key as `VPS_SSH_KEY` and the VPS IP as `VPS_HOST` in GitHub repo secrets.

10. **Verify**: `curl https://v.danny.is/api/health`
