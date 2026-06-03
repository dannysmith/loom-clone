import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { mkdir } from "fs/promises";
import { join } from "path";
import { getDb } from "../../../db/client";
import { videos } from "../../../db/schema";
import { setupTestEnv, type TestEnv, teardownTestEnv } from "../../../test-utils";
import { createVideo, DATA_DIR } from "../../store";
import { inferStepsFromDisk } from "../backfill";
import { getStepStates } from "../steps-store";

const ffprobeAvailable = Bun.which("ffprobe") !== null;

let env: TestEnv;

beforeEach(async () => {
  env = await setupTestEnv();
});

afterEach(async () => {
  await teardownTestEnv(env);
});

describe("inferStepsFromDisk", () => {
  test("text-derivative steps are inferred from on-disk presence", async () => {
    const video = await createVideo();
    const dir = join(DATA_DIR, video.id, "derivatives");
    await mkdir(dir, { recursive: true });
    await Bun.write(join(dir, "peaks.json"), "[]");
    await Bun.write(join(dir, "words.json"), "[]");
    // Stored dimensions + duration imply metadata extraction previously
    // succeeded (real videos cache duration at footage-complete).
    await getDb()
      .update(videos)
      .set({ width: 1280, height: 720, durationSeconds: 120 })
      .where(eq(videos.id, video.id));

    await inferStepsFromDisk(video.id);

    const steps = await getStepStates(video.id);
    expect(steps.get("peaks")?.state).toBe("ready");
    expect(steps.get("words")?.state).toBe("ready");
    expect(steps.get("metadata")?.state).toBe("ready");
    // No source.mp4 on disk → no source row (nothing to serve).
    expect(steps.get("source")).toBeUndefined();
  });

  test.skipIf(!ffprobeAvailable)(
    "a present-but-unplayable source.mp4 is marked failed, not ready",
    async () => {
      const video = await createVideo();
      const dir = join(DATA_DIR, video.id, "derivatives");
      await mkdir(dir, { recursive: true });
      // Not a real MP4 — isProbablyPlayable will reject it.
      await Bun.write(join(dir, "source.mp4"), "definitely not an mp4");

      await inferStepsFromDisk(video.id);

      expect((await getStepStates(video.id)).get("source")?.state).toBe("failed");
    },
  );
});
