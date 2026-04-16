import { eq, sql } from "drizzle-orm";
import { mkdir } from "fs/promises";
import { join } from "path";
import { getDb } from "../db/client";
import { type Video, videoSegments, videos } from "../db/schema";
import { logEvent } from "./events";

export const DATA_DIR = "data";

// Back-compat alias — routes and tests that imported VideoRecord continue to
// work. The new shape has extra fields (visibility, source, timestamps,
// nullable metadata) but that's additive and non-breaking.
export type VideoRecord = Video;

function nowIso(): string {
  return new Date().toISOString();
}

function generateSlug(): string {
  return crypto
    .getRandomValues(new Uint8Array(4))
    .reduce((s, b) => s + b.toString(16).padStart(2, "0"), "");
}

export async function createVideo(): Promise<Video> {
  const db = getDb();
  const id = crypto.randomUUID();
  const slug = generateSlug();
  const now = nowIso();

  const [video] = await db
    .insert(videos)
    .values({ id, slug, createdAt: now, updatedAt: now })
    .returning();
  if (!video) throw new Error("failed to create video");

  await mkdir(join(DATA_DIR, id), { recursive: true });
  await logEvent(id, "created");
  return video;
}

export async function getVideo(id: string): Promise<Video | undefined> {
  return getDb().select().from(videos).where(eq(videos.id, id)).get();
}

export async function getVideoBySlug(slug: string): Promise<Video | undefined> {
  return getDb().select().from(videos).where(eq(videos.slug, slug)).get();
}

// Idempotent: same filename overwrites its duration. Upsert on the composite
// primary key handles duplicates cleanly.
export async function addSegment(id: string, filename: string, duration: number): Promise<void> {
  const db = getDb();
  const exists = await getVideo(id);
  if (!exists) throw new Error(`Video ${id} not found`);
  await db
    .insert(videoSegments)
    .values({ videoId: id, filename, durationSeconds: duration, uploadedAt: nowIso() })
    .onConflictDoUpdate({
      target: [videoSegments.videoId, videoSegments.filename],
      set: { durationSeconds: duration, uploadedAt: nowIso() },
    });
}

export async function getSegmentDurations(id: string): Promise<Map<string, number>> {
  const rows = await getDb()
    .select({ filename: videoSegments.filename, duration: videoSegments.durationSeconds })
    .from(videoSegments)
    .where(eq(videoSegments.videoId, id));
  const map = new Map<string, number>();
  for (const row of rows) map.set(row.filename, row.duration);
  return map;
}

async function sumSegmentDuration(id: string): Promise<number> {
  const [row] = await getDb()
    .select({ total: sql<number>`COALESCE(SUM(${videoSegments.durationSeconds}), 0)` })
    .from(videoSegments)
    .where(eq(videoSegments.videoId, id));
  return row?.total ?? 0;
}

export async function setVideoStatus(id: string, status: Video["status"]): Promise<Video> {
  const db = getDb();
  const existing = await getVideo(id);
  if (!existing) throw new Error(`Video ${id} not found`);
  if (existing.status === status) return existing;

  const now = nowIso();
  const updates: Partial<Video> = { status, updatedAt: now };

  // Cache duration and set completedAt on transition TO complete. completedAt
  // is set-once so a healing→complete→(something weird)→complete chain keeps
  // the original timestamp. Duration is always recomputed so segments added
  // during healing get reflected.
  if (status === "complete") {
    updates.durationSeconds = await sumSegmentDuration(id);
    if (!existing.completedAt) updates.completedAt = now;
  }

  const [video] = await db.update(videos).set(updates).where(eq(videos.id, id)).returning();
  if (!video) throw new Error(`Video ${id} not found`);

  if (status === "complete") {
    const eventType = existing.status === "healing" ? "healed" : "completed";
    await logEvent(id, eventType);
  }

  return video;
}

// Thin shim retained so routes and tests don't all need updating.
export async function completeVideo(id: string): Promise<Video> {
  return setVideoStatus(id, "complete");
}

export async function deleteVideo(id: string): Promise<Video | undefined> {
  const db = getDb();
  const video = await getVideo(id);
  if (!video) return undefined;
  // FK cascades handle video_segments, slug_redirects, video_tags, video_events.
  await db.delete(videos).where(eq(videos.id, id));
  return video;
}
