import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "fs/promises";
import { join } from "path";
import { setupTestEnv, type TestEnv, teardownTestEnv } from "../../test-utils";
import { generateVariant } from "../derivatives";

// generateVariant shells out to ffmpeg, and the assertions probe with ffprobe.
const ffmpegAvailable = Bun.which("ffmpeg") !== null && Bun.which("ffprobe") !== null;

// Which variant heights apply to a given source height (the `ctx.height >
// height` gate in the registry's variantStep) is covered by readiness.test.ts;
// here we exercise generateVariant's actual encode output (dimensions/aspect).

let env: TestEnv;

beforeEach(async () => {
  env = await setupTestEnv();
});

afterEach(async () => {
  await teardownTestEnv(env);
});

// --- End-to-end variant generation ---

async function generateTestSource(dir: string, size: string): Promise<void> {
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
      `testsrc=duration=2:size=${size}:rate=15`,
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
      join(dir, "source.mp4"),
    ],
    { stderr: "pipe", stdout: "pipe" },
  );
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (exitCode !== 0) throw new Error(`fixture generation failed: ${stderr}`);
}

async function probeDimensions(filePath: string): Promise<{ width: number; height: number }> {
  const proc = Bun.spawn(
    [
      "ffprobe",
      "-v",
      "quiet",
      "-print_format",
      "json",
      "-show_streams",
      "-select_streams",
      "v:0",
      filePath,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  const data = JSON.parse(stdout) as { streams?: Array<{ width?: number; height?: number }> };
  return { width: data.streams?.[0]?.width ?? 0, height: data.streams?.[0]?.height ?? 0 };
}

describe("generateVariant (end-to-end)", () => {
  test.skipIf(!ffmpegAvailable)(
    "downscales a 1440p source to both 1080p and 720p with the right dimensions",
    async () => {
      // 2560x1440 is 16:9
      const dir = join("data", "test-variants-1440p");
      await generateTestSource(dir, "2560x1440");
      const source = join(dir, "source.mp4");

      await generateVariant(dir, 1080, source);
      await generateVariant(dir, 720, source);

      // 1080p variant — width preserves the 16:9 aspect ratio (1920).
      const f1080 = Bun.file(join(dir, "1080p.mp4"));
      expect(await f1080.exists()).toBe(true);
      expect(f1080.size).toBeGreaterThan(0);
      const dims1080 = await probeDimensions(join(dir, "1080p.mp4"));
      expect(dims1080.height).toBe(1080);
      expect(dims1080.width).toBe(1920);

      // 720p variant — 1280 wide for 16:9.
      const f720 = Bun.file(join(dir, "720p.mp4"));
      expect(await f720.exists()).toBe(true);
      expect(f720.size).toBeGreaterThan(0);
      const dims720 = await probeDimensions(join(dir, "720p.mp4"));
      expect(dims720.height).toBe(720);
      expect(dims720.width).toBe(1280);
    },
    120_000,
  );
});
