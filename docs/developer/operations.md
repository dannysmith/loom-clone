# Operations & Alerting

How the system reports its own health. Design rationale and decisions live in the task doc that introduced this ([#61](https://github.com/dannysmith/loom-clone/issues/61)); this is the living reference: what the alerts are, how they're wired, and what to do when one fires.

## The model: alert on silence, not on failure

A self-hosted stack can't alert on its own death — an alert sent on failure dies with the host. So every alert here is **absence-based**: each scheduled job pings a [healthchecks.io](https://healthchecks.io) check URL on success, and healthchecks emails when a ping *doesn't* arrive on schedule. Total host failure, a crash-looping container, a broken cron, and an application-level problem all collapse into the same signal: silence.

Everything that *observes* is self-contained (scripts on the VPS, an endpoint in the server). healthchecks.io is the single external touchpoint, and it's deliberately dumb.

## The three checks

| Check           | Cron (UTC)      | healthchecks schedule | Silence means                                    |
| --------------- | --------------- | --------------------- | ------------------------------------------------ |
| **backup**      | daily 03:30     | daily, grace 6 h      | last night's backup failed (or the host is dead) |
| **restic-check**| Sundays 04:30   | weekly, grace 12 h    | the backup repo failed its integrity check       |
| **self-check**  | daily 06:15     | daily, grace 6 h      | the app is unhealthy, unreachable, or host dead  |

The backup and restic-check pings live at the end of their scripts (`server/scripts/backup.sh`, `server/scripts/restic-check.sh`) — a failure earlier in the script aborts before the ping. The self-check ping comes from `server/scripts/self-check-ping.sh`, which curls the endpoint below and forwards the verdict; on a non-200 it POSTs the response body to the check's `/fail` URL, so the alert email carries the actual failure detail.

## The self-check endpoint

`GET /admin/self-check` — admin-authed (session or `lca_` bearer), JSON. Returns **200** with `{ healthy: true, ... }` when everything passes, **503** with the failure list when not. The collector lives in `server/src/lib/self-check.ts`; the admin panel renders the same report for humans under Settings → General.

The cron curls it via `https://origin.v.danny.is` (not the CDN hostname — cached responses would mask an origin outage), so one request exercises Caddy, TLS, the container, and the app together.

What it checks:

| Check                        | Alert when                                          | Threshold lives in       |
| ---------------------------- | --------------------------------------------------- | ------------------------ |
| Stuck `processing`           | no update for 30 min                                | `store.ts`               |
| Stuck `recording`            | no segment activity for 4 h                         | `cleanup.ts`             |
| Stuck `healing`              | no segment activity for 48 h                        | `cleanup.ts`             |
| `processing_failed` videos   | any exist (untrashed)                               | —                        |
| `incomplete` videos          | any exist (untrashed)                               | —                        |
| Disk headroom on `/app/data` | free space < 5 GiB                                  | `self-check.ts`          |
| CDN purge config             | production and `BUNNY_CDN_API_KEY` unset            | —                        |

`incomplete` and `processing_failed` alert **until dealt with** — by design. The way to silence the alert is to recover or trash the video; there's no acknowledgement machinery.

Backup age is *not* a self-check item: the backup's own healthchecks schedule covers "no successful backup in N days". The report's `stats.lastBackupAt` (read from the `.last-backup` marker `backup.sh` writes into the data dir) is display-only.

## One-time setup

1. **Create three checks** at healthchecks.io (free tier), named `loom-backup`, `loom-restic-check`, `loom-self-check`, with the schedules from the table above and email alerting on.
2. **Create an admin token** in the admin panel: Settings → API Keys → new `lca_` token (name it `self-check-cron`). The plaintext is shown once.
3. **Write the ops env file** on the VPS at `~/.config/loom-clone-ops.env` (chmod 600):

   ```sh
   LOOMCLONE_ADMIN_TOKEN=lca_...
   HC_BACKUP_URL=https://hc-ping.com/<uuid-1>
   HC_RESTIC_CHECK_URL=https://hc-ping.com/<uuid-2>
   HC_SELFCHECK_URL=https://hc-ping.com/<uuid-3>
   ```

   The scripts read it at run time — nothing is hardcoded, and a rebuilt VPS only needs this file recreated (it's in the same category as `~/.config/restic-password`).
4. **Install the crontab** (`crontab -e`). Stdout goes to `/dev/null` because the scripts already log themselves to `~/logs/` — a crontab redirect on top would double every line:

   ```cron
   # loom-clone: daily backup at 03:30 UTC (logs to ~/logs/backup.log)
   30 3 * * * $HOME/loom-clone/server/scripts/backup.sh > /dev/null 2>&1

   # loom-clone: weekly restic integrity check, Sundays 04:30 UTC (logs to ~/logs/backup-check.log)
   30 4 * * 0 $HOME/loom-clone/server/scripts/restic-check.sh > /dev/null 2>&1

   # loom-clone: daily self-check at 06:15 UTC
   15 6 * * * $HOME/loom-clone/server/scripts/self-check-ping.sh > /dev/null 2>&1
   ```

5. **Test the wiring end to end** — run each script by hand and confirm the ping lands on the healthchecks dashboard, then break something safe (e.g. point `SELF_CHECK_URL` at a bogus host) and confirm the `/fail` alert email actually arrives. Alerting that has never fired is a hypothesis, not a safety net.

## Runbook: when an alert fires

**backup missed** — `ssh danny-vps`, then `tail -50 ~/logs/backup.log`. Common causes: storage box unreachable (transient — the next night's run self-heals; the script replaces a stale `app.db.bak` automatically), restic lock left by a killed run (`restic unlock`), disk full. Verify recovery with `restic snapshots --latest 3 --group-by host`.

**restic-check missed** — `tail -50 ~/logs/backup-check.log`. An actual integrity failure is serious: don't prune anything, read the restic error, and consider `restic repair index` / re-uploading affected snapshots. The backups on the storage box are the last line of defence — treat this alert as urgent.

**self-check failed (email has the detail)** — the `/fail` body lists exactly which checks failed:

- *Stuck processing / recording / healing* — open the admin dashboard's "Needs attention" filter. A stuck `processing` video usually means the pipeline died mid-run: try "Re-run post-processing" on the video page. A stuck heal means the Mac never finished re-uploading — if it's coming back, wait (the 48h sweep will move it to `incomplete`, which re-heals fine); if not, recover what's there or trash it.
- *processing_failed / incomplete* — triage each video: reprocess, recover, or trash. The alert repeats daily until the list is empty.
- *Disk low* — grow the Hetzner volume (Cloud console → Volumes → resize, then `resize2fs` per Hetzner docs), or trash old videos and empty the trash.
- *CDN purging disabled* — `BUNNY_CDN_API_KEY` didn't reach the container: check `server/.env` on the VPS and recreate the container.

**self-check unreachable (HTTP 000 in the email)** — the host cron is alive but the app isn't answering: `docker ps`, `docker logs loom-clone-server --tail 100`, `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d`. If Caddy is the problem: `cd ~/danny-vps-infra/caddy && docker compose logs caddy`.

**all three silent at once** — the host is down. Hetzner console → power/rescue, or restore from backup onto a fresh VPS per `backup-and-restore.md`.
