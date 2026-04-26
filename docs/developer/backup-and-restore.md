# Backup & Restore

Daily encrypted backups of the loom-clone database and irreplaceable video files to a Hetzner Storage Box via restic. Hetzner's product-level snapshots on the Storage Box provide a second layer of protection that is outside anything our scripts can touch.

## What gets backed up

Per video, only the files that can't be regenerated from another backed-up file:

| File | Why |
| --- | --- |
| `derivatives/source.mp4` | Post-processed master. HLS segments (its source) are cleaned up after 10 days. |
| `recording.json` | Timeline and composition metadata. Irreplaceable. |
| `derivatives/thumbnail.jpg` | Promoted thumbnail. Tiny (~60 KB) and not worth distinguishing auto vs uploaded. |

Plus the database:

| File | Why |
| --- | --- |
| `app.db.bak` | Point-in-time SQLite snapshot taken via `.backup` immediately before the restic run. The live `app.db` is never backed up directly. |

Everything else (`720p.mp4`, `1080p.mp4`, storyboards, HLS segments, thumbnail candidates) is regenerable from `source.mp4` via the existing derivatives pipeline and is excluded from backups.

## Architecture

```
VPS host (cron, 03:30 UTC daily)
  └── ~/loom-clone/server/scripts/backup.sh
        1. sqlite3 .backup  →  /mnt/data/loom-clone/app.db.bak
        2. restic backup     →  sftp:hetzner-backup:loom-clone
        3. rm app.db.bak
        4. restic forget --prune (7 daily, 4 weekly, 12 monthly)

Hetzner Storage Box BX11
  └── /loom-clone/  (restic repository, client-side encrypted)
  └── 10 automated Hetzner-level snapshots (outside restic, outside our scripts)
```

The backup script runs on the VPS **host**, not inside the Docker container. It reads `/mnt/data/loom-clone/` directly (the same volume bind-mounted into the container at `/app/data`).

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

Add these lines:

```cron
# loom-clone: daily backup at 03:30 UTC
30 3 * * * ~/loom-clone/server/scripts/backup.sh >> ~/logs/backup.log 2>&1

# loom-clone: weekly restic integrity check (Sundays 04:30 UTC)
30 4 * * 0 RESTIC_REPOSITORY="sftp:hetzner-backup:loom-clone" RESTIC_PASSWORD_FILE="~/.config/restic-password" restic check >> ~/logs/backup-check.log 2>&1
```

The daily backup runs at 03:30 UTC. The weekly integrity check runs an hour later on Sundays to avoid overlapping.

### 10. (Optional) Healthchecks.io alerting

For push-based failure alerts instead of manually reviewing logs:

1. Create a free check at [healthchecks.io](https://healthchecks.io).
2. Add a curl ping at the end of the backup crontab line:

```cron
30 3 * * * ~/loom-clone/server/scripts/backup.sh >> ~/logs/backup.log 2>&1 && curl -fsS -m 10 --retry 5 https://hc-ping.com/YOUR-UUID-HERE > /dev/null
```

Healthchecks.io will alert you if the ping doesn't arrive within the expected window.

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
# This copies recording.json, derivatives/source.mp4, and derivatives/thumbnail.jpg
# back into each video's directory, creating directories as needed.
cd /tmp/restore/mnt/data/loom-clone
for dir in */; do
  vid_id=$(basename "$dir")
  [[ "$vid_id" =~ ^[0-9a-f-]{36}$ ]] || continue
  mkdir -p "/mnt/data/loom-clone/$vid_id/derivatives"
  cp -v "$dir"recording.json "/mnt/data/loom-clone/$vid_id/" 2>/dev/null || true
  cp -v "$dir"derivatives/source.mp4 "/mnt/data/loom-clone/$vid_id/derivatives/" 2>/dev/null || true
  cp -v "$dir"derivatives/thumbnail.jpg "/mnt/data/loom-clone/$vid_id/derivatives/" 2>/dev/null || true
done

# Start the server
cd ~/loom-clone/server
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

### Regenerate derivatives

After restore, videos will be viewable immediately (source.mp4 is in the backup). But variants (720p, 1080p), storyboards, and thumbnail candidates need regenerating. The server has a backfill script for this:

```bash
docker exec loom-clone-server bun run scripts/backfill-metadata.ts
```

This re-runs `extractMetadata` and `extractAndPromoteThumbnails` for every video. For full variant regeneration, you may need to trigger `scheduleDerivatives` per video (via the admin API or a one-off script).

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

### `app.db.bak already exists`

A previous backup run crashed between the SQLite snapshot and the cleanup step. Investigate:

```bash
ls -la /mnt/data/loom-clone/app.db.bak
tail -100 ~/logs/backup.log
```

If the .bak file looks valid and the last backup log shows a failure after the SQLite step, it's safe to delete and re-run:

```bash
rm -f /mnt/data/loom-clone/app.db.bak
~/loom-clone/server/scripts/backup.sh
```

### `ssh: connect to host ... port 23: Connection refused`

SSH support may not be enabled on the Storage Box. Check the Robot panel under the Storage Box settings.

### `restic: repository does not exist`

The repo hasn't been initialised. Run:

```bash
restic -r sftp:hetzner-backup:loom-clone init --password-file ~/.config/restic-password
```

### Restoring from Hetzner-level snapshots

If both restic and the live box contents are corrupted, Hetzner's automated snapshots are the last resort. Access them via the Robot panel under the Storage Box's "Snapshots" tab. You can revert to a previous snapshot from there, then run `restic snapshots` to see what's available.
