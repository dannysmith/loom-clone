// Whole-video lifecycle operations: the cross-layer orchestration (file
// copying, ledger re-inference, status rollup, feed purging) that duplicating
// or permanently deleting a video needs. These sit beside `store.ts` and use
// it rather than living in it — the store is the data-access layer, and when
// orchestration accumulated there it became the module the whole lib routed
// through. New orchestration belongs here, not in the store.

import { eq } from "drizzle-orm";
import { cp, mkdir, rm } from "fs/promises";
import { join } from "path";
import { getDb } from "../db/client";
import { slugRedirects, type Video, videoSegments, videos, videoTags } from "../db/schema";
import { purgeGlobalFeeds } from "./cdn";
import { ConflictError } from "./errors";
import { logEvent } from "./events";
import { getVideoDirSize } from "./files";
import { nowIso } from "./format";
import { DATA_DIR } from "./paths";
import { inferStepsFromDisk } from "./processing/backfill";
import { rollupFromSteps } from "./processing/reconcile";
import { hasActiveRun } from "./processing/run-lock";
import { getStepStates } from "./processing/steps-store";
import { POST_FOOTAGE_STATUSES } from "./status";
import {
  findAvailableSlug,
  getSegmentDurations,
  getTranscript,
  getVideo,
  markVideoReady,
  setVideoStatus,
  upsertTranscript,
} from "./store";
import { getVideoTags } from "./tags";

// Permanently deletes a trashed video: logs details, removes files from disk,
// and hard-deletes the DB record (CASCADE cleans up all related tables).
export async function permanentlyDeleteVideo(id: string): Promise<void> {
  const db = getDb();
  const video = await getVideo(id, { includeTrashed: true });
  if (!video) throw new Error(`Video ${id} not found`);
  if (!video.trashedAt) throw new Error(`Video ${id} is not trashed`);

  // A processing run holds file handles into the directory about to be rm'd
  // and would recreate parts of it after the delete. Refuse rather than race —
  // retry once the run settles.
  if (hasActiveRun(id)) {
    throw new ConflictError("A processing run is in flight for this video — try again shortly");
  }

  const originalStatus = video.status;

  // Mark as deleting to prevent concurrent restore.
  await db.update(videos).set({ status: "deleting" }).where(eq(videos.id, id));

  // Gather data for the deletion log.
  const [tags, transcript, segments, redirects, diskBytes] = await Promise.all([
    getVideoTags(id),
    getTranscript(id),
    getSegmentDurations(id),
    db
      .select({ oldSlug: slugRedirects.oldSlug })
      .from(slugRedirects)
      .where(eq(slugRedirects.videoId, id)),
    getVideoDirSize(id),
  ]);

  const deletionLog = {
    event: "permanently_deleted",
    id: video.id,
    slug: video.slug,
    title: video.title,
    description: video.description,
    notes: video.notes,
    status: originalStatus,
    visibility: video.visibility,
    source: video.source,
    durationSeconds: video.durationSeconds,
    fileBytes: video.fileBytes,
    width: video.width,
    height: video.height,
    createdAt: video.createdAt,
    completedAt: video.completedAt,
    trashedAt: video.trashedAt,
    deletedAt: nowIso(),
    tags: tags.map((t) => t.name),
    redirectSlugs: redirects.map((r) => r.oldSlug),
    segmentCount: segments.size,
    transcriptWordCount: transcript?.wordCount ?? null,
    diskBytes,
  };
  console.log(`[permanent-delete] ${JSON.stringify(deletionLog)}`);

  // Delete files from disk.
  await rm(join(DATA_DIR, id), { recursive: true, force: true });

  // Hard-delete from DB — CASCADE handles segments, events, tags, redirects, transcripts.
  await db.delete(videos).where(eq(videos.id, id));
}

// Creates a complete copy of a video: new UUID, new slug, new title suffix,
// all files copied, tags preserved, events on both original and duplicate.
export async function duplicateVideo(id: string): Promise<Video> {
  const db = getDb();
  const original = await getVideo(id, { includeTrashed: true });
  if (!original) throw new Error(`Video ${id} not found`);

  const newId = crypto.randomUUID();
  const newSlug = await findAvailableSlug(original.slug);
  const newTitle = original.title ? findAvailableTitle(original.title) : null;
  const now = nowIso();

  // Insert the new video row with preserved metadata.
  const [duplicate] = await db
    .insert(videos)
    .values({
      id: newId,
      slug: newSlug,
      status: original.status,
      visibility: original.visibility,
      title: newTitle,
      description: original.description,
      notes: original.notes,
      durationSeconds: original.durationSeconds,
      width: original.width,
      height: original.height,
      aspectRatio: original.aspectRatio,
      fileBytes: original.fileBytes,
      cameraName: original.cameraName,
      microphoneName: original.microphoneName,
      recordingHealth: original.recordingHealth,
      source: original.source,
      createdAt: now,
      updatedAt: now,
      completedAt: original.completedAt ? now : null,
      // Preserve the edited timestamp verbatim — it records when the content was
      // edited, and the copied presentation master IS that edit. The copy's
      // edits.json comes across with the files, so a rebuild of the duplicate
      // reproduces the same cut.
      lastEditedAt: original.lastEditedAt,
      // Whether the copied source.mp4 is pristine is a property of the file, so
      // it travels with it. Getting this wrong on a copy would either double-
      // process its audio or leave a pristine source unprocessed.
      sourcePristine: original.sourcePristine,
    })
    .returning();
  if (!duplicate) throw new Error("Failed to create duplicate video");

  // Copy tag associations.
  const originalTags = await db
    .select({ tagId: videoTags.tagId })
    .from(videoTags)
    .where(eq(videoTags.videoId, id));
  for (const { tagId } of originalTags) {
    await db.insert(videoTags).values({ videoId: newId, tagId }).onConflictDoNothing();
  }

  // Copy segment records.
  const originalSegments = await db
    .select()
    .from(videoSegments)
    .where(eq(videoSegments.videoId, id));
  for (const seg of originalSegments) {
    await db.insert(videoSegments).values({
      videoId: newId,
      filename: seg.filename,
      durationSeconds: seg.durationSeconds,
      uploadedAt: now,
    });
  }

  // Copy files on disk.
  const srcDir = join(DATA_DIR, id);
  const dstDir = join(DATA_DIR, newId);
  try {
    await cp(srcDir, dstDir, { recursive: true });
  } catch {
    // Source dir may not exist (e.g. in tests). The video record is still valid.
    await mkdir(dstDir, { recursive: true });
  }

  // Copy the transcript. The captions file was copied above, but the
  // video_transcripts row and FTS index are keyed per-id and must be
  // re-inserted — otherwise the copy's transcript tab + search are empty and
  // (since the transcript step infers from the DB row, not the file) its
  // readiness shows transcript missing. Must run before inferStepsFromDisk so
  // the transcript step infers `ready`.
  const originalTranscript = await getTranscript(id);
  if (originalTranscript) {
    await upsertTranscript(newId, originalTranscript.format, originalTranscript.plainText);
  }

  // Re-derive video_processing_steps from the copied files rather than cloning
  // the original's rows — the table is gated for serving, and re-deriving
  // avoids carrying over stale state.
  await inferStepsFromDisk(newId);

  // Normalise the copy's status from the inferred ledger rather than trusting
  // the value copied from the original, using the SAME rollup reconcile uses (so
  // a mid-`processing` copy lands on `processing`, not mislabelled
  // `processing_failed`): a duplicate of a mid-edit (`reprocessing`) video would
  // otherwise be stranded (no owner ever settles it), and a copy whose source
  // can't be validated would sit at `ready` while the serving gate refuses it.
  // Only for post-footage statuses — a footage-state original
  // (recording/healing/incomplete) mirrors its footage, not the derivative ledger.
  if (POST_FOOTAGE_STATUSES.has(original.status)) {
    const rollup = rollupFromSteps(await getStepStates(newId));
    if (rollup === "ready") {
      await markVideoReady(newId); // stamps completedAt (set-once)
      // markVideoReady only publishes feeds when it actually transitions; a copy
      // inserted as `ready` (from a `ready` original) makes it a no-op, so purge
      // explicitly — the duplicate is a new public-facing video.
      purgeGlobalFeeds();
    } else if (duplicate.status !== rollup) {
      await setVideoStatus(newId, rollup);
    }
  }

  // Log events on both videos.
  await logEvent(id, "duplicated", { newId: newId, newSlug });
  await logEvent(newId, "duplicated_from", { originalId: id, originalSlug: original.slug });

  return (await getVideo(newId, { includeTrashed: true })) ?? duplicate;
}

// Appends " (1)" to a title, stripping any existing " (N)" suffix first.
// Titles aren't unique so no DB check needed — just increment the suffix.
function findAvailableTitle(baseTitle: string): string {
  const match = baseTitle.match(/^(.*) \((\d+)\)$/);
  if (match?.[1] != null && match[2] != null) {
    return `${match[1]} (${Number(match[2]) + 1})`;
  }
  return `${baseTitle} (1)`;
}
