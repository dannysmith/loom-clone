# Task 3: Storage & Backups

Goal: get reliable, ransomware-resistant backups of every video the system can't recreate, plus the SQLite DB, onto separate Hetzner infrastructure — and along the way remove the obvious double-storage we currently carry on the primary volume.

## Background

Server-side video files live on a 20 GB Hetzner shared volume in Falkenstein (ID redacted), bind-mounted into the container at `data/`. The DB (`data/app.db`) lives there too. There are no external backups today. Disk usage is also higher than it needs to be — most completed recordings are stored roughly twice (HLS segments + a `-c copy` MP4 derivative built from them; same story for uploaded videos and their `upload.mp4`).

This task tackles three things in one pass: where backups live, how they run, and what we clean up so backups (and the primary volume) don't carry duplicate bytes.

## Decisions taken

### Primary storage stays on the Hetzner Volume

We're not moving primary video storage to Hetzner Object Storage or any other S3 target.

- The Volume is fast, simple, lives next to the server, and costs roughly €0.044/GB/month. A 100 GB Volume holds hundreds of recordings at current sizes — years of headroom.
- Object Storage is built for the scale problem we don't have. Putting primary storage there means either proxying every range request through the server, or making buckets public and losing the slug-based access control already wired through `media.ts`.
- The portability argument ("if the VPS dies, the data is elsewhere") is what backups solve.

### Backup target: Hetzner Storage Box BX11

A Storage Box BX11 (€3.20/month, 1 TB, SFTP/SCP/Borg/restic, 10 automated snapshots) sits separately from the production VPS and serves as the single backup target.

Why Storage Box over Object Storage:

- The 10 product-level snapshots are managed by Hetzner, outside anything our scripts can touch. Even if a buggy backup run wipes the box's live contents, yesterday's snapshot is still intact. That's the "can't easily be fucked up" property the task asks for.
- restic over SFTP is well-trodden, encrypts client-side (Hetzner can't read it), dedups, and verifies snapshots end-to-end.
- Cheaper at the scale we're operating in (€3.20 vs €5.99/month minimum), with no egress charges on restore.
- Restoration is `restic restore <snapshot> --target /tmp/r` — no S3 client, no AWS CLI.

The case for Object Storage would be a Litestream-style continuous DB replication setup (S3-only). We're not doing that; see below.

### Backup contents

Per video, we back up only the files that cannot be regenerated from another backed-up file:

- `derivatives/source.mp4` — the post-processed master (audio normalised, faststart). Cannot be rebuilt once the HLS segments are cleaned up.
- `recording.json` — small, irreplaceable timeline data.
- `derivatives/thumbnail.jpg` — backed up unconditionally. ~60 KB per video; not worth a schema column to distinguish auto-promoted vs admin-uploaded.

Plus the database:

- `data/app.db.bak` — produced via SQLite's online `.backup` command immediately before the restic run, so the file restic captures is a consistent point-in-time snapshot.

Files explicitly **not** backed up (regenerable from `source.mp4` via the existing derivatives pipeline):

- `derivatives/720p.mp4`, `derivatives/1080p.mp4`
- `derivatives/storyboard.jpg`, `derivatives/storyboard.vtt`
- `derivatives/thumbnail-candidates/*`
- `stream.m3u8`, `init.mp4`, `seg_*.m4s` (and these will be cleaned off the primary volume too — see below)
- `upload.mp4` (will be cleaned off the primary volume — see below)

After a restore, the standard derivatives pipeline regenerates everything else by running once per video.

### Backup approach: bundled daily snapshot

One restic snapshot per day, taken during a quiet hour, containing both the DB backup file and the per-video files listed above. Bundling DB and files into a single restic invocation gives us one artifact representing one consistent point in time — no two-system sync problem to reason about, no risk of the DB and file backups diverging.

The shape:

```
1. sqlite3 data/app.db ".backup data/app.db.bak"   # online-safe; doesn't block writers
2. restic backup data/                              # picks up app.db.bak + per-video files
3. rm -f data/app.db.bak
```

Consistency note: between step 1 and the moment restic finishes walking the tree, new videos can be created and old ones hard-deleted. In practice this barely matters because (a) the DB snapshot is taken first, so anything created after T0 is invisible to both sides; (b) hard deletes are rare and admin-initiated; (c) the codebase already tolerates "DB row exists, file missing" in the viewer fallback path. We accept this and document it in the runbook rather than building snapshot orchestration.

### Why not Litestream

Considered and ruled out for now. Litestream solves "I'd lose meaningful data with a 24-hour RPO" — which doesn't describe a single-user tool whose DB is currently 152 KB and whose write volume is bursty around recording sessions. Adding Litestream would mean an extra sidecar process, an S3 backend (so Object Storage too), and a separate restoration path that isn't aligned with the file-backup snapshot anyway. The bundled daily snapshot wins on simplicity and gives an aligned restore. If RPO requirements tighten later, layer Litestream on top — don't pay the complexity now.

### Why not Postgres

Considered and ruled out. SQLite is the right database for a single-user tool at this scale. The migration path (operational complexity, drizzle dialect changes, container topology) buys nothing the bundled-snapshot backup doesn't already give us.

## Backup work

### One-time setup

- Provision a Storage Box BX11 in the same Hetzner project. Note the SFTP host, port, username, and the SSH public key on the production VPS that will push backups.
- Generate a restic repository password, store it in `~/.config/restic-password` on the VPS (chmod 600, owned by the deploy user), and somewhere offline that survives the VPS dying.
- Initialise the restic repo: `restic -r sftp:<box-user>@<box-host>:/repo init`.
- Confirm Hetzner-level snapshot retention is enabled on the box (10 automated snapshots on BX11).

### Backup script

A single shell script at `server/scripts/backup.sh` (or similar) that runs the three steps in [the bundled approach](#backup-approach-bundled-daily-snapshot). It must:

- Refuse to run if `data/app.db.bak` already exists (previous run crashed mid-flight; investigate, don't overwrite).
- Use restic include/exclude rules to back up only the listed paths and skip everything regenerable.
- Apply a `restic forget --prune` policy after each successful backup: keep 7 daily, 4 weekly, 12 monthly. Hetzner's box-level snapshots act as the additional outside-of-restic safety net.
- Log to a file and exit non-zero on any failure so the cron alert mechanism (next item) catches it.

### Scheduling and alerting

- Daily cron on the VPS at a quiet hour (e.g. 03:30 UTC).
- Pipe failures to whatever alerting Danny prefers — at minimum a logfile that's reviewed weekly. Healthchecks.io or similar is a low-effort upgrade if we want push alerts.
- A weekly `restic check` cron run that verifies repository integrity and reports failures.

### Restore drill

Runbook at `docs/developer/backup-and-restore.md` with the exact commands to:

- List restic snapshots.
- Restore the latest snapshot to a scratch directory.
- Drop the restored `app.db.bak` into place as `data/app.db`.
- Drop the restored per-video files into `data/<id>/`.
- Restart the server. The derivatives pipeline regenerates `720p.mp4`, `1080p.mp4`, storyboards, and thumbnail candidates in the background; viewers see HLS-fallback briefly until source.mp4 is in place (it's in the backup, so this is instant).

Schedule a real restore drill into a throwaway VM at least once after the system goes live — backups you haven't restored from aren't backups.

## Storage cleanup work

Three concrete cleanups, all reducing primary-volume usage and (for the per-video items) also reducing what restic has to walk on every backup. None of these touch the file-backup contract above; the things we delete on the primary are either regenerable (HLS, thumbnail candidates) or the input that produced an already-kept derivative (`upload.mp4`).

### Immediate: delete `upload.mp4` after `derivatives/source.mp4` lands

In `scheduleUploadDerivatives` (or the post-recipe steps in `derivatives.ts`), after `source.mp4` has been written and `extractMetadata` confirms a non-zero `fileBytes`, delete `data/<id>/upload.mp4`.

This is the simplest cleanup: a one-shot delete inside the same pipeline run that produced the derivative, gated on the derivative existing and being valid.

### Weekly cleanup job: stale HLS segments and thumbnail candidates

A new background job (Bun cron or a script triggered by an external scheduler) runs weekly and walks `data/<id>/` for every video where:

- `status = 'complete'`
- `completed_at` is more than 10 days ago
- `derivatives/source.mp4` exists and has non-zero size

For each matching video:

- Delete `init.mp4`, `seg_*.m4s`, `stream.m3u8` from the video's root directory.
- Delete `derivatives/thumbnail-candidates/*` (the promoted `thumbnail.jpg` already lives at `derivatives/thumbnail.jpg`; the candidates directory exists only so admins can re-pick).

The 10-day window is a deliberate safety buffer beyond the client's 3-day startup-heal window. By 10 days post-completion, anything that was going to heal has healed.

Viewer impact: the HLS-fallback path in `resolve.ts` only fires when `source.mp4` is absent. Once a video is `complete` and has a `source.mp4`, the viewer never reads the segments. Cleaning them up after 10 days is invisible to viewers.

If a future re-pick of thumbnail candidates is wanted, add an admin button that re-runs `extractAndPromoteThumbnails` against `source.mp4` to regenerate them on demand.

### Variants stay

`derivatives/720p.mp4` and `derivatives/1080p.mp4` are kept on disk. They're not used by the player today, but they will be wired up in due course (per Danny). Cost is small relative to `source.mp4` (~15–25%).

## File inventory after this task

Per video, post-cleanup, on the primary volume:

| File                              | Lifetime                                                    | Backed up? |
| --------------------------------- | ----------------------------------------------------------- | ---------- |
| `recording.json`                  | Forever                                                     | Yes        |
| `derivatives/source.mp4`          | Forever                                                     | Yes        |
| `derivatives/thumbnail.jpg`       | Forever                                                     | Yes        |
| `derivatives/720p.mp4`            | Forever                                                     | No (regen) |
| `derivatives/1080p.mp4`           | Forever (when source > 1080p)                               | No (regen) |
| `derivatives/storyboard.jpg/vtt` | Forever (when duration ≥ 60s)                               | No (regen) |
| `init.mp4`, `seg_*.m4s`, `stream.m3u8` | Until 10 days post-`complete`, then deleted weekly     | No         |
| `derivatives/thumbnail-candidates/*` | Until 10 days post-`complete`, then deleted weekly      | No         |
| `upload.mp4`                      | Until `source.mp4` is generated, then deleted immediately   | No         |

Plus `data/app.db` (live; backed up via `.backup` snapshot, not as the live file).

## Out of scope

- **Object Storage as primary.** Considered; ruled out — see [Decisions taken](#primary-storage-stays-on-the-hetzner-volume). May revisit if scale or geographic-distribution requirements change.
- **Litestream.** Considered; ruled out for now — bundled daily snapshot covers the actual RPO requirement.
- **Postgres migration.** Considered; ruled out — SQLite at single-user scale needs no replacement.
- **Multi-region or 3-2-1 backup topology.** Storage Box + Hetzner-level snapshots are sufficient. A second backup tier (e.g. weekly push to Object Storage in a different region) is a future-proofing option that's cheap to add later but not needed today.
- **Encryption-at-rest on the primary volume.** Out of scope for this task. Hetzner already encrypts at the volume layer for what that's worth; restic gives client-side encryption on the backup leg, which is the part exposed to a third party.
- **Rebuilding the player to use the variants.** That work belongs in a separate task; this task only commits to keeping the variant files on disk.
