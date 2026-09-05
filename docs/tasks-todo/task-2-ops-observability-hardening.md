# Ops & Observability Hardening

Design + task doc for [#61](https://github.com/dannysmith/loom-clone/issues/61). Comes from §3 and §4 of the [architecture review](../archive/architecture-review-2026-07-28.md). The design decisions below were settled in discussion (2026-09-05); this doc is the record, so implementation phases can run without re-litigating them.

## The problem

The system is designed to survive years of light-touch maintenance, and the core recording loop genuinely does — healing, the convergent segment protocol, and CDN serve-stale are built for unattended operation. What doesn't survive is everything around it, because the system has no way to tell anyone anything. A backup that starts failing is discovered whenever someone next reads a log file. Nothing watches disk on a volume where video data grows forever. A video stuck in `healing` (Mac died mid-heal and never came back) is invisible to every safety net: no timeout sweep, not in the needs-attention filter, skipped by reconcile. A transient ffmpeg failure parks a video in `processing_failed` until someone happens to open the admin panel. Docker can't tell a crash-looping container from a healthy one, and container logs grow without rotation.

One tension shapes the whole design: a self-hosted stack cannot alert on its own death — an alert sent on failure dies with the host. So everything here is self-contained for *observing*, plus exactly one dumb external service whose only job is to notice *silence*.

## Settled decisions

1. **The external touchpoint is healthchecks.io.** Each scheduled job pings a URL on success; if a ping doesn't arrive on schedule, it emails. Alert-on-absence is the only semantics that survives total host failure. Three checks on the free tier: daily backup, weekly restic integrity check, daily self-check. ntfy was rejected (presence-based — can't notice silence); a watchdog cron on another box was rejected (a second pet to keep alive).
2. **The self-check is an endpoint in the server, plus a dumb host cron.** The server owns the knowledge of what "stuck" means (DB, step ledger, data dir), so it does the checking; the cron is two lines of curl. The endpoint returns 200 + JSON when healthy, 503 + a failure list when not. The cron hits it via `https://origin.v.danny.is` so one check exercises Caddy, TLS, the container, and application health together — server down, crash-looping container, broken Caddy, and dead host all collapse into the same missing ping. On failure the response body is POSTed to the check's `/fail` URL so the alert email contains the detail.
3. **One collector, two consumers.** The self-check's data-gathering lives in a lib module; the endpoint serves it as pass/fail for the cron, and the admin settings page renders the same data for humans (disk, loom-clone footprint, container RAM, last backup).
4. **Stuck `healing` videos become `incomplete` after 48 h.** Generous on purpose — a closed laptop over a weekend is legitimate. Safe and reversible: `/complete` already handles a re-complete from `incomplete` (triggers an intake reprocess), so a Mac that comes back after the sweep fired heals cleanly.
5. **`incomplete` and `processing_failed` videos alert until dealt with.** The way to silence the alert is to fix or trash the video. Right incentive for a single-user tool; no acknowledgement machinery.
6. **No automatic processing retry.** The review's advice was to stop growing the pipeline orchestrator. Alerting makes failures loud; manual reprocess already exists in admin.
7. **No 404-rate or error-spike monitoring.** Needs log shipping or counters; the failure classes that actually bite are covered above; BunnyCDN's dashboard has 404 stats if ever wanted.
8. **Deploys keep building on the VPS.** The CI-build-and-registry-pull question (deferred from #60) is answered "not now" — the current setup works and staying self-contained wins. Revisit if VPS build resource pressure ever bites again.
9. **The container runs as non-root.** No infra reason for root was found — it's just the Dockerfile default. The `bun` user in the oven/bun image is uid 1000, which matches `danny` on the VPS, so bind-mounted files come out danny-owned on the host: better for the backup and for manual admin. Needs a one-time `chown` of existing root-owned files (phase 1 confirms current ownership).
10. **Backup gains `chapters.json`; `captions.srt` stays out.** `chapters.json` is user-authored (hand-edited chapter titles) and non-regenerable — the only user data that would be simply gone after a restore. `captions.srt` is regenerable from `words.json` (which is backed up) and stays excluded.
11. **The VPS host dashboard is a separate project** — in danny-vps-infra repo. It's a tool for when someone *is* looking; this task is the safety net for when nobody is. Neither depends on the other.
12. **A rehearsed restore drill stays deferred** (per #61). Recovery needs to be possible, not fast.

### What the self-check checks

| Check                          | Alert when                                    | Notes                                    |
| ------------------------------ | --------------------------------------------- | ---------------------------------------- |
| Stuck `processing`             | older than 30 min since last update           | reuses `STALLED_PROCESSING_MINUTES`      |
| Stuck `recording`              | no segment activity for 4 h                   | mirror of the existing sweep's logic     |
| Stuck `healing`                | in state longer than 48 h                     | sweep also moves it to `incomplete`      |
| `processing_failed` videos     | any exist                                     | decision 5                               |
| `incomplete` videos            | any exist                                     | decision 5                               |
| Disk headroom on `/app/data`   | free space < 5 GiB                            | via `statfs`; volume is 20 GiB, resizable |
| CDN purge config               | `NODE_ENV=production` and no `BUNNY_CDN_API_KEY` | neutralises the compose interpolation trap |

Backup age is deliberately *not* a self-check item: the backup cron gets its own healthchecks.io check, and the schedule + grace mechanism does "no successful backup in N days" natively. The settings page still shows last-backup time via a marker file (phase 3).

## Phases

### Phase 1: VPS reality audit — DONE (2026-09-05)

Full findings in `docs/tasks-todo/temporary/vps-audit-2026-09-05.md`. Summary:

- **The backup is healthy** — cron fires daily at 03:30, every visible run succeeds in seconds, zero ERROR lines. An earlier read of this audit claimed multi-week silent failures; that was a misreading of `restic snapshots --latest 3`, which shows the latest three snapshots *per host+paths group*, not overall — the apparent date gaps were the invisible middles of long-stable path-set groups. Recorded here so nobody re-diagnoses the same ghost.
- **Restic retention leaks old snapshot groups.** `restic forget` groups by host + paths by default, and `--files-from` changes the path set whenever a video is added — so pruning works within a group, but a superseded group stops receiving snapshots and its last ~7 dailies are kept forever (April dailies still present five months on). Fix: `--group-by host`.
- **No healthchecks ping anywhere** in the crontab, as feared. Both crons are installed and the weekly restic check does run.
- **`backup.log` is 86 MB, unrotated, and double-logged** — the crontab redirect and the script's `tee` both append every line to the same file.
- Confirmed: container runs as root; all video dirs + `app.db` (+`-wal`/`-shm`) are root:root; `danny` is uid 1000 (matches `bun` in the image, so the phase 5 plan works — chown with the container stopped).
- Already fine, no work needed: Docker log rotation exists at the daemon level (json-file, 10m × 3 — verify `/etc/docker/daemon.json` and document, no compose change); unattended-upgrades healthy; weekly host-level `docker system prune` cron exists; journald 71 MB.
- Disk: `/mnt/data` is 20 GiB with 12 GiB free → the < 5 GiB threshold in the table above.

### Phase 2: Close the healing hole — DONE (2026-09-05)

Pure server code, fully testable, no dependency on phase 1.

- Timeout sweep: `healing` videos stuck longer than 48 h move to `incomplete`, alongside the existing `recording` sweep in `cleanup.ts` (same guarded-update pattern, same event logging).
- Add `healing` to the needs-attention filter in `store.ts`.
- Add the missing idempotency guard on `/complete`'s healing branch in `routes/api/videos.ts` (its sibling `markFootageComplete` has one).
- Tests for all three.

### Phase 3: Self-check + alerting — code DONE (2026-09-05); Danny's setup steps in `operations.md` §One-time setup still pending

- Collector module in `lib/` gathering the table above plus the settings-page extras (volume total/free, loom-clone data footprint, container RAM from cgroup v2 files, last-backup marker).
- Admin-authed endpoint (session or `lca_` bearer) serving it: 200 healthy / 503 + failures.
- `backup.sh`: ping its healthchecks.io check on success (URL read from `~/.config/`, not hardcoded — survives repo checkouts) and write a timestamp marker into the data dir. Weekly restic check gets its own ping.
- Fix the `backup.sh` pre-flight lockout (latent hazard — hasn't fired, per the log): a leftover `app.db.bak` from a failed run blocks every subsequent run until manually removed, turning one transient failure into an indefinite outage. With alerting in place the lockout protects nothing: warn loudly, remove the stale snapshot, continue.
- Crontab additions: the self-check curl (daily, via `origin.v.danny.is`, `lca_` token from `~/.config/`), success ping / `/fail` POST with body.
- Danny creates the three checks at healthchecks.io and stores the ping URLs + token on the host.
- Start `docs/developer/operations.md`: what each alert means and what to look at when it fires (finished in phase 7).

### Phase 4: Admin settings stats — DONE (2026-09-05)

Render the collector's data in the admin settings page: volume disk usage, loom-clone's own footprint, container RAM vs limit, last successful backup. Read-only display, no new data gathering beyond phase 3's collector.

### Phase 5: Docker/compose hardening — DONE (2026-09-05); host chown must run BEFORE the merge deploys (see PR #78 checklist)

- `HEALTHCHECK` in the Dockerfile against `/api/health` (via `bun -e "fetch(...)"` — no curl in the image).
- Container log rotation: already handled by daemon-level defaults (json-file, 10m × 3 — phase 1). Verify `/etc/docker/daemon.json`, document it in the danny-vps-infra README, no compose change.
- Delete the `BUNNY_CDN_API_KEY=${BUNNY_CDN_API_KEY}` line from `docker-compose.prod.yml` — redundant with `env_file`, and silently disables purging when interpolation fails. (The self-check also watches this from the inside.)
- `USER bun` in the Dockerfile + one-time `chown -R` on the host (informed by phase 1). Verify the backup still reads everything.
- Resolve the `PUBLIC_URL` duplication: it stays in `docker-compose.prod.yml`; fix `deployment.md`'s inert instruction to also set it in `.env`.
- danny-vps-infra README: document non-root + uid-1000 ownership as part of the "Adding a new service" convention.

### Phase 6: Backup edges — DONE (2026-09-05); post-deploy retention check in PR #78 step 5

- Add `chapters.json` (video root, not `derivatives/`) to `backup.sh`'s file list.
- Fix retention: add `--group-by host` to the `restic forget` command — the default host+paths grouping strands each superseded path-set group with its last ~7 dailies kept forever (April dailies still in the repo), so the repo grows without bound. After deploying, run one manual forget/prune and confirm the old snapshots actually thin out.
- Fix `backup.log`: kill the double logging (crontab redirect + script `tee` both append to the same file) and cap its size — it's at 86 MB. Simplest: drop the crontab redirect, keep the script's own logging, and trim in-script or via a logrotate.d entry.
- Update `backup-and-restore.md`: the what-gets-backed-up list, the restore loop, the crontab examples, and promote the healthchecks.io step from "(Optional)" to required, pointing at the phase 3 setup.

### Phase 7: Review & docs

- Walk every change against the original #61 phases and review §3/§4; confirm each item landed or was consciously dropped (this doc's decisions list is the checklist).
- Deliberately break something safe (e.g. stop the container, or point the self-check cron at a dead URL) and confirm the alert email actually arrives — the whole task is worthless if the wiring was never tested end to end.
- Finish `operations.md` (alert runbook, self-check reference, thresholds).
- Docs currency sweep over everything touched: `backup-and-restore.md`, `deployment.md`, `server-routes-and-api.md` (new endpoint), `server/CLAUDE.md`, `AGENTS.md`, danny-vps-infra README.
- Close #61.
