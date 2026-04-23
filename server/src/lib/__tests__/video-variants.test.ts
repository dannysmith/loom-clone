import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "fs/promises";
import { join } from "path";
import { setupTestEnv, type TestEnv, teardownTestEnv } from "../../test-utils";
import { _variantsForHeight, generateVariants } from "../derivatives";

const ffmpegAvailable = Bun.which("ffmpeg") !== null;

let env: TestEnv;

beforeEach(async () => {
  env = await setupTestEnv();
});

afterEach(async () => {
  await teardownTestEnv(env);
});

// --- variantsForHeight (pure logic) ---

describe("variantsForHeight", () => {
  test("720p source generates nothing", () => {
    expect(_variantsForHeight(720)).toEqual([]);
  });

  test("1080p source generates only 720p", () => {
    const variants = _variantsForHeight(1080);
    expect(variants).toEqual([{ height: 720, crf: 23 }]);
  });

  test("1440p source generates both 1080p and 720p", () => {
    const variants = _variantsForHeight(1440);
    expect(variants).toEqual([
      { height: 1080, crf: 20 },
      { height: 720, crf: 23 },
    ]);
  });

  test("4K source generates both 1080p and 720p", () => {
    const variants = _variantsForHeight(2160);
    expect(variants).toEqual([
      { height: 1080, crf: 20 },
      { height: 720, crf: 23 },
    ]);
  });

  test("480p source generates nothing", () => {
    expect(_variantsForHeight(480)).toEqual([]);
  });

  test("1081p source generates both variants", () => {
    const variants = _variantsForHeight(1081);
    expect(variants).toEqual([
      { height: 1080, crf: 20 },
      { height: 720, crf: 23 },
    ]);
  });

  test("721p source generates only 720p", () => {
    const variants = _variantsForHeight(721);
    expect(variants).toEqual([{ height: 720, crf: 23 }]);
  });
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

describe("generateVariants (end-to-end)", () => {
  test.skipIf(!ffmpegAvailable)(
    "1440p source generates both 1080p and 720p variants",
    async () => {
      // 2560x1440 is 16:9
      const dir = join("data", "test-variants-1440p");
      await generateTestSource(dir, "2560x1440");

      await generateVariants(dir);

      // 1080p variant
      const f1080 = Bun.file(join(dir, "1080p.mp4"));
      expect(await f1080.exists()).toBe(true);
      expect(f1080.size).toBeGreaterThan(0);
      const dims1080 = await probeDimensions(join(dir, "1080p.mp4"));
      expect(dims1080.height).toBe(1080);
      // Width should preserve aspect ratio: 1920 for 16:9
      expect(dims1080.width).toBe(1920);

      // 720p variant
      const f720 = Bun.file(join(dir, "720p.mp4"));
      expect(await f720.exists()).toBe(true);
      expect(f720.size).toBeGreaterThan(0);
      const dims720 = await probeDimensions(join(dir, "720p.mp4"));
      expect(dims720.height).toBe(720);
      expect(dims720.width).toBe(1280);
    },
    120_000,
  );

  test.skipIf(!ffmpegAvailable)(
    "1080p source generates only 720p variant",
    async () => {
      const dir = join("data", "test-variants-1080p");
      await generateTestSource(dir, "1920x1080");

      await generateVariants(dir);

      // 720p should exist
      const f720 = Bun.file(join(dir, "720p.mp4"));
      expect(await f720.exists()).toBe(true);
      const dims720 = await probeDimensions(join(dir, "720p.mp4"));
      expect(dims720.height).toBe(720);
      expect(dims720.width).toBe(1280);

      // 1080p should NOT exist (source is already 1080p)
      expect(await Bun.file(join(dir, "1080p.mp4")).exists()).toBe(false);
    },
    120_000,
  );

  test.skipIf(!ffmpegAvailable)(
    "720p source generates no variants",
    async () => {
      const dir = join("data", "test-variants-720p");
      await generateTestSource(dir, "1280x720");

      await generateVariants(dir);

      expect(await Bun.file(join(dir, "720p.mp4")).exists()).toBe(false);
      expect(await Bun.file(join(dir, "1080p.mp4")).exists()).toBe(false);
    },
    60_000,
  );
});
