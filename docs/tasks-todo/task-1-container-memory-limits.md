# Task 1 — Container Memory Limits

## Background

On 2026-06-01 the `loom-clone-server` container ran the box out of RAM (6.7 GiB RSS on a 7.6 GiB host) during post-processing and triggered a **system-wide** kernel OOM kill, taking the whole VPS effectively offline for ~5–10 minutes. Full incident in [issue #40](https://github.com/dannysmith/loom-clone/issues/40); container-level mitigation is [issue #39](https://github.com/dannysmith/loom-clone/issues/39).

The **host-level** hardening (2 GiB swapfile, sshd `MaxStartups` + `OOMScoreAdjust`, Caddy `oom_score_adj`, memory-budget docs) has **already shipped** in `danny-vps-infra`. This task is the remaining piece: give the container its own cgroup memory limit so any future runaway dies inside its own cgroup instead of starving the host.

This is a small, self-contained infra change with no application-code impact. It's first because it's the floor under everything else — and because the swap it relies on now exists.

## The change

Add resource limits to `loom-clone-server` in `server/docker-compose.prod.yml`:

```yaml
services:
  loom-clone-server:
    mem_limit: 5g         # cgroup OOM at 5 GiB — kills only this container's processes
    memswap_limit: 6g     # 1 GiB of swap before the kill (host swapfile now exists)
    mem_reservation: 1g   # soft floor; kernel reclaims from over-reserved cgroups first under host pressure
    pids_limit: 500       # belt-and-braces against fork-storm runaways
```

Rationale for the 5 GiB ceiling (per #39's budget table for the 7.6 GiB host): ~500 MiB kernel/page-cache, ~300 MiB docker/journald/fail2ban, ~200 MiB Caddy, ~600 MiB safety margin → ~5 GiB left for the application container. Revisit if the box grows or gains services.

`restart: unless-stopped` is already present in `docker-compose.yml` — keep it. The intent is that recovery now fires from a **cgroup** OOM (kills only this container, host stays up) rather than a kernel-global OOM.

> `cpus` and cgroup-v2 `memory.high` throttling were considered in #39 and deliberately left out — `mem_limit` + small `memswap_limit` is the simpler win. Don't add them here.

## Deploy & verify

Redeploy on the VPS:

```sh
cd ~/loom-clone/server && docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

Then confirm:

- `docker inspect loom-clone-server --format '{{.HostConfig.Memory}}'` → `5368709120`
- `docker inspect loom-clone-server --format '{{.HostConfig.MemorySwap}}'` → `6442450944`
- `docker inspect loom-clone-server --format '{{.HostConfig.PidsLimit}}'` → `500`
- (Optional) force a leak in a throwaway branch (`while(true) buf.push(Buffer.alloc(1<<20))`) and confirm: the container OOMs and restarts, while SSH, Caddy, and `server.danny.is` stay responsive throughout.
