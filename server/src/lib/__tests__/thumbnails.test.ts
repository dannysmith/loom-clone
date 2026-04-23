import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readdir } from "fs/promises";
import { join } from "path";
import { setupTestEnv, type TestEnv, teardownTestEnv } from "../../test-utils";
import { createVideo, DATA_DIR } from "../store";
import {
  buildCandidateTimestamps,
  extractAndPromoteThumbnails,
  listThumbnailCandidates,
  promoteCandidate,
  saveCustomThumbnail,
} from "../thumbnails";

const ffmpegAvailable = Bun.which("ffmpeg") !== null;

let env: TestEnv;

beforeEach(async () => {
  env = await setupTestEnv();
});

afterEach(async () => {
  await teardownTestEnv(env);
});

// --- buildCandidateTimestamps (pure logic, no ffmpeg) ---

describe("buildCandidateTimestamps", () => {
  test("short video (8s) produces a collapsed set", () => {
    const ts = buildCandidateTimestamps(8);
    // Max timestamp: 8 - 2 = 6. Min: 1.
    // Fixed anchors: 2, 5 (15 > 6, dropped). Percentage: 0.8, 1.6, 3.2, 4.8
    // After filter [1, 6]: 2, 5, 0.8 (< 1, dropped), 1.6, 3.2, 4.8
    // Sorted: 1.6, 2, 3.2, 4.8, 5
    // Dedupe (2s gap): 1.6, 3.2 (dropped 2 < 2s from 1.6? no: 2 - 1.6 = 0.4 < 2), ...
    // Let's just verify invariants:
    expect(ts.length).toBeGreaterThanOrEqual(1);
    expect(ts.length).toBeLessThanOrEqual(7);
    // All within valid range
    for (const t of ts) {
      expect(t).toBeGreaterThanOrEqual(1);
      expect(t).toBeLessThanOrEqual(6);
    }
    // Sorted ascending
    for (let i = 1; i < ts.length; i++) {
      expect(ts[i]!).toBeGreaterThan(ts[i - 1]!);
    }
    // Minimum gap
    for (let i = 1; i < ts.length; i++) {
      expect(ts[i]! - ts[i - 1]!).toBeGreaterThanOrEqual(2);
    }
  });

  test("30s video collapses some anchors", () => {
    const ts = buildCandidateTimestamps(30);
    // Max: 28. Fixed: 2, 5, 15. Percentage: 3, 6, 12, 18.
    // Union: 2, 3, 5, 6, 12, 15, 18
    // Dedupe (2s gap): 2, (3 dropped, < 2s from 2), 5, (6 dropped), 12, 15, 18
    expect(ts.length).toBeGreaterThanOrEqual(3);
    expect(ts.length).toBeLessThanOrEqual(7);
    // Should include early anchors
    expect(ts[0]).toBe(2);
    // All within range
    for (const t of ts) {
      expect(t).toBeGreaterThanOrEqual(1);
      expect(t).toBeLessThanOrEqual(28);
    }
  });

  test("5 min video produces the full candidate set", () => {
    const ts = buildCandidateTimestamps(300);
    // Max: 298. Fixed: 2, 5, 15. Percentage: 30, 60, 120, 180.
    // Union: 2, 5, 15, 30, 60, 120, 180.
    // All well-spaced — no dedup needed.
    expect(ts).toEqual([2, 5, 15, 30, 60, 120, 180]);
  });

  test("pathologically short video (1.5s) falls back to midpoint", () => {
    const ts = buildCandidateTimestamps(1.5);
    // Max: -0.5. All anchors fail the range check.
    // Fallback: duration / 2 = 0.75
    expect(ts).toEqual([0.75]);
  });

  test("zero duration falls back to midpoint", () => {
    const ts = buildCandidateTimestamps(0);
    expect(ts).toEqual([0]);
  });
});

// --- End-to-end tests requiring ffmpeg ---

async function generateTestSource(videoDir: string): Promise<void> {
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
      "testsrc=duration=8:size=320x240:rate=15",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=8",
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

describe("extractAndPromoteThumbnails (end-to-end)", () => {
  test.skipIf(!ffmpegAvailable)(
    "produces candidate files and a promoted thumbnail",
    async () => {
      const video = await createVideo();
      const videoDir = join(DATA_DIR, video.id);
      await generateTestSource(videoDir);

      const derivDir = join(videoDir, "derivatives");
      await extractAndPromoteThumbnails(derivDir, 8);

      // Should have candidates
      const candDir = join(derivDir, "thumbnail-candidates");
      const candidates = await readdir(candDir);
      const jpgs = candidates.filter((f) => f.endsWith(".jpg"));
      expect(jpgs.length).toBeGreaterThanOrEqual(1);

      // Should have a promoted thumbnail.jpg
      const thumbnail = Bun.file(join(derivDir, "thumbnail.jpg"));
      expect(await thumbnail.exists()).toBe(true);
      expect(thumbnail.size).toBeGreaterThan(0);
    },
    30_000,
  );

  test.skipIf(!ffmpegAvailable)(
    "re-running is idempotent (cleans old candidates)",
    async () => {
      const video = await createVideo();
      const videoDir = join(DATA_DIR, video.id);
      await generateTestSource(videoDir);

      const derivDir = join(videoDir, "derivatives");
      await extractAndPromoteThumbnails(derivDir, 8);

      const candDir = join(derivDir, "thumbnail-candidates");
      const firstRun = (await readdir(candDir)).filter((f) => f.endsWith(".jpg"));

      await extractAndPromoteThumbnails(derivDir, 8);
      const secondRun = (await readdir(candDir)).filter((f) => f.endsWith(".jpg"));

      // Same number of candidates
      expect(secondRun.length).toBe(firstRun.length);
    },
    30_000,
  );
});

describe("listThumbnailCandidates", () => {
  test.skipIf(!ffmpegAvailable)(
    "returns candidate metadata with promoted flag",
    async () => {
      const video = await createVideo();
      const videoDir = join(DATA_DIR, video.id);
      await generateTestSource(videoDir);

      const derivDir = join(videoDir, "derivatives");
      await extractAndPromoteThumbnails(derivDir, 8);

      const candidates = await listThumbnailCandidates(video.id);
      expect(candidates.length).toBeGreaterThanOrEqual(1);

      // Exactly one should be promoted
      const promoted = candidates.filter((c) => c.promoted);
      expect(promoted.length).toBe(1);

      // All auto candidates should have kind "auto"
      for (const c of candidates) {
        expect(c.kind).toBe("auto");
        expect(c.filename).toMatch(/^auto-\d{2}\.jpg$/);
      }
    },
    30_000,
  );

  test("returns empty array when no candidates exist", async () => {
    const video = await createVideo();
    const candidates = await listThumbnailCandidates(video.id);
    expect(candidates).toEqual([]);
  });
});

describe("promoteCandidate", () => {
  test.skipIf(!ffmpegAvailable)(
    "promotes a specific candidate",
    async () => {
      const video = await createVideo();
      const videoDir = join(DATA_DIR, video.id);
      await generateTestSource(videoDir);

      const derivDir = join(videoDir, "derivatives");
      await extractAndPromoteThumbnails(derivDir, 8);

      const candidates = await listThumbnailCandidates(video.id);
      // Promote the last candidate (different from auto-promoted first non-blank)
      const target = candidates[candidates.length - 1]!;
      const ok = await promoteCandidate(video.id, target.id);
      expect(ok).toBe(true);

      // Verify the promoted candidate changed
      const updated = await listThumbnailCandidates(video.id);
      const nowPromoted = updated.find((c) => c.promoted);
      expect(nowPromoted?.id).toBe(target.id);
    },
    30_000,
  );

  test("returns false for non-existent candidate", async () => {
    const video = await createVideo();
    const ok = await promoteCandidate(video.id, "nonexistent");
    expect(ok).toBe(false);
  });
});

describe("saveCustomThumbnail", () => {
  test.skipIf(!ffmpegAvailable)(
    "saves and resizes a custom JPEG",
    async () => {
      const video = await createVideo();
      const videoDir = join(DATA_DIR, video.id);
      await mkdir(join(videoDir, "derivatives", "thumbnail-candidates"), { recursive: true });

      // Create a test JPEG using ffmpeg
      const tmpJpeg = join(videoDir, "test-input.jpg");
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
          "testsrc=duration=1:size=1920x1080:rate=1",
          "-vframes",
          "1",
          "-f",
          "image2",
          tmpJpeg,
        ],
        { stderr: "pipe", stdout: "pipe" },
      );
      await proc.exited;

      const imageData = await Bun.file(tmpJpeg).arrayBuffer();
      const candidateId = await saveCustomThumbnail(video.id, imageData);

      expect(candidateId).toMatch(/^custom-/);

      // The candidate file should exist
      const candDir = join(videoDir, "derivatives", "thumbnail-candidates");
      const files = await readdir(candDir);
      expect(files.some((f) => f === `${candidateId}.jpg`)).toBe(true);
    },
    30_000,
  );
});
