import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { setupTestEnv, type TestEnv, teardownTestEnv } from "../../test-utils";
import {
  backwardMapTime,
  type Chapter,
  chaptersExist,
  chaptersForViewer,
  extractChaptersFromTimeline,
  forwardMapTime,
  generateChaptersVTT,
  readChapters,
  writeChapters,
} from "../chapters";
import type { Edit } from "../edit-transcript";

let env: TestEnv;
beforeEach(async () => {
  env = await setupTestEnv();
});
afterEach(async () => {
  await teardownTestEnv(env);
});

const chapter = (overrides: Partial<Chapter> = {}): Chapter => ({
  id: overrides.id ?? "c1",
  title: overrides.title ?? null,
  t: overrides.t ?? 0,
  createdDuringRecording: overrides.createdDuringRecording ?? true,
});

describe("extractChaptersFromTimeline", () => {
  test("returns empty for timeline without events", () => {
    expect(extractChaptersFromTimeline({})).toEqual([]);
    expect(extractChaptersFromTimeline({ events: [] })).toEqual([]);
  });

  test("ignores non-chapter events", () => {
    const out = extractChaptersFromTimeline({
      events: [
        { kind: "paused", t: 1 },
        { kind: "segment.emitted", t: 2, data: { filename: "x" } },
      ],
    });
    expect(out).toEqual([]);
  });

  test("extracts chapter.marker events with their UUID and time", () => {
    const out = extractChaptersFromTimeline({
      events: [
        { kind: "chapter.marker", t: 12.5, data: { id: "abc" } },
        { kind: "paused", t: 20 },
        { kind: "chapter.marker", t: 33.0, data: { id: "def" } },
      ],
    });
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      id: "abc",
      title: null,
      t: 12.5,
      createdDuringRecording: true,
    });
    expect(out[1]?.id).toBe("def");
  });

  test("returns chapters sorted by time", () => {
    const out = extractChaptersFromTimeline({
      events: [
        { kind: "chapter.marker", t: 30, data: { id: "late" } },
        { kind: "chapter.marker", t: 10, data: { id: "early" } },
      ],
    });
    expect(out.map((c) => c.id)).toEqual(["early", "late"]);
  });

  test("skips events missing required fields", () => {
    const out = extractChaptersFromTimeline({
      events: [
        { kind: "chapter.marker", t: 1 }, // missing data.id
        { kind: "chapter.marker", data: { id: "x" } }, // missing t
        { kind: "chapter.marker", t: -1, data: { id: "y" } }, // negative t
        { kind: "chapter.marker", t: 5, data: { id: "ok" } },
      ],
    });
    expect(out.map((c) => c.id)).toEqual(["ok"]);
  });
});

describe("read/write chapters", () => {
  test("write then read round-trips chapters sorted by time", async () => {
    await writeChapters("vid1", [
      chapter({ id: "second", t: 30 }),
      chapter({ id: "first", t: 10, title: "Intro" }),
    ]);
    const data = await readChapters("vid1");
    expect(data?.version).toBe(1);
    expect(data?.chapters.map((c) => c.id)).toEqual(["first", "second"]);
    expect(data?.chapters[0]?.title).toBe("Intro");
  });

  test("readChapters returns null when file is missing", async () => {
    expect(await readChapters("nonexistent")).toBeNull();
  });

  test("chaptersExist reflects presence + emptiness", async () => {
    expect(await chaptersExist("vid2")).toBe(false);
    await writeChapters("vid2", []);
    expect(await chaptersExist("vid2")).toBe(false);
    await writeChapters("vid2", [chapter({ t: 1 })]);
    expect(await chaptersExist("vid2")).toBe(true);
  });
});

describe("forwardMapTime", () => {
  test("returns t unchanged for a single full-video segment", () => {
    const kept = [{ start: 0, end: 100 }];
    expect(forwardMapTime(42, kept)).toBe(42);
  });

  test("subtracts the time before a trim-from-front", () => {
    const kept = [{ start: 10, end: 50 }]; // trimmed first 10s
    expect(forwardMapTime(15, kept)).toBe(5);
    expect(forwardMapTime(10, kept)).toBe(0);
  });

  test("rebases across multiple kept segments after a cut", () => {
    // Original 0–60, cut 20–40 → kept [{0,20},{40,60}]
    const kept = [
      { start: 0, end: 20 },
      { start: 40, end: 60 },
    ];
    expect(forwardMapTime(10, kept)).toBe(10);
    expect(forwardMapTime(45, kept)).toBe(25); // 20 (first kept) + (45-40)
  });

  test("returns null when t falls inside a cut", () => {
    const kept = [
      { start: 0, end: 20 },
      { start: 40, end: 60 },
    ];
    expect(forwardMapTime(30, kept)).toBeNull();
  });

  test("returns null when t is before the trim-from-front", () => {
    const kept = [{ start: 10, end: 50 }];
    expect(forwardMapTime(5, kept)).toBeNull();
  });
});

describe("backwardMapTime", () => {
  test("returns t unchanged for a single full segment", () => {
    const kept = [{ start: 0, end: 100 }];
    expect(backwardMapTime(42, kept)).toBe(42);
  });

  test("inverts forward-mapping for trimmed-from-front", () => {
    const kept = [{ start: 10, end: 50 }];
    expect(backwardMapTime(5, kept)).toBe(15);
  });

  test("inverts forward-mapping across cuts", () => {
    const kept = [
      { start: 0, end: 20 },
      { start: 40, end: 60 },
    ];
    // viewer 25 = 20 first segment + 5 into the second kept block
    expect(backwardMapTime(25, kept)).toBe(45);
  });

  test("clamps to end of last segment when viewerT exceeds edited duration", () => {
    const kept = [{ start: 0, end: 20 }];
    expect(backwardMapTime(99, kept)).toBe(20);
  });

  test("handles empty kept segments defensively", () => {
    expect(backwardMapTime(5, [])).toBe(5);
  });
});

describe("chaptersForViewer", () => {
  const chapters: Chapter[] = [
    chapter({ id: "a", t: 5 }),
    chapter({ id: "b", t: 30 }), // will fall in a cut
    chapter({ id: "c", t: 50 }),
  ];

  test("returns chapters unchanged when no edits", () => {
    const out = chaptersForViewer(chapters, [], 100);
    expect(out.map((c) => c.t)).toEqual([5, 30, 50]);
  });

  test("remaps timestamps through cuts and drops in-cut chapters", () => {
    const edits: Edit[] = [{ type: "cut", startTime: 20, endTime: 40 }];
    const out = chaptersForViewer(chapters, edits, 100);
    expect(out.map((c) => c.id)).toEqual(["a", "c"]);
    expect(out[0]?.t).toBe(5);
    // chapter "c" was at recording-t=50; after cutting 20-40, kept = [0-20, 40-100],
    // viewer-t = 20 (first kept block length) + (50-40) = 30
    expect(out[1]?.t).toBe(30);
  });
});

describe("generateChaptersVTT", () => {
  test("returns minimal WEBVTT when no chapters", () => {
    expect(generateChaptersVTT([], 100)).toBe("WEBVTT\n");
  });

  test("each cue runs from the chapter to the next chapter (or video end)", () => {
    const vtt = generateChaptersVTT(
      [chapter({ id: "a", t: 0, title: "Intro" }), chapter({ id: "b", t: 30, title: "Setup" })],
      90,
    );
    expect(vtt).toContain("00:00:00.000 --> 00:00:30.000\nIntro");
    expect(vtt).toContain("00:00:30.000 --> 00:01:30.000\nSetup");
  });

  test("falls back to 'Chapter N' for anonymous chapters", () => {
    const vtt = generateChaptersVTT([chapter({ id: "a", t: 0 }), chapter({ id: "b", t: 10 })], 30);
    expect(vtt).toContain("Chapter 1");
    expect(vtt).toContain("Chapter 2");
  });

  test("renders timestamps with HH:MM:SS.mmm", () => {
    const vtt = generateChaptersVTT([chapter({ id: "a", t: 3725.5, title: "Late" })], 7200);
    expect(vtt).toContain("01:02:05.500");
  });

  test("clamps last cue end to video duration even if chapter t exceeds it", () => {
    const vtt = generateChaptersVTT([chapter({ id: "a", t: 200, title: "End" })], 100);
    // Start is clamped to allow at least a tiny end > start
    expect(vtt).toContain("00:03:20.000 --> 00:03:20.001");
  });
});
