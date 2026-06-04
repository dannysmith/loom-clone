import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { mkdir } from "fs/promises";
import { join } from "path";
import { createApp } from "../../../app";
import { getDb } from "../../../db/client";
import { videos } from "../../../db/schema";
import { listEvents } from "../../../lib/events";
import { markStepReady } from "../../../lib/processing/steps-store";
import { completeVideo, createVideo, DATA_DIR } from "../../../lib/store";
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

// POST with a urlencoded form body (CSRF-safe Origin included).
function postForm(fields: Record<string, string>) {
  return {
    method: "POST",
    headers: { Origin: "http://localhost", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  } as const;
}

async function setStatus(id: string, status: string): Promise<void> {
  await getDb()
    .update(videos)
    .set({ status: status as never })
    .where(eq(videos.id, id));
}

async function writeFile(id: string, rel: string): Promise<void> {
  const full = join(DATA_DIR, id, rel);
  await mkdir(join(full, ".."), { recursive: true });
  await Bun.write(full, "stub");
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

  test("rebuild=hls is refused when the HLS segments are gone", async () => {
    const app = createApp();
    const video = await createVideo();
    await setStatus(video.id, "processing_failed"); // no stream.m3u8 on disk

    const res = await app.request(
      `/admin/videos/${video.id}/reprocess`,
      postForm({ rebuild: "hls" }),
    );
    expect(res.status).toBe(400);
  });

  test("rebuild=hls is allowed when HLS is present", async () => {
    const app = createApp();
    const video = await createVideo();
    await setStatus(video.id, "processing_failed");
    await writeFile(video.id, "stream.m3u8");

    const res = await app.request(
      `/admin/videos/${video.id}/reprocess`,
      postForm({ rebuild: "hls" }),
    );
    expect(res.status).toBe(302);
    const events = await listEvents(video.id);
    expect(events.map((e) => e.type)).toContain("reprocess_requested");
  });
});

describe("POST /admin/videos/:id/reprocess/:kind", () => {
  test("regenerates a downstream artifact when source is valid", async () => {
    const app = createApp();
    const video = await createVideo();
    await completeVideo(video.id);
    await makeReadySource(video.id);

    const res = await app.request(`/admin/videos/${video.id}/reprocess/thumbnail`, POST);
    expect(res.status).toBe(302);
    const events = await listEvents(video.id);
    expect(events.map((e) => e.type)).toContain("reprocess_requested");
  });

  test("refused for a non-regenerable kind (source)", async () => {
    const app = createApp();
    const video = await createVideo();
    await completeVideo(video.id);
    await makeReadySource(video.id);

    const res = await app.request(`/admin/videos/${video.id}/reprocess/source`, POST);
    expect(res.status).toBe(400);
  });

  test("refused when source.mp4 is missing/invalid", async () => {
    const app = createApp();
    const video = await createVideo();
    await completeVideo(video.id); // no source.mp4, no source step

    const res = await app.request(`/admin/videos/${video.id}/reprocess/thumbnail`, POST);
    expect(res.status).toBe(400);
  });
});

// Give a ready video a validated source.mp4 (so it isn't read as data-loss).
async function makeReadySource(id: string): Promise<void> {
  const dir = join(DATA_DIR, id, "derivatives");
  await mkdir(dir, { recursive: true });
  await Bun.write(join(dir, "source.mp4"), "stub");
  await markStepReady(id, "source");
}

describe("video detail readiness section", () => {
  test("renders the checklist + Re-run button + a settled artifact's regen button", async () => {
    const app = createApp();
    const video = await createVideo();
    await completeVideo(video.id); // → ready
    await makeReadySource(video.id);
    // A settled (present) thumbnail so its row isn't ⏳ — regen buttons only
    // show on non-pending regenerable rows.
    await Bun.write(join(DATA_DIR, video.id, "derivatives", "thumbnail.jpg"), "stub");
    await markStepReady(video.id, "thumbnail");

    const res = await app.request(`/admin/videos/${video.id}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("readiness-section");
    expect(html).toContain("Source video");
    expect(html).toContain("Re-run post-processing");
    // Per-artifact regenerate button appears on the settled thumbnail row.
    expect(html).toContain(`/admin/videos/${video.id}/reprocess/thumbnail`);
  });

  test("shows the data-loss message when neither HLS nor a valid source exists", async () => {
    const app = createApp();
    const video = await createVideo();
    await completeVideo(video.id); // ready, but no files / step rows

    const html = await (await app.request(`/admin/videos/${video.id}`)).text();
    expect(html).toContain("readiness-dataloss");
    expect(html).not.toContain("Re-run post-processing");
  });
});
