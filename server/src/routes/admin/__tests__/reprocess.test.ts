import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "../../../app";
import { getDb } from "../../../db/client";
import { videos } from "../../../db/schema";
import { listEvents } from "../../../lib/events";
import { completeVideo, createVideo } from "../../../lib/store";
import { setupTestEnv, type TestEnv, teardownTestEnv } from "../../../test-utils";

// Admin mutations are CSRF-protected; a matching Origin satisfies the check.
const POST = { method: "POST", headers: { Origin: "http://localhost" } } as const;

let env: TestEnv;

beforeEach(async () => {
  env = await setupTestEnv();
});

afterEach(async () => {
  await teardownTestEnv(env);
});

async function setStatus(id: string, status: string): Promise<void> {
  await getDb()
    .update(videos)
    .set({ status: status as never })
    .where(eq(videos.id, id));
}

describe("POST /admin/videos/:id/reprocess", () => {
  test("schedules the pipeline and logs an event for a processing_failed video", async () => {
    const app = createApp();
    const video = await createVideo();
    await setStatus(video.id, "processing_failed");

    const res = await app.request(`/admin/videos/${video.id}/reprocess`, POST);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/admin/videos/${video.id}`);

    const events = await listEvents(video.id);
    expect(events.map((e) => e.type)).toContain("reprocess_requested");
  });

  test("refused (400) for a recording video", async () => {
    const app = createApp();
    const video = await createVideo(); // status: recording

    const res = await app.request(`/admin/videos/${video.id}/reprocess`, POST);
    expect(res.status).toBe(400);
  });
});

describe("video detail readiness section", () => {
  test("renders the checklist + Re-run button for a ready video", async () => {
    const app = createApp();
    const video = await createVideo();
    await completeVideo(video.id); // → ready

    const res = await app.request(`/admin/videos/${video.id}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("readiness-section");
    expect(html).toContain("Source video");
    expect(html).toContain("Re-run post-processing");
  });
});
