import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "fs/promises";
import { join } from "path";
import { resolveForViewer } from "../../../routes/videos/resolve";
import { setupTestEnv, type TestEnv, teardownTestEnv } from "../../../test-utils";
import { createVideo, DATA_DIR, getVideo, markFootageComplete } from "../../store";
import { _inFlightPromise, runPipeline, scheduleDerivatives } from "../pipeline";
import { getStepStates } from "../steps-store";

const ffmpegAvailable = Bun.which("ffmpeg") !== null && Bun.which("ffprobe") !== null;

let env: TestEnv;

beforeEach(async () => {
  env = await setupTestEnv();
});

afterEach(async () => {
  await teardownTestEnv(env);
});

async function generateTestHls(videoDir: string): Promise<void> {
  await mkdir(videoDir, { recursive: true });
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
      "-hls_time",
      "1",
      "-hls_segment_type",
      "fmp4",
      "-hls_fmp4_init_filename",
      "init.mp4",
      "-hls_segment_filename",
      join(videoDir, "seg_%03d.m4s"),
      "-hls_list_size",
      "0",
      "-f",
      "hls",
      join(videoDir, "stream.m3u8"),
    ],
    { stderr: "pipe", stdout: "pipe" },
  );
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`HLS fixture failed: ${stderr}`);
}

describe("post-processing pipeline (end-to-end)", () => {
  test.skipIf(!ffmpegAvailable)(
    "takes a recorded video processing → ready with validated step rows; viewer serves MP4",
    async () => {
      const video = await createVideo();
      const videoDir = join(DATA_DIR, video.id);
      await generateTestHls(videoDir);

      // Footage whole → processing, then run the pipeline.
      await markFootageComplete(video.id);
      scheduleDerivatives(video.id);
      await _inFlightPromise(video.id);

      // Mandatory steps validated → ready, completedAt stamped.
      const updated = await getVideo(video.id);
      expect(updated?.status).toBe("ready");
      expect(updated?.completedAt).not.toBeNull();

      const steps = await getStepStates(video.id);
      expect(steps.get("source")?.state).toBe("ready");
      expect(steps.get("metadata")?.state).toBe("ready");

      // The viewer serves the MP4 (table-gated), not the HLS fallback.
      const resolved = await resolveForViewer(video.slug);
      if (!resolved || "redirect" in resolved) throw new Error("expected ViewerVideo");
      expect(resolved.sources).not.toBeNull();
      expect(resolved.src).toBeNull();
    },
    30_000,
  );

  test.skipIf(!ffmpegAvailable)(
    "an unstitchable source lands processing_failed and the viewer falls back to HLS",
    async () => {
      const video = await createVideo();
      const videoDir = join(DATA_DIR, video.id);
      await mkdir(videoDir, { recursive: true });
      // A playlist that references a missing segment → ffmpeg can't stitch it.
      await Bun.write(
        join(videoDir, "stream.m3u8"),
        '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:1.0,\nseg_000.m4s\n#EXT-X-ENDLIST\n',
      );

      await markFootageComplete(video.id);
      await runPipeline(video.id, { source: "recorded" });

      expect((await getVideo(video.id))?.status).toBe("processing_failed");
      expect((await getStepStates(video.id)).get("source")?.state).toBe("failed");

      // No validated source → viewer falls back to HLS.
      const resolved = await resolveForViewer(video.slug);
      if (!resolved || "redirect" in resolved) throw new Error("expected ViewerVideo");
      expect(resolved.sources).toBeNull();
      expect(resolved.src).toBe(`/${video.slug}/stream/stream.m3u8`);
    },
    30_000,
  );

  test.skipIf(!ffmpegAvailable)(
    "re-running the pipeline is a near-no-op (skip-if-ready resumability)",
    async () => {
      const video = await createVideo();
      const videoDir = join(DATA_DIR, video.id);
      await generateTestHls(videoDir);
      await markFootageComplete(video.id);
      await runPipeline(video.id, { source: "recorded" });

      const firstSteps = await getStepStates(video.id);
      // Precondition: the first run actually produced a ready source step (so
      // the producedAt comparison below is meaningful, not vacuously equal).
      expect(firstSteps.get("source")?.state).toBe("ready");
      const firstSourceAt = firstSteps.get("source")?.producedAt;
      expect(firstSourceAt).not.toBeNull();

      // Second run resumes — source is already ready + present, so it's skipped
      // (producedAt unchanged) rather than re-stitched.
      await runPipeline(video.id, { source: "recorded" });
      const secondSteps = await getStepStates(video.id);
      expect(secondSteps.get("source")?.producedAt).toBe(firstSourceAt ?? null);
      expect((await getVideo(video.id))?.status).toBe("ready");
    },
    30_000,
  );

  test.skipIf(!ffmpegAvailable)(
    "single-step regenerate (only + force) redoes just that artifact, not source",
    async () => {
      const video = await createVideo();
      const videoDir = join(DATA_DIR, video.id);
      await generateTestHls(videoDir);
      await markFootageComplete(video.id);
      await runPipeline(video.id, { source: "recorded" });

      const before = await getStepStates(video.id);
      const sourceAt = before.get("source")?.producedAt;
      const thumbPath = join(videoDir, "derivatives", "thumbnail.jpg");
      expect(await Bun.file(thumbPath).exists()).toBe(true);

      // Regenerate only the thumbnail (forced). source is left untouched.
      await Bun.write(thumbPath, ""); // clobber so we can prove it's rewritten
      await runPipeline(video.id, { source: "recorded", force: true, only: "thumbnail" });

      const after = await getStepStates(video.id);
      expect(after.get("source")?.producedAt).toBe(sourceAt ?? null); // source not re-stitched
      expect(after.get("thumbnail")?.state).toBe("ready");
      expect(Bun.file(thumbPath).size).toBeGreaterThan(0); // thumbnail actually regenerated
    },
    30_000,
  );
});
