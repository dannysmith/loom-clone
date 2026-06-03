import { describe, expect, test } from "bun:test";
import { mkdir, rm } from "fs/promises";
import { join } from "path";
import { isProbablyPlayable } from "../playable";

const ffmpegAvailable = Bun.which("ffmpeg") !== null && Bun.which("ffprobe") !== null;

const TMP = join(import.meta.dir, "_playable_tmp");

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
    await mkdir(TMP, { recursive: true });
    const path = join(TMP, "garbage.mp4");
    await Bun.write(path, "not a video at all");
    try {
      expect(await isProbablyPlayable(path)).toBe(false);
    } finally {
      await rm(TMP, { recursive: true, force: true });
    }
  });

  test.skipIf(!ffmpegAvailable)("returns true for a real MP4", async () => {
    await mkdir(TMP, { recursive: true });
    const path = join(TMP, "real.mp4");
    await makeRealMp4(path, 2);
    try {
      expect(await isProbablyPlayable(path)).toBe(true);
      // Within tolerance of the expected duration.
      expect(await isProbablyPlayable(path, { expectedDuration: 2 })).toBe(true);
      // Wildly wrong expected duration → rejected.
      expect(await isProbablyPlayable(path, { expectedDuration: 60 })).toBe(false);
    } finally {
      await rm(TMP, { recursive: true, force: true });
    }
  });
});
