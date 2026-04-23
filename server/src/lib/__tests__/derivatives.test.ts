import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { getDb } from "../../db/client";
import { videos } from "../../db/schema";
import { setupTestEnv, type TestEnv, teardownTestEnv } from "../../test-utils";
import { _inFlightPromise, scheduleDerivatives, scheduleUploadDerivatives } from "../derivatives";
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

// Generate a standalone MP4 (simulates an uploaded file, not HLS segments).
async function generateTestUpload(videoDir: string): Promise<void> {
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
      "testsrc=duration=2:size=1920x1080:rate=15",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=2:sample_rate=48000",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-c:a",
      "aac",
      "-b:a",
      "64k",
      "-movflags",
      "+faststart",
      "-f",
      "mp4",
      join(videoDir, "upload.mp4"),
    ],
    { stderr: "pipe", stdout: "pipe" },
  );
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (exitCode !== 0) throw new Error(`upload fixture generation failed: ${stderr}`);
}

describe("scheduleUploadDerivatives (upload path)", () => {
  test.skipIf(!ffmpegAvailable)(
    "produces source.mp4, thumbnail.jpg, and metadata from an uploaded MP4",
    async () => {
      const video = await createVideo();
      const videoDir = join(DATA_DIR, video.id);
      await generateTestUpload(videoDir);

      // Simulate what the upload route does: set duration + status before scheduling.
      const db = getDb();
      await db
        .update(videos)
        .set({ status: "complete", durationSeconds: 2 })
        .where(eq(videos.id, video.id));

      scheduleUploadDerivatives(video.id);
      await _inFlightPromise(video.id);

      // source.mp4 should exist (upload.mp4 → source.mp4 with faststart)
      const source = Bun.file(join(videoDir, "derivatives", "source.mp4"));
      expect(await source.exists()).toBe(true);
      expect(source.size).toBeGreaterThan(0);

      // thumbnail.jpg should exist (promoted from candidates)
      const thumb = Bun.file(join(videoDir, "derivatives", "thumbnail.jpg"));
      expect(await thumb.exists()).toBe(true);
      expect(thumb.size).toBeGreaterThan(0);

      // Metadata should be populated (1920x1080 source → width/height set)
      const updated = db.select().from(videos).where(eq(videos.id, video.id)).get();
      expect(updated?.width).toBe(1920);
      expect(updated?.height).toBe(1080);
      expect(updated?.fileBytes).toBeGreaterThan(0);

      // 1080p source → should generate a 720p variant
      const variant = Bun.file(join(videoDir, "derivatives", "720p.mp4"));
      expect(await variant.exists()).toBe(true);
    },
    120_000,
  );
});

describe("pipeline fault tolerance", () => {
  test.skipIf(!ffmpegAvailable)(
    "metadata and thumbnails still land when source has no audio track",
    async () => {
      // Video-only source (no audio) — audio processing will be skipped.
      // Thumbnails and metadata should still work.
      const video = await createVideo();
      const videoDir = join(DATA_DIR, video.id);
      await mkdir(videoDir, { recursive: true });

      // Generate HLS with video only (no audio).
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
      await proc.exited;

      const db = getDb();
      await db
        .update(videos)
        .set({ status: "complete", durationSeconds: 2 })
        .where(eq(videos.id, video.id));

      scheduleDerivatives(video.id);
      await _inFlightPromise(video.id);

      // source.mp4 should exist (stitched from HLS)
      expect(await Bun.file(join(videoDir, "derivatives", "source.mp4")).exists()).toBe(true);

      // thumbnail.jpg should exist despite no audio processing
      expect(await Bun.file(join(videoDir, "derivatives", "thumbnail.jpg")).exists()).toBe(true);

      // Metadata should be populated
      const updated = db.select().from(videos).where(eq(videos.id, video.id)).get();
      expect(updated?.width).toBe(320);
      expect(updated?.height).toBe(240);
      expect(updated?.fileBytes).toBeGreaterThan(0);
    },
    60_000,
  );

  test.skipIf(!ffmpegAvailable)(
    "recording.json with device names populates metadata alongside ffprobe data",
    async () => {
      const video = await createVideo();
      const videoDir = join(DATA_DIR, video.id);
      await generateTestHls(videoDir);

      // Write a recording.json sidecar
      await writeFile(
        join(videoDir, "recording.json"),
        JSON.stringify({
          inputs: {
            camera: { name: "Studio Display Camera" },
            microphone: { name: "Blue Yeti" },
          },
        }),
      );

      const db = getDb();
      await db
        .update(videos)
        .set({ status: "complete", durationSeconds: 2 })
        .where(eq(videos.id, video.id));

      scheduleDerivatives(video.id);
      await _inFlightPromise(video.id);

      const updated = db.select().from(videos).where(eq(videos.id, video.id)).get();
      expect(updated?.cameraName).toBe("Studio Display Camera");
      expect(updated?.microphoneName).toBe("Blue Yeti");
      // Width/height from ffprobe should also be set
      expect(updated?.width).toBe(320);
      expect(updated?.height).toBe(240);
    },
    60_000,
  );
});
