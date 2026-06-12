import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { mkdir } from "fs/promises";
import { join } from "path";
import { getDb } from "../../db/client";
import { videos } from "../../db/schema";
import { setupTestEnv, type TestEnv, teardownTestEnv } from "../../test-utils";
import { resetAllEdits } from "../edit-reset";
import { _drainInFlight, scheduleEdit } from "../processing/pipeline";
import { markStepReady } from "../processing/steps-store";
import { createVideo, DATA_DIR, getTranscript, getVideo } from "../store";

const ffmpegAvailable = Bun.which("ffmpeg") !== null && Bun.which("ffprobe") !== null;

let env: TestEnv;
beforeEach(async () => {
  env = await setupTestEnv();
});
afterEach(async () => {
  await teardownTestEnv(env);
});

async function write1080pSource(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
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
      "testsrc=duration=3:size=1920x1080:rate=15",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=3:sample_rate=48000",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-c:a",
      "aac",
      "-movflags",
      "+faststart",
      "-f",
      "mp4",
      join(dir, "source.mp4"),
    ],
    { stderr: "pipe", stdout: "pipe" },
  );
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`source fixture failed: ${stderr}`);
}

const TRIM_EDL = JSON.stringify({
  version: 1,
  source: "source.mp4",
  edits: [{ type: "trim", startTime: 0.5, endTime: 2.5 }],
});

describe("resetAllEdits", () => {
  test.skipIf(!ffmpegAvailable)(
    "washes the edit away: deletes edited outputs, clears lastEditedAt, resets metadata + transcript",
    async () => {
      const video = await createVideo();
      const dir = join(DATA_DIR, video.id, "derivatives");
      await write1080pSource(dir);
      await Bun.write(join(dir, "edits.json"), TRIM_EDL);
      await Bun.write(
        join(dir, "words.json"),
        JSON.stringify([
          { word: "hello", start: 0.6, end: 0.9 }, // inside the 0.5–2.5 trim
          { word: "world", start: 2.6, end: 2.9 }, // after the trim → dropped by the edit
        ]),
      );
      await markStepReady(video.id, "source");
      await markStepReady(video.id, "metadata");
      await getDb()
        .update(videos)
        .set({ status: "ready", width: 1920, height: 1080, durationSeconds: 3 })
        .where(eq(videos.id, video.id));

      // Commit an edit through the unified pipeline, then wash it away.
      scheduleEdit(video.id, "recorded");
      await _drainInFlight();

      const edited = await getVideo(video.id);
      expect(edited?.lastEditedAt).not.toBeNull();
      expect(await Bun.file(join(dir, "1080p.mp4")).exists()).toBe(true);
      expect((await getTranscript(video.id))?.plainText).toBe("hello");

      await resetAllEdits(video.id);

      const reset = await getVideo(video.id);
      expect(reset?.lastEditedAt).toBeNull();
      // Edited outputs + edits.json deleted; source.mp4 + words.json preserved.
      expect(await Bun.file(join(dir, "1080p.mp4")).exists()).toBe(false);
      expect(await Bun.file(join(dir, "720p.mp4")).exists()).toBe(false);
      expect(await Bun.file(join(dir, "edits.json")).exists()).toBe(false);
      expect(await Bun.file(join(dir, "source.mp4")).exists()).toBe(true);
      // Duration reset to the full ~3s source (edited cut was ~2s).
      expect(reset?.durationSeconds ?? 0).toBeGreaterThan(2.7);
      // Transcript re-derived to the full (unedited) word set.
      expect((await getTranscript(video.id))?.plainText).toBe("hello world");
    },
    60_000,
  );

  test("is a no-op for an unedited video", async () => {
    const video = await createVideo(); // no lastEditedAt
    await resetAllEdits(video.id);
    expect((await getVideo(video.id))?.lastEditedAt).toBeNull();
  });
});
