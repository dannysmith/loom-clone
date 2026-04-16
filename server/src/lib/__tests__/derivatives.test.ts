import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "fs/promises";
import { join } from "path";
import { setupTestEnv, type TestEnv, teardownTestEnv } from "../../test-utils";
import { _inFlightPromise, scheduleDerivatives } from "../derivatives";
import { createVideo, DATA_DIR } from "../store";

const ffmpegAvailable = Bun.which("ffmpeg") !== null;

let env: TestEnv;

beforeEach(async () => {
  env = await setupTestEnv();
});

afterEach(async () => {
  await teardownTestEnv(env);
});

// Generates a real 2-second HLS fMP4 stream using ffmpeg. Mirrors what the
// macOS app produces at runtime, so derivative generation against the result
// exercises the real pipeline end to end.
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
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (exitCode !== 0) {
    throw new Error(`ffmpeg fixture generation failed: ${stderr}`);
  }
}

describe("scheduleDerivatives", () => {
  test("deduplicates back-to-back calls for the same video id", async () => {
    const video = await createVideo();
    scheduleDerivatives(video.id);
    const p1 = _inFlightPromise(video.id);
    scheduleDerivatives(video.id);
    const p2 = _inFlightPromise(video.id);
    // Same promise instance — the second call was a no-op.
    expect(p1).toBe(p2);
    // Let it settle (it will fail because no HLS stream exists, but that's
    // fine — the dedup behavior is what we care about).
    await p1?.catch(() => {});
  });

  test("does not throw even when no playlist exists", async () => {
    const video = await createVideo();
    scheduleDerivatives(video.id);
    await _inFlightPromise(video.id)?.catch(() => {});
    // After settle, in-flight entry is cleared.
    expect(_inFlightPromise(video.id)).toBeUndefined();
  });
});

describe("generateDerivatives (end-to-end with real ffmpeg)", () => {
  test.skipIf(!ffmpegAvailable)(
    "produces source.mp4 and thumbnail.jpg from a real HLS stream",
    async () => {
      const video = await createVideo();
      const videoDir = join(DATA_DIR, video.id);
      await generateTestHls(videoDir);

      scheduleDerivatives(video.id);
      await _inFlightPromise(video.id);

      const sourceMp4 = Bun.file(join(videoDir, "derivatives", "source.mp4"));
      const thumbnail = Bun.file(join(videoDir, "derivatives", "thumbnail.jpg"));
      expect(await sourceMp4.exists()).toBe(true);
      expect(await thumbnail.exists()).toBe(true);
      expect(sourceMp4.size).toBeGreaterThan(0);
      expect(thumbnail.size).toBeGreaterThan(0);
    },
    30_000,
  );

  test.skipIf(!ffmpegAvailable)(
    "regenerates cleanly when called again (healing → complete)",
    async () => {
      const video = await createVideo();
      const videoDir = join(DATA_DIR, video.id);
      await generateTestHls(videoDir);

      scheduleDerivatives(video.id);
      await _inFlightPromise(video.id);
      const firstSize = Bun.file(join(videoDir, "derivatives", "source.mp4")).size;

      // Second run atomically replaces the previous output.
      scheduleDerivatives(video.id);
      await _inFlightPromise(video.id);
      const secondSize = Bun.file(join(videoDir, "derivatives", "source.mp4")).size;

      expect(secondSize).toBeGreaterThan(0);
      // Should be essentially the same file — identical content, identical size.
      expect(secondSize).toBe(firstSize);
      // No .tmp leftover.
      expect(await Bun.file(join(videoDir, "derivatives", "source.mp4.tmp")).exists()).toBe(false);
    },
    30_000,
  );
});
