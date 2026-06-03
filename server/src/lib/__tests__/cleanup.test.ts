import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { mkdir } from "fs/promises";
import { join } from "path";
import { getDb } from "../../db/client";
import { videos } from "../../db/schema";
import { setupTestEnv, type TestEnv, teardownTestEnv } from "../../test-utils";
import { cleanupStaleFiles } from "../cleanup";
import { markStepFailed, markStepReady } from "../processing/steps-store";
import { createVideo, DATA_DIR } from "../store";

let env: TestEnv;

beforeEach(async () => {
  env = await setupTestEnv();
});

afterEach(async () => {
  await teardownTestEnv(env);
});

const OLD = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

// Build a `ready` video, completed long ago, with HLS segments + a source.mp4
// derivative on disk. Returns its id and the key file paths.
async function makeStaleReadyVideo(): Promise<{ id: string; hls: string[]; source: string }> {
  const video = await createVideo();
  const dir = join(DATA_DIR, video.id);
  await mkdir(join(dir, "derivatives"), { recursive: true });

  const hls = [join(dir, "init.mp4"), join(dir, "stream.m3u8"), join(dir, "seg_0.m4s")];
  for (const f of hls) await Bun.write(f, "stub");
  const source = join(dir, "derivatives", "source.mp4");
  await Bun.write(source, "stub");

  await getDb()
    .update(videos)
    .set({ status: "ready", completedAt: OLD, fileBytes: 1000 })
    .where(eq(videos.id, video.id));

  return { id: video.id, hls, source };
}

describe("cleanupStaleFiles", () => {
  test("removes stale HLS when the source step is validated ready", async () => {
    const { id, hls, source } = await makeStaleReadyVideo();
    await markStepReady(id, "source");

    await cleanupStaleFiles();

    for (const f of hls) expect(await Bun.file(f).exists()).toBe(false);
    // The MP4 is kept — it's the only remaining copy.
    expect(await Bun.file(source).exists()).toBe(true);
  });

  test("does NOT remove HLS when the source step is failed (broken MP4 safety)", async () => {
    const { id, hls } = await makeStaleReadyVideo();
    // The byte-complete-but-broken-MP4 case from the incident: file present,
    // but validation marked it failed. HLS must survive.
    await markStepFailed(id, "source", "isProbablyPlayable failed");

    await cleanupStaleFiles();

    for (const f of hls) expect(await Bun.file(f).exists()).toBe(true);
  });

  test("does NOT remove HLS when there is no source step row at all", async () => {
    const { hls } = await makeStaleReadyVideo();
    // No markStep* call → no row → nothing validated → keep HLS.

    await cleanupStaleFiles();

    for (const f of hls) expect(await Bun.file(f).exists()).toBe(true);
  });

  test("ignores recently-ready videos", async () => {
    const { id, hls } = await makeStaleReadyVideo();
    await markStepReady(id, "source");
    await getDb()
      .update(videos)
      .set({ completedAt: new Date().toISOString() })
      .where(eq(videos.id, id));

    await cleanupStaleFiles();

    for (const f of hls) expect(await Bun.file(f).exists()).toBe(true);
  });
});
