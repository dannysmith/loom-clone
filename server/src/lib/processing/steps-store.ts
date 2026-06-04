// DB accessors for video_processing_steps. One row per (videoId, kind)
// recording the outcome of each post-processing step — a generation/receipt
// ledger, not a live inventory (see the schema comment).
//
// External artifacts (transcript, words, the suggestion items) are Mac-sent;
// their rows are upserted by the API route handlers that receive them, via the
// same markStepReady helper the pipeline uses for server-produced steps.

import { and, eq } from "drizzle-orm";
import { getDb } from "../../db/client";
import {
  type ProcessingStepKind,
  type ProcessingStepState,
  type VideoProcessingStep,
  videoProcessingSteps,
} from "../../db/schema";
import { nowIso } from "../format";

export async function getSteps(videoId: string): Promise<VideoProcessingStep[]> {
  return getDb()
    .select()
    .from(videoProcessingSteps)
    .where(eq(videoProcessingSteps.videoId, videoId));
}

export async function getStep(
  videoId: string,
  kind: ProcessingStepKind,
): Promise<VideoProcessingStep | undefined> {
  return getDb()
    .select()
    .from(videoProcessingSteps)
    .where(and(eq(videoProcessingSteps.videoId, videoId), eq(videoProcessingSteps.kind, kind)))
    .get();
}

// Map of kind → state for cheap rollup logic (reconcile, UI).
export async function getStepStates(
  videoId: string,
): Promise<Map<ProcessingStepKind, VideoProcessingStep>> {
  const rows = await getSteps(videoId);
  const map = new Map<ProcessingStepKind, VideoProcessingStep>();
  for (const row of rows) map.set(row.kind, row);
  return map;
}

type UpsertFields = {
  state: ProcessingStepState;
  producedAt?: string | null;
  sizeBytes?: number | null;
  error?: string | null;
  // When true, bumps the informational attempts counter (a manual reprocess).
  incrementAttempts?: boolean;
};

// Upsert a step row, preserving the attempts counter across updates. The
// composite PK (videoId, kind) makes this idempotent.
export async function upsertStep(
  videoId: string,
  kind: ProcessingStepKind,
  fields: UpsertFields,
): Promise<void> {
  const db = getDb();
  const now = nowIso();
  const existing = await getStep(videoId, kind);
  const attempts = (existing?.attempts ?? 0) + (fields.incrementAttempts ? 1 : 0);

  const row = {
    videoId,
    kind,
    state: fields.state,
    producedAt:
      fields.producedAt ?? (fields.state === "ready" ? now : (existing?.producedAt ?? null)),
    sizeBytes: fields.sizeBytes ?? existing?.sizeBytes ?? null,
    error: fields.error ?? null,
    attempts,
    updatedAt: now,
  };

  await db
    .insert(videoProcessingSteps)
    .values(row)
    .onConflictDoUpdate({
      target: [videoProcessingSteps.videoId, videoProcessingSteps.kind],
      set: {
        state: row.state,
        producedAt: row.producedAt,
        sizeBytes: row.sizeBytes,
        error: row.error,
        attempts: row.attempts,
        updatedAt: row.updatedAt,
      },
    });
}

export async function markStepReady(
  videoId: string,
  kind: ProcessingStepKind,
  opts: { sizeBytes?: number | null } = {},
): Promise<void> {
  await upsertStep(videoId, kind, {
    state: "ready",
    sizeBytes: opts.sizeBytes ?? null,
    error: null,
  });
}

export async function markStepFailed(
  videoId: string,
  kind: ProcessingStepKind,
  error: string,
): Promise<void> {
  await upsertStep(videoId, kind, { state: "failed", error: error.slice(0, 2000) });
}

// Byte size of an artifact for the sizeBytes column, or null if unavailable.
export function fileSizeBytes(path: string): number | null {
  try {
    const size = Bun.file(path).size;
    return Number.isFinite(size) ? size : null;
  } catch {
    return null;
  }
}

export async function markStepSkipped(videoId: string, kind: ProcessingStepKind): Promise<void> {
  await upsertStep(videoId, kind, { state: "skipped", error: null });
}
