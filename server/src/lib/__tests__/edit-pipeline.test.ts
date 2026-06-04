import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { mkdir } from "fs/promises";
import { join } from "path";
import { getDb } from "../../db/client";
import { videos } from "../../db/schema";
import { setupTestEnv, type TestEnv, teardownTestEnv } from "../../test-utils";
import {
  _buildFfmpegEditArgs,
  _editInFlightPromise,
  applyEdits,
  resetAllEdits,
} from "../edit-pipeline";
import { getStepStates } from "../processing/steps-store";
import { createVideo, DATA_DIR, getTranscript, getVideo } from "../store";

// The edited re-encode reads the same genuinely-VFR source.mp4 as the variant
// encode, so it needs the same `-fps_mode passthrough` guard — otherwise
// libx264 re-times frames onto the source's unreliable declared r_frame_rate
// and silently drops the surplus. See _variantFfmpegArgs in derivatives.ts.
describe("buildFfmpegEditArgs frame-rate handling", () => {
  function assertPassthrough(args: string[]) {
    const i = args.indexOf("-fps_mode");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(i + 1).toBeLessThan(args.length);
    expect(args[i + 1]).toBe("passthrough");
    // Must not force a constant rate.
    expect(args).not.toContain("-r");
  }

  test("simple single-segment trim requests passthrough", () => {
    const args = _buildFfmpegEditArgs("/in/source.mp4", "/out/edited.mp4.tmp", [
      { start: 1, end: 5 },
    ]);
    assertPassthrough(args);
  });

  test("multi-segment concat requests passthrough", () => {
    const args = _buildFfmpegEditArgs("/in/source.mp4", "/out/edited.mp4.tmp", [
      { start: 1, end: 5 },
      { start: 10, end: 12 },
    ]);
    assertPassthrough(args);
  });
});

const ffmpegAvailable = Bun.which("ffmpeg") !== null && Bun.which("ffprobe") !== null;

let env: TestEnv;
beforeEach(async () => {
  env = await setupTestEnv();
});
afterEach(async () => {
  await teardownTestEnv(env);
});

// 3-second 1080p source with audio → edited output is 1080p.mp4 plus a 720p
// variant, so the atomic swap moves multiple files.
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

async function runEdit(videoId: string): Promise<void> {
  applyEdits(videoId);
  await _editInFlightPromise(videoId)?.catch(() => {});
}

describe("edit pipeline — atomic-set staging", () => {
  test.skipIf(!ffmpegAvailable)(
    "commits the full edited set and leaves no staging dir behind",
    async () => {
      const video = await createVideo();
      const dir = join(DATA_DIR, video.id, "derivatives");
      await write1080pSource(dir);
      await Bun.write(join(dir, "edits.json"), TRIM_EDL);
      await getDb().update(videos).set({ status: "ready" }).where(eq(videos.id, video.id));

      await runEdit(video.id);

      // Edited output + downscaled variant both landed.
      expect(await Bun.file(join(dir, "1080p.mp4")).exists()).toBe(true);
      expect(await Bun.file(join(dir, "720p.mp4")).exists()).toBe(true);
      // Staging dir cleaned up.
      expect(await Bun.file(join(dir, ".edit-staging")).exists()).toBe(false);

      const updated = await getVideo(video.id);
      expect(updated?.status).toBe("ready");
      expect(updated?.lastEditedAt).not.toBeNull();
    },
    60_000,
  );

  test.skipIf(!ffmpegAvailable)(
    "a mid-generation failure leaves the previous outputs untouched (no stale/new mix)",
    async () => {
      const video = await createVideo();
      const dir = join(DATA_DIR, video.id, "derivatives");
      await write1080pSource(dir);
      await Bun.write(join(dir, "edits.json"), TRIM_EDL);
      // A pre-existing edited output from an earlier edit, with a marker.
      await Bun.write(join(dir, "1080p.mp4"), "OLD-OUTPUT");
      // Invalid words.json makes caption derivation throw AFTER the edited
      // output + variant have been staged — i.e. before the swap.
      await Bun.write(join(dir, "words.json"), "{ not valid json");
      await getDb().update(videos).set({ status: "ready" }).where(eq(videos.id, video.id));

      await runEdit(video.id);

      // The pre-existing output is byte-for-byte untouched (never swapped).
      expect(await Bun.file(join(dir, "1080p.mp4")).text()).toBe("OLD-OUTPUT");
      // Staging dir cleaned up even on failure.
      expect(await Bun.file(join(dir, ".edit-staging")).exists()).toBe(false);
      // Status restored to ready.
      expect((await getVideo(video.id))?.status).toBe("ready");
    },
    60_000,
  );

  test.skipIf(!ffmpegAvailable)(
    "the edit marks the regenerated variant step rows ready in the ledger",
    async () => {
      const video = await createVideo();
      const dir = join(DATA_DIR, video.id, "derivatives");
      await write1080pSource(dir);
      await Bun.write(join(dir, "edits.json"), TRIM_EDL);
      await getDb().update(videos).set({ status: "ready" }).where(eq(videos.id, video.id));

      await runEdit(video.id);

      // The 720p variant was regenerated from the edited cut → its row is ready,
      // so the serving gate (resolve.ts) will actually offer it.
      const steps = await getStepStates(video.id);
      expect(steps.get("variant_720")?.state).toBe("ready");
      // Short edit (<60s) → no storyboard; the row is settled as skipped, not a
      // stale ready pointing at a non-existent file.
      expect(steps.get("storyboard")?.state).toBe("skipped");
    },
    60_000,
  );
});

describe("resetAllEdits", () => {
  test.skipIf(!ffmpegAvailable)(
    "washes the edit away: deletes edited outputs, clears lastEditedAt, resets metadata + transcript",
    async () => {
      const video = await createVideo();
      const dir = join(DATA_DIR, video.id, "derivatives");
      await write1080pSource(dir);
      await Bun.write(join(dir, "edits.json"), TRIM_EDL);
      // words.json spanning the full 3s source so the reset can rebuild the
      // original transcript.
      await Bun.write(
        join(dir, "words.json"),
        JSON.stringify([
          { word: "hello", start: 0.6, end: 0.9 }, // inside the 0.5–2.5 trim
          { word: "world", start: 2.6, end: 2.9 }, // after the trim → dropped by the edit
        ]),
      );
      await getDb().update(videos).set({ status: "ready" }).where(eq(videos.id, video.id));

      await runEdit(video.id);
      // Sanity: the edit committed (active file is 1080p.mp4, duration ~2s).
      const edited = await getVideo(video.id);
      expect(edited?.lastEditedAt).not.toBeNull();
      expect(await Bun.file(join(dir, "1080p.mp4")).exists()).toBe(true);
      // The edited transcript dropped the post-trim word ("world" at 2.6s is
      // outside the 0.5–2.5 trim).
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
