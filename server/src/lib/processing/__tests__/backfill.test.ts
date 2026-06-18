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
const ffmpegAvailable = Bun.which("ffmpeg") !== null && ffprobeAvailable;

// A real 2-second MP4 so isProbablyPlayable can actually probe it.
async function writeRealMp4(path: string): Promise<void> {
  const proc = Bun.spawn(
    [
      "ffmpeg",
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc=duration=2:size=320x240:rate=15",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-movflags",
      "+faststart",
      "-f",
      "mp4",
      path,
    ],
    { stderr: "pipe", stdout: "pipe" },
  );
  await proc.exited;
}

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

  // For edited videos durationSeconds is the EDITED length, but source.mp4 is
  // the longer original. The duration tolerance check must be skipped so the
  // original isn't wrongly marked failed.
  test.skipIf(!ffmpegAvailable)(
    "an edited video's source.mp4 is validated structurally, not against the edited duration",
    async () => {
      const video = await createVideo();
      const dir = join(DATA_DIR, video.id, "derivatives");
      await mkdir(dir, { recursive: true });
      await writeRealMp4(join(dir, "source.mp4")); // ~2s

      // durationSeconds reflects a trimmed edit (well outside the 2s tolerance);
      // lastEditedAt marks it as edited.
      await getDb()
        .update(videos)
        .set({ durationSeconds: 10, lastEditedAt: new Date().toISOString(), height: 240 })
        .where(eq(videos.id, video.id));

      await inferStepsFromDisk(video.id);
      expect((await getStepStates(video.id)).get("source")?.state).toBe("ready");
    },
  );

  // The edited cut ({H}p.mp4) is the file an edited video serves. resolve.ts +
  // cleanup gate it on a `ready` edited_output step (P4.8), and duplicateVideo
  // re-derives its ledger via inferStepsFromDisk — so a backfilled or duplicated
  // edited video must gain a ready edited_output row to keep serving its cut.
  test.skipIf(!ffmpegAvailable)(
    "an edited video's cut is inferred as a ready edited_output step",
    async () => {
      const video = await createVideo();
      const dir = join(DATA_DIR, video.id, "derivatives");
      await mkdir(dir, { recursive: true });
      await writeRealMp4(join(dir, "source.mp4")); // preserved original
      await writeRealMp4(join(dir, "240p.mp4")); // the edited cut (active file)
      await getDb()
        .update(videos)
        .set({ durationSeconds: 2, lastEditedAt: new Date().toISOString(), height: 240 })
        .where(eq(videos.id, video.id));

      await inferStepsFromDisk(video.id);
      expect((await getStepStates(video.id)).get("edited_output")?.state).toBe("ready");
    },
  );

  test.skipIf(!ffmpegAvailable)(
    "an unedited video's source.mp4 IS duration-checked (mismatch → failed)",
    async () => {
      const video = await createVideo();
      const dir = join(DATA_DIR, video.id, "derivatives");
      await mkdir(dir, { recursive: true });
      await writeRealMp4(join(dir, "source.mp4")); // ~2s

      // Not edited, but durationSeconds is wildly wrong → the check should fail.
      await getDb()
        .update(videos)
        .set({ durationSeconds: 10, height: 240 })
        .where(eq(videos.id, video.id));

      await inferStepsFromDisk(video.id);
      expect((await getStepStates(video.id)).get("source")?.state).toBe("failed");
    },
  );
});
