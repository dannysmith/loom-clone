// The daily self-check: everything the system can observe about its own
// health from inside the container. Two consumers share this collector — the
// /admin/self-check endpoint (a host cron curls it and forwards the verdict
// to healthchecks.io; see docs/developer/operations.md) and the admin
// settings page, which renders the same stats for humans.
//
// Backup *age* is deliberately not a failure condition here: the backup cron
// pings its own healthchecks.io check, whose schedule + grace does "no
// successful backup in N days" natively. The marker below is display-only.

import { and, eq, inArray, isNull, lt } from "drizzle-orm";
import { statfs } from "fs/promises";
import { join } from "path";
import { getDb } from "../db/client";
import { videos } from "../db/schema";
import { findStalledVideos, STALE_HEALING_HOURS, STALE_RECORDING_HOURS } from "./cleanup";
import { getDataDirSize } from "./files";
import { DATA_DIR } from "./paths";
import { STALLED_PROCESSING_MINUTES } from "./store";

// Alert when the data volume has less than this many bytes free. The volume
// is 20 GiB and resizable live on Hetzner; 5 GiB of headroom leaves time to
// grow it before a long recording could hit the wall.
export const DISK_FREE_ALERT_BYTES = 5 * 1024 ** 3;

export type SelfCheckReport = {
  healthy: boolean;
  checkedAt: string;
  failures: string[];
  stats: {
    disk: { totalBytes: number; freeBytes: number }; // the volume DATA_DIR lives on
    dataDirBytes: number; // loom-clone's own footprint on it
    memory: { currentBytes: number; limitBytes: number | null } | null; // cgroup v2; null outside a container
    lastBackupAt: string | null; // marker written by backup.sh after each successful restic run
  };
};

// cgroup v2 exposes the container's memory usage and limit as flat files.
// Outside a container (dev on macOS) they don't exist — return null.
async function readCgroupMemory(): Promise<SelfCheckReport["stats"]["memory"]> {
  try {
    const current = Number((await Bun.file("/sys/fs/cgroup/memory.current").text()).trim());
    if (!Number.isFinite(current)) return null;
    const maxRaw = (await Bun.file("/sys/fs/cgroup/memory.max").text()).trim();
    const limit = maxRaw === "max" ? null : Number(maxRaw);
    return { currentBytes: current, limitBytes: Number.isFinite(limit) ? limit : null };
  } catch {
    return null;
  }
}

async function readLastBackupMarker(): Promise<string | null> {
  try {
    const raw = (await Bun.file(join(DATA_DIR, ".last-backup")).text()).trim();
    return raw || null;
  } catch {
    return null;
  }
}

const gib = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);
const slugList = (rows: { slug: string }[]) => rows.map((r) => r.slug).join(", ");

// Runs every check and gathers the stats. `diskFreeAlertBytes` is overridable
// for tests only — production callers use the default.
export async function runSelfCheck(opts?: {
  diskFreeAlertBytes?: number;
}): Promise<SelfCheckReport> {
  const db = getDb();
  const failures: string[] = [];

  // Videos stuck in `processing` past the same threshold the dashboard's
  // needs-attention filter uses: the pipeline died mid-run and reconcile
  // never settled them.
  const stalledCutoff = new Date(Date.now() - STALLED_PROCESSING_MINUTES * 60 * 1000).toISOString();
  const stuckProcessing = await db
    .select({ slug: videos.slug })
    .from(videos)
    .where(
      and(
        eq(videos.status, "processing"),
        lt(videos.updatedAt, stalledCutoff),
        isNull(videos.trashedAt),
      ),
    );
  if (stuckProcessing.length > 0) {
    failures.push(
      `${stuckProcessing.length} video(s) stuck in processing for >${STALLED_PROCESSING_MINUTES}m: ${slugList(stuckProcessing)}`,
    );
  }

  // Stalled recordings/heals the daily sweep hasn't reached yet (it runs every
  // 24h; this endpoint is polled daily too, so both alarms can fire first).
  const stalled = await findStalledVideos();
  const stalledRecordings = stalled.filter((v) => v.status === "recording");
  const stalledHeals = stalled.filter((v) => v.status === "healing");
  if (stalledRecordings.length > 0) {
    failures.push(
      `${stalledRecordings.length} recording(s) with no segment activity for >${STALE_RECORDING_HOURS}h: ${slugList(stalledRecordings)}`,
    );
  }
  if (stalledHeals.length > 0) {
    failures.push(
      `${stalledHeals.length} heal(s) with no segment activity for >${STALE_HEALING_HOURS}h: ${slugList(stalledHeals)}`,
    );
  }

  // Videos already given up on. These alert until dealt with — the way to
  // silence the alert is to fix or trash the video (task-2 decision 5).
  const attention = await db
    .select({ slug: videos.slug, status: videos.status })
    .from(videos)
    .where(
      and(inArray(videos.status, ["processing_failed", "incomplete"]), isNull(videos.trashedAt)),
    );
  const failed = attention.filter((v) => v.status === "processing_failed");
  const incomplete = attention.filter((v) => v.status === "incomplete");
  if (failed.length > 0) {
    failures.push(`${failed.length} video(s) with failed processing: ${slugList(failed)}`);
  }
  if (incomplete.length > 0) {
    failures.push(
      `${incomplete.length} incomplete video(s) awaiting triage (recover or trash): ${slugList(incomplete)}`,
    );
  }

  // Disk headroom on the volume DATA_DIR lives on. bavail is what an
  // unprivileged writer can actually use. Before the first recording DATA_DIR
  // may not exist yet — its parent is on the same filesystem, so fall back.
  const fs = await statfs(DATA_DIR).catch(() => statfs("."));
  const disk = {
    totalBytes: fs.blocks * fs.bsize,
    freeBytes: fs.bavail * fs.bsize,
  };
  const diskFreeAlertBytes = opts?.diskFreeAlertBytes ?? DISK_FREE_ALERT_BYTES;
  if (disk.freeBytes < diskFreeAlertBytes) {
    failures.push(
      `data volume low on space: ${gib(disk.freeBytes)} GiB free (alert below ${gib(diskFreeAlertBytes)} GiB)`,
    );
  }

  // The compose interpolation trap: a missing BUNNY_CDN_API_KEY silently
  // disables all CDN purging (cdn.ts no-ops). Only meaningful in production —
  // dev and tests run without a key by design.
  if (Bun.env.NODE_ENV === "production" && !Bun.env.BUNNY_CDN_API_KEY) {
    failures.push("CDN purging disabled: BUNNY_CDN_API_KEY is not set in production");
  }

  return {
    healthy: failures.length === 0,
    checkedAt: new Date().toISOString(),
    failures,
    stats: {
      disk,
      dataDirBytes: await getDataDirSize(),
      memory: await readCgroupMemory(),
      lastBackupAt: await readLastBackupMarker(),
    },
  };
}
