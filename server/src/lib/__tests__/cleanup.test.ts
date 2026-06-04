import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { mkdir, stat } from "fs/promises";
import { join } from "path";
import { getDb } from "../../db/client";
import { videos } from "../../db/schema";
import { setupTestEnv, type TestEnv, teardownTestEnv } from "../../test-utils";
import { cleanupStaleFiles, markStalledRecordingsIncomplete } from "../cleanup";
import { markStepFailed, markStepReady } from "../processing/steps-store";
import { addSegment, createVideo, DATA_DIR, getVideo } from "../store";

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
    // A byte-complete but broken MP4: file present, but validation marked the
    // source step failed. The HLS must survive so the video stays playable.
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

  test("does NOT remove HLS for an edited video whose active {H}p.mp4 is missing", async () => {
    // Edited video: served file is 1080p.mp4, not source.mp4. source.mp4 is
    // valid and present, but the edited output is gone — the HLS fallback must
    // survive (resolve.ts would otherwise have nothing to serve).
    const { id, hls } = await makeStaleReadyVideo();
    await markStepReady(id, "source");
    await getDb()
      .update(videos)
      .set({ lastEditedAt: new Date().toISOString(), height: 1080 })
      .where(eq(videos.id, id));
    // No 1080p.mp4 on disk → active file missing.

    await cleanupStaleFiles();

    for (const f of hls) expect(await Bun.file(f).exists()).toBe(true);
  });

  test("removes the thumbnail-candidates directory (Bun dir-exists guard)", async () => {
    const { id } = await makeStaleReadyVideo();
    await markStepReady(id, "source");
    const candidatesDir = join(DATA_DIR, id, "derivatives", "thumbnail-candidates");
    await mkdir(candidatesDir, { recursive: true });
    await Bun.write(join(candidatesDir, "cand_0.jpg"), "stub");

    await cleanupStaleFiles();

    expect(
      await stat(candidatesDir)
        .then(() => true)
        .catch(() => false),
    ).toBe(false);
  });

  test("removes HLS for an edited video when its active {H}p.mp4 is present", async () => {
    const { id, hls } = await makeStaleReadyVideo();
    await markStepReady(id, "source");
    await getDb()
      .update(videos)
      .set({ lastEditedAt: new Date().toISOString(), height: 1080 })
      .where(eq(videos.id, id));
    await Bun.write(join(DATA_DIR, id, "derivatives", "1080p.mp4"), "stub"); // active file present

    await cleanupStaleFiles();

    for (const f of hls) expect(await Bun.file(f).exists()).toBe(false);
  });
});

const FIVE_HOURS_AGO = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();

describe("markStalledRecordingsIncomplete", () => {
  test("marks a recording with no activity for >4h as incomplete", async () => {
    const video = await createVideo();
    await getDb().update(videos).set({ createdAt: FIVE_HOURS_AGO }).where(eq(videos.id, video.id));

    await markStalledRecordingsIncomplete();

    expect((await getVideo(video.id))?.status).toBe("incomplete");
  });

  test("leaves a recording with a recent segment alone (activity-based)", async () => {
    const video = await createVideo();
    await getDb().update(videos).set({ createdAt: FIVE_HOURS_AGO }).where(eq(videos.id, video.id));
    // A segment uploaded just now → recent activity despite the old createdAt.
    await addSegment(video.id, "seg_000.m4s", 2);

    await markStalledRecordingsIncomplete();

    expect((await getVideo(video.id))?.status).toBe("recording");
  });

  test("leaves a freshly-created recording alone", async () => {
    const video = await createVideo();
    await markStalledRecordingsIncomplete();
    expect((await getVideo(video.id))?.status).toBe("recording");
  });

  test("ignores non-recording videos", async () => {
    const video = await createVideo();
    await getDb()
      .update(videos)
      .set({ status: "ready", createdAt: FIVE_HOURS_AGO })
      .where(eq(videos.id, video.id));

    await markStalledRecordingsIncomplete();

    expect((await getVideo(video.id))?.status).toBe("ready");
  });

  test("ignores trashed recordings", async () => {
    const video = await createVideo();
    await getDb()
      .update(videos)
      .set({ createdAt: FIVE_HOURS_AGO, trashedAt: new Date().toISOString() })
      .where(eq(videos.id, video.id));

    await markStalledRecordingsIncomplete();

    expect((await getVideo(video.id, { includeTrashed: true }))?.status).toBe("recording");
  });
});
