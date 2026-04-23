import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { setupTestEnv, type TestEnv, teardownTestEnv } from "../../test-utils";
import { extractMetadata } from "../derivatives";
import { createVideo, DATA_DIR, getVideo } from "../store";

const ffmpegAvailable = Bun.which("ffmpeg") !== null;

let env: TestEnv;

beforeEach(async () => {
  env = await setupTestEnv();
});

afterEach(async () => {
  await teardownTestEnv(env);
});

async function generateTestSource(videoDir: string, size = "320x240"): Promise<void> {
  const derivDir = join(videoDir, "derivatives");
  await mkdir(derivDir, { recursive: true });
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
      `testsrc=duration=2:size=${size}:rate=15`,
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=2",
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
      join(derivDir, "source.mp4"),
    ],
    { stderr: "pipe", stdout: "pipe" },
  );
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (exitCode !== 0) {
    throw new Error(`ffmpeg fixture generation failed: ${stderr}`);
  }
}

describe("extractMetadata", () => {
  test.skipIf(!ffmpegAvailable)(
    "populates width, height, aspectRatio, and fileBytes from source.mp4",
    async () => {
      const video = await createVideo();
      const videoDir = join(DATA_DIR, video.id);
      await generateTestSource(videoDir, "320x240");

      await extractMetadata(video.id);

      const updated = await getVideo(video.id);
      expect(updated).toBeDefined();
      expect(updated!.width).toBe(320);
      expect(updated!.height).toBe(240);
      // 320/240 = 1.3333
      expect(updated!.aspectRatio).toBeCloseTo(1.3333, 3);
      expect(updated!.fileBytes).toBeGreaterThan(0);
    },
    30_000,
  );

  test.skipIf(!ffmpegAvailable)(
    "populates camera and microphone names from recording.json",
    async () => {
      const video = await createVideo();
      const videoDir = join(DATA_DIR, video.id);
      await generateTestSource(videoDir);

      // Write a recording.json sidecar
      await writeFile(
        join(videoDir, "recording.json"),
        JSON.stringify({
          inputs: {
            camera: { name: "FaceTime HD Camera" },
            microphone: { name: "MacBook Pro Microphone" },
          },
        }),
      );

      await extractMetadata(video.id);

      const updated = await getVideo(video.id);
      expect(updated!.cameraName).toBe("FaceTime HD Camera");
      expect(updated!.microphoneName).toBe("MacBook Pro Microphone");
    },
    30_000,
  );

  test.skipIf(!ffmpegAvailable)(
    "sets recordingHealth to null when compositionStats absent",
    async () => {
      const video = await createVideo();
      const videoDir = join(DATA_DIR, video.id);
      await generateTestSource(videoDir);

      await writeFile(join(videoDir, "recording.json"), JSON.stringify({ inputs: {} }));

      await extractMetadata(video.id);

      const updated = await getVideo(video.id);
      expect(updated!.recordingHealth).toBeNull();
    },
    30_000,
  );

  test.skipIf(!ffmpegAvailable)(
    "sets recordingHealth to terminal_failure when terminalFailure is true",
    async () => {
      const video = await createVideo();
      const videoDir = join(DATA_DIR, video.id);
      await generateTestSource(videoDir);

      await writeFile(
        join(videoDir, "recording.json"),
        JSON.stringify({
          inputs: {},
          compositionStats: { terminalFailure: true },
        }),
      );

      await extractMetadata(video.id);

      const updated = await getVideo(video.id);
      expect(updated!.recordingHealth).toBe("terminal_failure");
    },
    30_000,
  );

  test.skipIf(!ffmpegAvailable)(
    "sets recordingHealth to gpu_wobble when non-zero counters exist",
    async () => {
      const video = await createVideo();
      const videoDir = join(DATA_DIR, video.id);
      await generateTestSource(videoDir);

      await writeFile(
        join(videoDir, "recording.json"),
        JSON.stringify({
          inputs: {},
          compositionStats: { terminalFailure: false, frameMissCount: 3 },
        }),
      );

      await extractMetadata(video.id);

      const updated = await getVideo(video.id);
      expect(updated!.recordingHealth).toBe("gpu_wobble");
    },
    30_000,
  );

  test.skipIf(!ffmpegAvailable)(
    "is idempotent — re-running updates with same values",
    async () => {
      const video = await createVideo();
      const videoDir = join(DATA_DIR, video.id);
      await generateTestSource(videoDir);

      await extractMetadata(video.id);
      const first = await getVideo(video.id);

      await extractMetadata(video.id);
      const second = await getVideo(video.id);

      expect(second!.width).toBe(first!.width);
      expect(second!.height).toBe(first!.height);
      expect(second!.fileBytes).toBe(first!.fileBytes);
    },
    30_000,
  );

  test.skipIf(!ffmpegAvailable)(
    "aspectRatio matches width / height",
    async () => {
      const video = await createVideo();
      const videoDir = join(DATA_DIR, video.id);
      await generateTestSource(videoDir, "640x360");

      await extractMetadata(video.id);

      const updated = await getVideo(video.id);
      expect(updated!.width).toBe(640);
      expect(updated!.height).toBe(360);
      const expected = Math.round((640 / 360) * 10000) / 10000;
      expect(updated!.aspectRatio).toBe(expected);
    },
    30_000,
  );
});
