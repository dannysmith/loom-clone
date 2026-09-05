# Backup & Restore

Daily encrypted backups of the loom-clone database and irreplaceable video files to a Hetzner Storage Box via restic. Hetzner's product-level snapshots on the Storage Box provide a second layer of protection that is outside anything our scripts can touch.

## What gets backed up

Per video, only the files that can't be regenerated from another backed-up file:

| File | Why |
| --- | --- |
| `derivatives/source.mp4` | The pristine original, and the only thing here that can't be rebuilt. The HLS segments it was stitched from are cleaned up after 10 days. |
| `recording.json` | Timeline and composition metadata. Irreplaceable. |
| `chapters.json` | User-edited chapter titles (video root, not `derivatives/`). The only user-authored file outside the database — simply gone after a restore without it. |
| `derivatives/thumbnail.jpg` | Promoted thumbnail. Tiny (~60 KB) and not worth distinguishing auto vs uploaded. |
| `derivatives/edits.json` | The EDL. Irreplaceable, and the input that makes a rebuilt master reproduce the same cut. |
| `derivatives/words.json` | Word-level transcript timestamps from WhisperKit. Not regenerable server-side. |
| `derivatives/captions.original.*` | The transcript exactly as the Mac produced it. The served `captions.srt` is derived from it, but this one isn't regenerable. |

Everything else — the `<H>p.mp4` presentation master, its downscaled variants, storyboards, peaks, thumbnail candidates, the served captions — is a derivative of the files above and is rebuilt by a reprocess.

Plus the database:

| File | Why |
| --- | --- |
| `app.db.bak` | Point-in-time SQLite snapshot taken via `.backup` immediately before the restic run. The live `app.db` is never backed up directly. |

Everything else (`720p.mp4`, `1080p.mp4`, storyboards, HLS segments, thumbnail candidates, peaks, captions) is regenerable from the backed-up files via the processing pipeline and is excluded from backups.

## Architecture

```
VPS host (cron, 03:30 UTC daily)
  └── ~/loom-clone/server/scripts/backup.sh
        1. sqlite3 .backup  →  /mnt/data/loom-clone/app.db.bak
        2. restic backup     →  sftp:hetzner-backup:loom-clone
           (+ writes the .last-backup marker the admin settings page shows)
        3. rm app.db.bak
        4. restic forget --prune --group-by host (7 daily, 4 weekly, 12 monthly)
        5. healthchecks.io ping — the dead-man's switch (operations.md)

Hetzner Storage Box BX11
  └── /loom-clone/  (restic repository, client-side encrypted)
  └── 10 automated Hetzner-level snapshots (outside restic, outside our scripts)
```

The backup script runs on the VPS **host**, not inside the Docker container (see [Deployment](deployment.md) for the VPS/Docker architecture). It reads `/mnt/data/loom-clone/` directly (the same volume bind-mounted into the container at `/app/data`).

## One-time setup

### 1. Provision Storage Box BX11

In the [Hetzner Robot panel](https://robot.hetzner.com) (Storage Boxes are managed via Robot, not Cloud Console):

1. Order a **Storage Box BX11** (1 TB, ~€3.20/month).
2. Note the hostname (`uXXXXXX.your-storagebox.de`) and username (`uXXXXXX`) from the confirmation email / Robot panel.
3. In the Robot panel, go to the Storage Box settings and **enable SSH support** (it may already be enabled — check under "Manage" or "Settings").

### 2. Install restic and sqlite3 on the VPS

SSH into the VPS as the deploy user:

```bash
sudo apt-get update
sudo apt-get install -y restic sqlite3
```

Verify:

```bash
restic version    # should print 0.16+ or similar
sqlite3 --version # should print 3.x
```

### 3. Set up SSH key authentication

The VPS needs passwordless SSH access to the Storage Box on port 23.

```bash
# Generate a dedicated key if you don't want to reuse your main one
ssh-keygen -t ed25519 -f ~/.ssh/hetzner-backup -N "" -C "loom-clone-backup"

# Create the .ssh directory on the Storage Box (enter password when prompted)
ssh -p 23 uXXXXXX@uXXXXXX.your-storagebox.de mkdir .ssh

# Copy the public key (note: scp uses uppercase -P for port)
scp -P 23 ~/.ssh/hetzner-backup.pub uXXXXXX@uXXXXXX.your-storagebox.de:.ssh/authorized_keys
```

Test that passwordless login works:

```bash
ssh -p 23 -i ~/.ssh/hetzner-backup uXXXXXX@uXXXXXX.your-storagebox.de ls
```

You should see an empty listing (or the contents of the box) with no password prompt. The connection will close automatically — Storage Boxes don't provide a shell.

### 4. Configure SSH alias

Add a host alias so restic (and you) don't need to remember the port and key path. Append to `~/.ssh/config`:

```bash
cat >> ~/.ssh/config << 'EOF'

Host hetzner-backup
    HostName uXXXXXX.your-storagebox.de
    User uXXXXXX
    Port 23
    IdentityFile ~/.ssh/hetzner-backup
    ServerAliveInterval 60
    ServerAliveCountMax 240
EOF
chmod 600 ~/.ssh/config
```

Replace `uXXXXXX` with the actual Storage Box username/hostname.

Test the alias:

```bash
sftp hetzner-backup <<< "ls"
```

### 5. Generate and store restic password

```bash
# Generate a strong random password
openssl rand -base64 32 > ~/.config/restic-password
chmod 600 ~/.config/restic-password

# IMPORTANT: copy this password somewhere offline that survives the VPS dying.
# Without it, the restic repository is unreadable.
cat ~/.config/restic-password
```

Store the password in your password manager, a secure note, or wherever you keep critical secrets. The restic repo is encrypted client-side — if you lose this password, the backups are gone.

### 6. Initialise the restic repository

```bash
restic -r sftp:hetzner-backup:loom-clone init --password-file ~/.config/restic-password
```

Expected output: `created restic repository ... at sftp:hetzner-backup:loom-clone`

### 7. Verify Hetzner snapshot retention

In the Robot panel, check that **automated snapshots** are enabled on the Storage Box. BX11 includes 10 automated snapshots — these are Hetzner's filesystem-level snapshots, taken by Hetzner, stored separately from the box contents. Even if a buggy backup run or `restic forget` wipes the live contents, yesterday's snapshot is still intact.

### 8. Do a test run

Run the backup script manually to verify everything works end-to-end:

```bash
~/loom-clone/server/scripts/backup.sh
```

Then verify:

```bash
# List snapshots in the repo
restic -r sftp:hetzner-backup:loom-clone --password-file ~/.config/restic-password snapshots

# Check repo integrity
restic -r sftp:hetzner-backup:loom-clone --password-file ~/.config/restic-password check
```

### 9. Install the crontab

```bash
crontab -e
```

Add these lines. Stdout goes to `/dev/null` because both scripts log themselves to `~/logs/` — a crontab redirect on top would write every line twice:

```cron
# loom-clone: daily backup at 03:30 UTC (logs to ~/logs/backup.log)
30 3 * * * $HOME/loom-clone/server/scripts/backup.sh > /dev/null 2>&1

# loom-clone: weekly restic integrity check, Sundays 04:30 UTC (logs to ~/logs/backup-check.log)
30 4 * * 0 $HOME/loom-clone/server/scripts/restic-check.sh > /dev/null 2>&1
```

The weekly integrity check runs an hour after the backup on Sundays so the two never overlap. The full crontab (including the daily self-check) is in [Operations & Alerting](operations.md).

### 10. Healthchecks.io alerting (required)

Backup failure alerting is the single highest-value piece of ops configuration this system has — without it, a backup that starts failing is discovered whenever someone next reads a log file (which happened: see the task-2 VPS audit). Both scripts ping their healthchecks.io checks on success, reading the ping URLs from `~/.config/loom-clone-ops.env`; healthchecks emails when a ping *doesn't* arrive. Creating the checks and the env file is part of [Operations & Alerting → One-time setup](operations.md#one-time-setup) — do it as part of this setup, not later.

## Restore procedure

### List available snapshots

```bash
restic -r sftp:hetzner-backup:loom-clone --password-file ~/.config/restic-password snapshots
```

### Restore to a scratch directory

```bash
mkdir -p /tmp/restore
restic -r sftp:hetzner-backup:loom-clone --password-file ~/.config/restic-password \
  restore latest --target /tmp/restore
```

Files land at `/tmp/restore/mnt/data/loom-clone/...` (restic preserves the full original paths).

To restore a specific snapshot instead of `latest`, replace `latest` with the snapshot ID from the `snapshots` command.

### Put files back in place

```bash
# Stop the server
cd ~/loom-clone/server
docker compose -f docker-compose.yml -f docker-compose.prod.yml down

# Restore the database
cp /tmp/restore/mnt/data/loom-clone/app.db.bak /mnt/data/loom-clone/app.db

# Restore per-video files
# Copies every backed-up per-video file (recording.json and chapters.json at
# the video root, plus derivatives/ source.mp4, thumbnail.jpg, edits.json,
# words.json, captions.original.*) back into each video's directory, creating
# directories as needed.
cd /tmp/restore/mnt/data/loom-clone
for dir in */; do
  vid_id=$(basename "$dir")
  [[ "$vid_id" =~ ^[0-9a-f-]{36}$ ]] || continue
  mkdir -p "/mnt/data/loom-clone/$vid_id/derivatives"
  for f in recording.json chapters.json; do
    cp -v "$dir$f" "/mnt/data/loom-clone/$vid_id/" 2>/dev/null || true
  done
  for f in source.mp4 thumbnail.jpg edits.json words.json captions.original.srt captions.original.vtt; do
    cp -v "$dir"derivatives/"$f" "/mnt/data/loom-clone/$vid_id/derivatives/" 2>/dev/null || true
  done
done

# The container runs as uid 1000 — make sure everything restored is owned by
# danny (uid 1000) or the server can't write to it:
sudo chown -R danny:danny /mnt/data/loom-clone

# Start the server
cd ~/loom-clone/server
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

### Regenerate derivatives

**A restored video does not serve until it has been reprocessed.** This changed with the presentation-master restructure and it's the one thing to know about restoring: the file viewers are served is `<H>p.mp4`, which is a derivative and therefore isn't in the backup. Until it's rebuilt, a restored video falls back to HLS — and for anything older than ten days those segments are long gone, so the page has nothing to play. The pristine `source.mp4` is safe in the backup; it just isn't what gets served.

So reprocessing isn't an optional tidy-up here, it's the last step of the restore. A reprocess rebuilds the master, its variants, the storyboard and the captions from the restored source and EDL:

```bash
# One video, via the admin panel: video page → Processing tab → Reprocess.
# All videos, via the admin API with an lca_ bearer token:
for id in $(sqlite3 /mnt/data/loom-clone/app.db "SELECT id FROM videos WHERE trashed_at IS NULL"); do
  curl -fsS -X POST -H "Authorization: Bearer lca_..." \
    "https://v.danny.is/admin/videos/$id/reprocess"
  sleep 30   # pipeline runs are fire-and-forget; don't queue the whole library at once
done
```

### Clean up

```bash
rm -rf /tmp/restore
```

## Monitoring

### Check backup logs

```bash
tail -50 ~/logs/backup.log
```

### Check the latest snapshot

```bash
restic -r sftp:hetzner-backup:loom-clone --password-file ~/.config/restic-password snapshots --latest 1
```

### Check repo integrity

```bash
restic -r sftp:hetzner-backup:loom-clone --password-file ~/.config/restic-password check
```

### Check Storage Box usage

```bash
sftp hetzner-backup <<< "df -h"
```

## Troubleshooting

### `WARNING: stale app.db.bak found` in the log

A previous backup run failed between the SQLite snapshot and the cleanup step (most often: the Storage Box was briefly unreachable during restic). The script handles this itself — the stale snapshot is disposable, so it's replaced and the run continues. The warning is just breadcrumbs: check the log around the previous run's timestamps for what actually failed. If runs keep failing, the missed healthchecks ping is what alerts you (see [Operations & Alerting](operations.md)).

### `ssh: connect to host ... port 23: Connection refused`

SSH support may not be enabled on the Storage Box. Check the Robot panel under the Storage Box settings.

### `restic: repository does not exist`

The repo hasn't been initialised. Run:

```bash
restic -r sftp:hetzner-backup:loom-clone init --password-file ~/.config/restic-password
```

### Restoring from Hetzner-level snapshots

If both restic and the live box contents are corrupted, Hetzner's automated snapshots are the last resort. Access them via the Robot panel under the Storage Box's "Snapshots" tab. You can revert to a previous snapshot from there, then run `restic snapshots` to see what's available.
