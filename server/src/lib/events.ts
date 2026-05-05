import { asc, eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { type VideoEvent, videoEvents } from "../db/schema";

// Known event types. The DB column is an open string (no migration needed to
// add types), but this union catches typos at compile time in app code.
export type EventType =
  | "created"
  | "completed"
  | "healed"
  | "trashed"
  | "untrashed"
  | "duplicated"
  | "duplicated_from"
  | "title_changed"
  | "description_changed"
  | "notes_changed"
  | "visibility_changed"
  | "slug_changed"
  | "tag_added"
  | "tag_removed"
  | "uploaded"
  | "thumbnail_promoted"
  | "thumbnail_uploaded"
  | "derivatives_ready"
  | "transcript_uploaded"
  | "words_uploaded"
  | "title_suggested"
  | "edits_committed";

// Returns all events for a video, oldest first. The `data` field is raw
// JSON text — callers parse it as needed for display.
export async function listEvents(videoId: string): Promise<VideoEvent[]> {
  return getDb()
    .select()
    .from(videoEvents)
    .where(eq(videoEvents.videoId, videoId))
    .orderBy(asc(videoEvents.createdAt));
}

// Appends a row to video_events. `data` is optional structured context,
// serialised as JSON. Per-segment uploads are deliberately NOT logged:
// 150 events per recording would drown out the audit trail.
export async function logEvent(videoId: string, type: EventType, data?: unknown): Promise<void> {
  const db = getDb();
  await db.insert(videoEvents).values({
    videoId,
    type,
    data: data === undefined ? null : JSON.stringify(data),
  });
}
