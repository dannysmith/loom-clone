// Migrating existing videos onto the presentation-master layout.
//
// The DB half already happened at deploy time (drizzle 0015: `source_pristine`
// derived from the legacy `audio` receipts, `edited_output` re-keyed to
// `presentation`). This is the file half, which needs ffmpeg and can take
// minutes, so it runs by hand afterwards.
//
// It is deliberately ADDITIVE. Nothing here deletes or rewrites a video file:
// the pristine originals are the one irreplaceable thing in the system, and a
// migration that can't damage them needs no recovery story. What it produces:
//
//   <H>p.mp4              the presentation master, copied from source.mp4 —
//                         which for a legacy video already carries the audio
//                         chain, so copying is exactly right and re-running the
//                         chain would double-process it
//   captions.original.srt the transcript's pristine copy, seeded from the served
//                         captions.srt that used to be the only copy
//
// A legacy EDITED video needs neither: its {H}p.mp4 already IS the master, and
// 0015 re-keyed the receipt that says so.
//
// To recover a genuinely pristine original for a video whose HLS segments are
// still on disk, use "Rebuild from HLS" in the admin afterwards rather than
// anything here. That re-stitches through the real pipeline, which flips
// `source_pristine` back to true and rebuilds the presentation properly.

import { copyFile, rename, stat, statfs } from "fs/promises";
import { join } from "path";
import { findOriginalCaptions, originalCaptionsPath } from "./captions";
import { probeMetadata } from "./derivatives";
import { DATA_DIR, derivativesDir } from "./paths";
import { inferStepsFromDisk } from "./processing/backfill";
import { isProbablyPlayable } from "./processing/playable";
import { reconcile } from "./processing/reconcile";
import { listVideos, type Video } from "./store";

export type VideoPlan = {
  id: string;
  slug: string;
  height: number | null;
  // The master to produce, or null when there's nothing to do.
  masterFile: string | null;
  masterAction: "create" | "already-present" | "no-source" | "no-height";
  // Bytes the master will add. Zero unless masterAction is "create".
  projectedBytes: number;
  seedCaptions: boolean;
  sourcePristine: boolean;
};

export type MigrationPlan = {
  videos: VideoPlan[];
  totalProjectedBytes: number;
};

// Work out what each video needs, touching nothing. This is what `--dry-run`
// prints and what the headroom check sums.
export async function planMigration(): Promise<MigrationPlan> {
  // Trashed videos included deliberately: they can be restored, and a restored
  // video with no master would be unservable.
  const videos = await listVideos({ includeTrashed: true });
  const plans: VideoPlan[] = [];
  for (const video of videos) {
    plans.push(await planVideo(video));
  }
  return {
    videos: plans,
    totalProjectedBytes: plans.reduce((total, p) => total + p.projectedBytes, 0),
  };
}

async function planVideo(video: Video): Promise<VideoPlan> {
  const dir = derivativesDir(video.id);
  const source = join(dir, "source.mp4");
  const base: VideoPlan = {
    id: video.id,
    slug: video.slug,
    height: video.height,
    masterFile: null,
    masterAction: "no-source",
    projectedBytes: 0,
    seedCaptions: await needsCaptionSeed(dir),
    sourcePristine: video.sourcePristine,
  };

  if (!(await Bun.file(source).exists())) return base;
  // Height names the master. A video that never got through metadata extraction
  // has none, and there's nothing sensible to call the file.
  const height = video.height ?? (await probeMetadata(source))?.height ?? null;
  if (!height) return { ...base, masterAction: "no-height" };

  const masterFile = `${height}p.mp4`;
  if (await Bun.file(join(dir, masterFile)).exists()) {
    return { ...base, height, masterFile, masterAction: "already-present" };
  }
  return {
    ...base,
    height,
    masterFile,
    masterAction: "create",
    projectedBytes: (await stat(source)).size,
  };
}

// The served captions used to be the only copy of the transcript. Copying them
// aside as the pristine original is what lets the captions step remap them onto
// an edited timeline later without losing the Mac's own segmentation.
async function needsCaptionSeed(dir: string): Promise<boolean> {
  if (await findOriginalCaptions(dir)) return false;
  return Bun.file(join(dir, "captions.srt")).exists();
}

export type MigrationResult = {
  plan: VideoPlan;
  mastersCreated: number;
  captionsSeeded: number;
  error?: string;
};

// Apply one video's plan. Idempotent: re-running skips anything already done, so
// an interrupted migration is fixed by running it again.
export async function migrateVideo(plan: VideoPlan): Promise<MigrationResult> {
  const dir = derivativesDir(plan.id);
  const result: MigrationResult = { plan, mastersCreated: 0, captionsSeeded: 0 };

  try {
    if (plan.masterAction === "create" && plan.masterFile) {
      const source = join(dir, "source.mp4");
      const final = join(dir, plan.masterFile);
      const tmp = `${final}.migrating`;
      // tmp→rename, so an interrupted copy can never leave a truncated file
      // where the serving gate expects a master.
      await copyFile(source, tmp);
      if (!(await isProbablyPlayable(tmp))) {
        await Bun.file(tmp)
          .delete()
          .catch(() => {});
        throw new Error(`copied master failed its playability check (${plan.masterFile})`);
      }
      await rename(tmp, final);
      result.mastersCreated = 1;
    }

    if (plan.seedCaptions) {
      await copyFile(join(dir, "captions.srt"), originalCaptionsPath(dir, "srt"));
      result.captionsSeeded = 1;
    }

    // Re-derive the ledger from what's now on disk, then let reconcile settle the
    // status. The ledger is a receipt, so re-deriving it is always safe.
    await inferStepsFromDisk(plan.id);
    await reconcile(plan.id, { running: false });
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }
  return result;
}

// Free bytes on the volume holding the data directory, for the headroom check.
export async function freeBytes(): Promise<number | null> {
  try {
    const fs = await statfs(DATA_DIR);
    return Number(fs.bsize) * Number(fs.bavail);
  } catch {
    return null;
  }
}
