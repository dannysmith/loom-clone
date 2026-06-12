// Integration tests for the EDIT path running through the unified pipeline
// (scheduleEdit → runPipeline mode=edit), exercising the edited_output step,
// the staged swap, and the edit finalisation. ffmpeg-gated.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { mkdir } from "fs/promises";
import { join } from "path";
import { getDb } from "../../../db/client";
import { videos } from "../../../db/schema";
import { setupTestEnv, type TestEnv, teardownTestEnv } from "../../../test-utils";
import { createVideo, DATA_DIR, getTranscript, getVideo, upsertTranscript } from "../../store";
import { _drainInFlight, scheduleEdit } from "../pipeline";
import { getStepStates, markStepReady } from "../steps-store";

const ffmpegAvailable = Bun.which("ffmpeg") !== null && Bun.which("ffprobe") !== null;

let env: TestEnv;
beforeEach(async () => {
  env = await setupTestEnv();
});
afterEach(async () => {
  await teardownTestEnv(env);
});

// 3-second 1080p source with audio → edited output is 1080p.mp4 plus a 720p
// variant, so the staged swap moves multiple files.
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

// A `ready` recorded video with a real 1080p source.mp4, cached dims, and a
// saved EDL — the state the editor commit hands off to scheduleEdit.
async function readyEditable(): Promise<{ id: string; dir: string }> {
  const video = await createVideo();
  const dir = join(DATA_DIR, video.id, "derivatives");
  await write1080pSource(dir);
  await Bun.write(join(dir, "edits.json"), TRIM_EDL);
  await markStepReady(video.id, "source");
  await markStepReady(video.id, "metadata");
  await getDb()
    .update(videos)
    .set({ status: "ready", width: 1920, height: 1080, durationSeconds: 3 })
    .where(eq(videos.id, video.id));
  return { id: video.id, dir };
}

describe("edit mode through the unified pipeline", () => {
  test.skipIf(!ffmpegAvailable)(
    "produces the edited cut + variant, flips to edited, settles ready",
    async () => {
      const { id, dir } = await readyEditable();

      scheduleEdit(id, "recorded");
      await _drainInFlight();

      // Edited cut (source resolution) + downscaled variant landed; staging gone.
      expect(await Bun.file(join(dir, "1080p.mp4")).exists()).toBe(true);
      expect(await Bun.file(join(dir, "720p.mp4")).exists()).toBe(true);
      expect(await Bun.file(join(dir, ".staging")).exists()).toBe(false);

      const updated = await getVideo(id);
      expect(updated?.status).toBe("ready");
      expect(updated?.lastEditedAt).not.toBeNull();
      // Trim 0.5–2.5 → ~2s edited duration.
      expect(updated?.durationSeconds ?? 0).toBeGreaterThan(1.5);
      expect(updated?.durationSeconds ?? 0).toBeLessThan(2.5);

      // The new edited_output step + the regenerated variant are ready in the
      // ledger (so the serving + readiness checks see them).
      const steps = await getStepStates(id);
      expect(steps.get("edited_output")?.state).toBe("ready");
      expect(steps.get("variant_720")?.state).toBe("ready");
      // source.mp4 is preserved and its row stays ready.
      expect(steps.get("source")?.state).toBe("ready");
      expect(await Bun.file(join(dir, "source.mp4")).exists()).toBe(true);
    },
    60_000,
  );

  test.skipIf(!ffmpegAvailable)(
    "re-derives the transcript from words.json for the edited cut",
    async () => {
      const { id, dir } = await readyEditable();
      // Word timings spanning the source; only those inside the 0.5–2.5 trim survive.
      await Bun.write(
        join(dir, "words.json"),
        JSON.stringify([
          { word: "alpha", start: 0.0, end: 0.4 }, // dropped (before trim)
          { word: "bravo", start: 1.0, end: 1.4 }, // kept
          { word: "charlie", start: 2.0, end: 2.4 }, // kept
        ]),
      );
      await upsertTranscript(id, "srt", "alpha bravo charlie");

      scheduleEdit(id, "recorded");
      await _drainInFlight();

      expect((await getTranscript(id))?.plainText).toBe("bravo charlie");
    },
    60_000,
  );

  test.skipIf(!ffmpegAvailable)(
    "a failed edit restores ready and leaves the previously-served output byte-untouched",
    async () => {
      const { id, dir } = await readyEditable();
      // Simulate an already-edited video: a prior edited cut on disk (marker
      // content) with its ledger row + lastEditedAt set.
      await Bun.write(join(dir, "1080p.mp4"), "PRIOR-EDIT-OUTPUT");
      await markStepReady(id, "edited_output");
      await getDb()
        .update(videos)
        .set({ lastEditedAt: new Date().toISOString() })
        .where(eq(videos.id, id));

      // An EDL that removes everything → edited_output throws before any swap.
      await Bun.write(
        join(dir, "edits.json"),
        JSON.stringify({
          version: 1,
          source: "source.mp4",
          edits: [{ type: "cut", startTime: 0, endTime: 3 }],
        }),
      );

      scheduleEdit(id, "recorded");
      await _drainInFlight();

      // Status restored, staging cleaned up.
      expect((await getVideo(id))?.status).toBe("ready");
      expect(await Bun.file(join(dir, ".staging")).exists()).toBe(false);
      // The previously-served edited output is byte-for-byte untouched (the
      // failed edit never swapped).
      expect(await Bun.file(join(dir, "1080p.mp4")).text()).toBe("PRIOR-EDIT-OUTPUT");
    },
    60_000,
  );
});
