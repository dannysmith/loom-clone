import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { mkdir } from "fs/promises";
import { join } from "path";
import { createApp } from "../../../app";
import { getDb } from "../../../db/client";
import { videos } from "../../../db/schema";
import { readChapters, writeChapters } from "../../../lib/chapters";
import { createVideo, DATA_DIR } from "../../../lib/store";
import { setupTestEnv, type TestEnv, teardownTestEnv } from "../../../test-utils";

async function setDuration(videoId: string, seconds: number) {
  await getDb().update(videos).set({ durationSeconds: seconds }).where(eq(videos.id, videoId));
}

let env: TestEnv;
beforeEach(async () => {
  env = await setupTestEnv();
});
afterEach(async () => {
  await teardownTestEnv(env);
});

const ORIGIN = "http://localhost";

async function writeEdits(videoId: string, edits: unknown[]) {
  const dir = join(DATA_DIR, videoId, "derivatives");
  await mkdir(dir, { recursive: true });
  await Bun.write(join(dir, "edits.json"), JSON.stringify({ version: 1, edits }));
}

describe("GET /admin/videos/:id/chapters", () => {
  test("returns an empty list when no chapters.json exists", async () => {
    const app = createApp();
    const video = await createVideo();
    const res = await app.request(`/admin/videos/${video.id}/chapters`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: 1, chapters: [] });
  });

  test("returns chapters in viewer timeline (no edits = pass-through)", async () => {
    const app = createApp();
    const video = await createVideo();
    await setDuration(video.id, 60);
    await writeChapters(video.id, [
      { id: "a", title: "Intro", t: 5, createdDuringRecording: true },
      { id: "b", title: null, t: 30, createdDuringRecording: true },
    ]);
    const res = await app.request(`/admin/videos/${video.id}/chapters`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { chapters: { id: string; t: number }[] };
    expect(body.chapters.map((c) => ({ id: c.id, t: c.t }))).toEqual([
      { id: "a", t: 5 },
      { id: "b", t: 30 },
    ]);
  });

  test("remaps chapter times through the EDL when edits exist", async () => {
    const app = createApp();
    const video = await createVideo();
    await setDuration(video.id, 100);
    await writeEdits(video.id, [{ type: "cut", startTime: 20, endTime: 40 }]);
    await writeChapters(video.id, [
      { id: "a", title: null, t: 10, createdDuringRecording: true },
      { id: "b", title: null, t: 30, createdDuringRecording: true }, // in cut
      { id: "c", title: null, t: 50, createdDuringRecording: true },
    ]);
    const res = await app.request(`/admin/videos/${video.id}/chapters`);
    const body = (await res.json()) as { chapters: { id: string; t: number }[] };
    expect(body.chapters.map((c) => c.id)).toEqual(["a", "c"]);
    expect(body.chapters.map((c) => c.t)).toEqual([10, 30]);
  });
});

describe("PUT /admin/videos/:id/chapters", () => {
  test("creates chapters.json from a bulk save", async () => {
    const app = createApp();
    const video = await createVideo();
    await setDuration(video.id, 60);
    const res = await app.request(`/admin/videos/${video.id}/chapters`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({
        version: 1,
        chapters: [
          { id: "new-1", title: "Hello", t: 12 },
          { id: "new-2", title: null, t: 30 },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const stored = await readChapters(video.id);
    expect(stored?.chapters).toHaveLength(2);
    expect(stored?.chapters[0]).toMatchObject({
      id: "new-1",
      title: "Hello",
      t: 12,
      createdDuringRecording: false,
    });
  });

  test("preserves createdDuringRecording on existing chapters", async () => {
    const app = createApp();
    const video = await createVideo();
    await setDuration(video.id, 60);
    await writeChapters(video.id, [{ id: "rec", title: null, t: 5, createdDuringRecording: true }]);
    const res = await app.request(`/admin/videos/${video.id}/chapters`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({
        version: 1,
        chapters: [
          { id: "rec", title: "Intro", t: 5 },
          { id: "manual", title: "Mid", t: 30 },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const stored = await readChapters(video.id);
    const byId = new Map(stored!.chapters.map((c) => [c.id, c]));
    expect(byId.get("rec")?.createdDuringRecording).toBe(true);
    expect(byId.get("rec")?.title).toBe("Intro");
    expect(byId.get("manual")?.createdDuringRecording).toBe(false);
  });

  test("reverse-maps viewer-timeline times back to recording timeline", async () => {
    const app = createApp();
    const video = await createVideo();
    await setDuration(video.id, 100);
    await writeEdits(video.id, [{ type: "cut", startTime: 20, endTime: 40 }]);
    const res = await app.request(`/admin/videos/${video.id}/chapters`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({
        version: 1,
        chapters: [{ id: "x", title: "After cut", t: 25 }],
      }),
    });
    expect(res.status).toBe(200);
    const stored = await readChapters(video.id);
    // Viewer t=25 with cut 20-40 maps back to recording t=45
    expect(stored?.chapters[0]?.t).toBe(45);
  });

  test("rejects duplicate chapter IDs", async () => {
    const app = createApp();
    const video = await createVideo();
    await setDuration(video.id, 60);
    const res = await app.request(`/admin/videos/${video.id}/chapters`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({
        version: 1,
        chapters: [
          { id: "dup", title: null, t: 1 },
          { id: "dup", title: null, t: 2 },
        ],
      }),
    });
    expect(res.status).toBe(400);
  });

  test("rejects malformed bodies (empty title coerced, missing t rejected)", async () => {
    const app = createApp();
    const video = await createVideo();
    const res = await app.request(`/admin/videos/${video.id}/chapters`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({ version: 1, chapters: [{ id: "x", title: "z" }] }),
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /admin/videos/:id/media/chapters.vtt", () => {
  test("returns 404 when no chapters exist", async () => {
    const app = createApp();
    const video = await createVideo();
    const res = await app.request(`/admin/videos/${video.id}/media/chapters.vtt`);
    expect(res.status).toBe(404);
  });

  test("serves WebVTT chapter cues for an unedited video", async () => {
    const app = createApp();
    const video = await createVideo();
    await setDuration(video.id, 60);
    await writeChapters(video.id, [
      { id: "a", title: "Intro", t: 0, createdDuringRecording: true },
      { id: "b", title: "Main", t: 20, createdDuringRecording: true },
    ]);
    const res = await app.request(`/admin/videos/${video.id}/media/chapters.vtt`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/vtt");
    const body = await res.text();
    expect(body).toContain("WEBVTT");
    expect(body).toContain("Intro");
    expect(body).toContain("Main");
  });

  test("admin variant works for trashed videos", async () => {
    const app = createApp();
    const video = await createVideo();
    await setDuration(video.id, 60);
    await writeChapters(video.id, [{ id: "a", title: "x", t: 0, createdDuringRecording: true }]);
    const { trashVideo } = await import("../../../lib/store");
    await trashVideo(video.id);
    const res = await app.request(`/admin/videos/${video.id}/media/chapters.vtt`);
    expect(res.status).toBe(200);
  });
});
