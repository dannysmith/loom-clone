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
  test("every video gets a storyboard, however short", () => {
    // No duration floor: the storyboard was the only viewer-facing artifact
    // whose existence moved when a video was edited, which is how a trim once
    // orphaned one describing the uncut timeline.
    expect(computeStoryboardParams(30)).not.toBeNull();
    expect(computeStoryboardParams(59)).not.toBeNull();
    expect(computeStoryboardParams(60)).not.toBeNull();
  });

  test("a video shorter than one interval still gets a single tile", () => {
    // floor(3/5) is zero frames — a 0x0 tile and a VTT with no cues.
    expect(computeStoryboardParams(3)).toEqual({
      interval: 3,
      expectedFrames: 1,
      cols: 1,
      rows: 1,
      duration: 3,
    });
  });

  test("returns null only when there is no video to sample", () => {
    expect(computeStoryboardParams(0)).toBeNull();
  });

  test("2 min video: 5s interval, 24 frames, 10x3 grid", () => {
    const result = computeStoryboardParams(120);
    expect(result).toEqual({
      interval: 5,
      expectedFrames: 24,
      cols: 10,
      rows: 3,
      duration: 120,
    });
  });

  test("5 min video: 5s interval, 60 frames, 10x6 grid", () => {
    const result = computeStoryboardParams(300);
    expect(result).toEqual({
      interval: 5,
      expectedFrames: 60,
      cols: 10,
      rows: 6,
      duration: 300,
    });
  });

  test("10 min video: 6s interval, 100 frames, 10x10 grid", () => {
    const result = computeStoryboardParams(600);
    expect(result).toEqual({
      interval: 6,
      expectedFrames: 100,
      cols: 10,
      rows: 10,
      duration: 600,
    });
  });

  test("1 hour video: 36s interval, 100 frames, 10x10 grid", () => {
    const result = computeStoryboardParams(3600);
    expect(result).toEqual({
      interval: 36,
      expectedFrames: 100,
      cols: 10,
      rows: 10,
      duration: 3600,
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
    // Frame 23: starts at 23*5=115, ends at the video's end — 120 either way
    // here, because 120 divides evenly by the 5s interval.
    expect(lastLine).toBe("00:01:55.000 --> 00:02:00.000");
  });

  test("last cue runs to the video's end when the duration isn't a whole number of intervals", () => {
    // 601s at a 6s interval is 100 frames covering 600s. Ending the last cue on
    // the interval boundary would leave the final second of the scrubber with no
    // thumbnail at all.
    const params = computeStoryboardParams(601)!;
    expect(params.interval).toBe(6);
    expect(params.expectedFrames).toBe(100);

    const vtt = generateVtt(params, 240, 135);
    const lines = vtt.split("\n").filter((l) => l.includes("-->"));
    expect(lines[lines.length - 1]).toBe("00:09:54.000 --> 00:10:01.000");
    // Earlier cues keep their interval boundaries.
    expect(lines[0]).toBe("00:00:00.000 --> 00:00:06.000");
  });

  test("a short video's single cue spans the whole thing", () => {
    // The case that made this visible: an 11s video is 2 tiles at 5s each, so a
    // boundary-ending last cue left a ninth of the scrubber blank.
    const params = computeStoryboardParams(11)!;
    const lines = generateVtt(params, 240, 135)
      .split("\n")
      .filter((l) => l.includes("-->"));
    expect(lines.length).toBe(2);
    expect(lines[1]).toBe("00:00:05.000 --> 00:00:11.000");
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
    "generates for a short video, with the last cue stopping at the video end",
    async () => {
      const dir = join("data", "test-storyboard-short");
      await generateTestSource(dir, 10);

      const result = await generateStoryboard(dir, 10);
      expect(result).toBe(true);
      expect(await Bun.file(join(dir, "storyboard.jpg")).exists()).toBe(true);

      // Two 5s tiles for a 10s video, and the final cue ends at 10s rather than
      // overrunning to the next interval boundary.
      const vtt = await Bun.file(join(dir, "storyboard.vtt")).text();
      expect(vtt.match(/ --> /g)?.length).toBe(2);
      expect(vtt).toContain("00:00:05.000 --> 00:00:10.000");
    },
    60_000,
  );

  test.skipIf(!ffmpegAvailable)(
    "a video shorter than one interval produces a single usable tile",
    async () => {
      // The degenerate end of removing the duration floor: ffmpeg is asked for a
      // 1x1 tile from a 3-second source.
      const dir = join("data", "test-storyboard-tiny");
      await generateTestSource(dir, 3);

      expect(await generateStoryboard(dir, 3)).toBe(true);
      expect(Bun.file(join(dir, "storyboard.jpg")).size).toBeGreaterThan(0);
      const vtt = await Bun.file(join(dir, "storyboard.vtt")).text();
      expect(vtt.match(/ --> /g)?.length).toBe(1);
      expect(vtt).toContain("00:00:00.000 --> 00:00:03.000");
      // The sampling interval shrank to fit — `fps=1/5` would have emitted no
      // frame at all for a clip this short.
      expect(computeStoryboardParams(3)?.interval).toBe(3);
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
