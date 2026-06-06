import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "path";
import { setupTestEnv, type TestEnv, teardownTestEnv } from "../../../test-utils";
import { isProbablyPlayable } from "../playable";

const ffmpegAvailable = Bun.which("ffmpeg") !== null && Bun.which("ffprobe") !== null;

let env: TestEnv;

beforeEach(async () => {
  env = await setupTestEnv();
});

afterEach(async () => {
  await teardownTestEnv(env);
});

async function makeRealMp4(path: string, duration: number): Promise<void> {
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
      `testsrc=duration=${duration}:size=320x240:rate=15`,
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

describe("isProbablyPlayable", () => {
  test("returns false for a nonexistent file", async () => {
    expect(await isProbablyPlayable("/no/such/file.mp4")).toBe(false);
  });

  test("returns false for a file that isn't a video", async () => {
    const path = join(env.tempDir, "garbage.mp4");
    await Bun.write(path, "not a video at all");
    expect(await isProbablyPlayable(path)).toBe(false);
  });

  test.skipIf(!ffmpegAvailable)("returns true for a real MP4", async () => {
    const path = join(env.tempDir, "real.mp4");
    await makeRealMp4(path, 2);
    expect(await isProbablyPlayable(path)).toBe(true);
    // Within tolerance of the expected duration.
    expect(await isProbablyPlayable(path, { expectedDuration: 2 })).toBe(true);
    // Wildly wrong expected duration → rejected.
    expect(await isProbablyPlayable(path, { expectedDuration: 60 })).toBe(false);
  });
});
