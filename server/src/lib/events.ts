import { getDb } from "../db/client";
import { videoEvents } from "../db/schema";

// Appends a row to video_events. `type` is an open string — see the list in
// docs/tasks-todo/task-x2-proper-server-api.md. `data` is optional structured
// context, serialised as JSON. Per-segment uploads are deliberately NOT
// logged: 150 events per recording would drown out the audit trail.
export async function logEvent(videoId: string, type: string, data?: unknown): Promise<void> {
  const db = getDb();
  await db.insert(videoEvents).values({
    videoId,
    type,
    data: data === undefined ? null : JSON.stringify(data),
  });
}
