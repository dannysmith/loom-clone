import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { mkdir } from "fs/promises";
import { join } from "path";
import { createApp } from "../../../app";
import { getDb } from "../../../db/client";
import { videos } from "../../../db/schema";
import { clearRunActive, markRunActive } from "../../../lib/processing/run-lock";
import { createVideo, DATA_DIR } from "../../../lib/store";
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

async function setReady(id: string): Promise<void> {
  await getDb().update(videos).set({ status: "ready" }).where(eq(videos.id, id));
}

async function writeEdl(id: string): Promise<void> {
  const dir = join(DATA_DIR, id, "derivatives");
  await mkdir(dir, { recursive: true });
  await Bun.write(
    join(dir, "edits.json"),
    JSON.stringify({ version: 1, source: "source.mp4", edits: [] }),
  );
}

// [P1.1] reconcile publishes `ready` the moment source+metadata validate, while
// the same run is still rewriting source.mp4 (audio) and cutting variants. The
// editor must stay closed during that window so two writers can't race on one
// derivatives/ dir.
describe("editor gate vs. in-flight post-processing run", () => {
  test("blocks the editor page while a run is in flight, allows it once settled", async () => {
    const app = createApp();
    const video = await createVideo();
    await setReady(video.id);

    markRunActive(video.id);
    const blocked = await app.request(`/admin/videos/${video.id}/editor`);
    expect(blocked.status).toBe(409);

    clearRunActive(video.id);
    const allowed = await app.request(`/admin/videos/${video.id}/editor`);
    expect(allowed.status).toBe(200);
  });

  test("rejects commit while a run is in flight", async () => {
    const app = createApp();
    const video = await createVideo();
    await setReady(video.id);
    await writeEdl(video.id);

    markRunActive(video.id);
    try {
      const res = await app.request(`/admin/videos/${video.id}/editor/commit`, POST);
      expect(res.status).toBe(409);
    } finally {
      clearRunActive(video.id);
    }
  });
});
