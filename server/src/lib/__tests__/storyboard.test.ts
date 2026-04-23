import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "fs/promises";
import { join } from "path";
import { setupTestEnv, type TestEnv, teardownTestEnv } from "../../test-utils";
import { computeStoryboardParams, generateStoryboard, generateVtt } from "../storyboard";

const ffmpegAvailable = Bun.which("ffmpeg") !== null;

let env: TestEnv;

beforeEach(async () => {
  env = await setupTestEnv();
});

afterEach(async () => {
  await teardownTestEnv(env);
});

// --- computeStoryboardParams (pure logic) ---

describe("computeStoryboardParams", () => {
  test("returns null for videos shorter than 60 seconds", () => {
    expect(computeStoryboardParams(30)).toBeNull();
    expect(computeStoryboardParams(59)).toBeNull();
    expect(computeStoryboardParams(0)).toBeNull();
  });

  test("60 seconds is the minimum", () => {
    const result = computeStoryboardParams(60);
    expect(result).not.toBeNull();
  });

  test("2 min video: 5s interval, 24 frames, 10x3 grid", () => {
    const result = computeStoryboardParams(120);
    expect(result).toEqual({
      interval: 5,
      expectedFrames: 24,
      cols: 10,
      rows: 3,
    });
  });

  test("5 min video: 5s interval, 60 frames, 10x6 grid", () => {
    const result = computeStoryboardParams(300);
    expect(result).toEqual({
      interval: 5,
      expectedFrames: 60,
      cols: 10,
      rows: 6,
    });
  });

  test("10 min video: 6s interval, 100 frames, 10x10 grid", () => {
    const result = computeStoryboardParams(600);
    expect(result).toEqual({
      interval: 6,
      expectedFrames: 100,
      cols: 10,
      rows: 10,
    });
  });

  test("1 hour video: 36s interval, 100 frames, 10x10 grid", () => {
    const result = computeStoryboardParams(3600);
    expect(result).toEqual({
      interval: 36,
      expectedFrames: 100,
      cols: 10,
      rows: 10,
    });
  });
});

// --- generateVtt (pure logic) ---

describe("generateVtt", () => {
  test("generates correct VTT for a 2-min video", () => {
    const params = computeStoryboardParams(120)!;
    const vtt = generateVtt(params, 240, 135);

    // Should start with WEBVTT header
    expect(vtt.startsWith("WEBVTT\n")).toBe(true);

    // Count cues (each cue is a timestamp line + image line + blank line)
    const lines = vtt.split("\n").filter((l) => l.includes("-->"));
    expect(lines.length).toBe(24);

    // First cue starts at 0
    expect(lines[0]).toBe("00:00:00.000 --> 00:00:05.000");

    // First image ref is at position 0,0
    const imageLines = vtt.split("\n").filter((l) => l.includes("storyboard.jpg#xywh="));
    expect(imageLines[0]).toBe("storyboard.jpg#xywh=0,0,240,135");

    // Second image ref is at position 240,0 (next column)
    expect(imageLines[1]).toBe("storyboard.jpg#xywh=240,0,240,135");

    // 11th cue should wrap to second row (index 10, col 0, row 1)
    expect(imageLines[10]).toBe("storyboard.jpg#xywh=0,135,240,135");
  });

  test("last cue covers remaining time", () => {
    const params = computeStoryboardParams(120)!;
    const vtt = generateVtt(params, 240, 135);
    const lines = vtt.split("\n").filter((l) => l.includes("-->"));
    const lastLine = lines[lines.length - 1]!;
    // Frame 23: starts at 23*5=115, ends at 24*5=120
    expect(lastLine).toBe("00:01:55.000 --> 00:02:00.000");
  });

  test("all cues have matching xywh coordinates within grid bounds", () => {
    const params = computeStoryboardParams(300)!; // 5 min: 60 frames, 10x6
    const vtt = generateVtt(params, 240, 135);
    const imageLines = vtt.split("\n").filter((l) => l.includes("#xywh="));

    expect(imageLines.length).toBe(60);

    for (let i = 0; i < imageLines.length; i++) {
      const match = imageLines[i]!.match(/#xywh=(\d+),(\d+),(\d+),(\d+)/);
      expect(match).not.toBeNull();
      const x = Number(match![1]);
      const y = Number(match![2]);
      const w = Number(match![3]);
      const h = Number(match![4]);

      const col = i % params.cols;
      const row = Math.floor(i / params.cols);
      expect(x).toBe(col * 240);
      expect(y).toBe(row * 135);
      expect(w).toBe(240);
      expect(h).toBe(135);
    }
  });
});

// --- End-to-end storyboard generation ---

async function generateTestSource(dir: string, durationSec: number): Promise<void> {
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
      `testsrc=duration=${durationSec}:size=320x240:rate=15`,
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=440:duration=${durationSec}:sample_rate=48000`,
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

describe("generateStoryboard (end-to-end)", () => {
  test.skipIf(!ffmpegAvailable)(
    "skips generation for short videos (< 60s)",
    async () => {
      const dir = join("data", "test-storyboard-short");
      await generateTestSource(dir, 10);

      const result = await generateStoryboard(dir, 10);
      expect(result).toBe(false);
      expect(await Bun.file(join(dir, "storyboard.jpg")).exists()).toBe(false);
      expect(await Bun.file(join(dir, "storyboard.vtt")).exists()).toBe(false);
    },
    60_000,
  );

  test.skipIf(!ffmpegAvailable)(
    "generates sprite sheet and VTT for a 2-min video",
    async () => {
      const dir = join("data", "test-storyboard-2min");
      await generateTestSource(dir, 120);

      const result = await generateStoryboard(dir, 120);
      expect(result).toBe(true);

      // Sprite sheet should exist
      const sprite = Bun.file(join(dir, "storyboard.jpg"));
      expect(await sprite.exists()).toBe(true);
      expect(sprite.size).toBeGreaterThan(0);

      // VTT should exist and have correct structure
      const vtt = await Bun.file(join(dir, "storyboard.vtt")).text();
      expect(vtt.startsWith("WEBVTT")).toBe(true);
      const cueCount = vtt.split("\n").filter((l) => l.includes("-->")).length;
      expect(cueCount).toBe(24); // 120s / 5s = 24 frames

      // Every cue should reference storyboard.jpg with xywh
      const imageRefs = vtt.split("\n").filter((l) => l.includes("storyboard.jpg#xywh="));
      expect(imageRefs.length).toBe(24);
    },
    120_000,
  );

  test.skipIf(!ffmpegAvailable)(
    "long video scales interval to keep grid manageable",
    async () => {
      // Use a 10-min fixture: interval=6, 100 frames, 10x10 grid
      const dir = join("data", "test-storyboard-10min");
      await generateTestSource(dir, 600);

      const result = await generateStoryboard(dir, 600);
      expect(result).toBe(true);

      const vtt = await Bun.file(join(dir, "storyboard.vtt")).text();
      const cueCount = vtt.split("\n").filter((l) => l.includes("-->")).length;
      expect(cueCount).toBe(100); // 600 / 6 = 100 frames
    },
    180_000,
  );
});
