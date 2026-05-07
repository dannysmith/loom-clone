import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "fs/promises";
import { join } from "path";
import { setupTestEnv, type TestEnv, teardownTestEnv } from "../../test-utils";
import {
  generateSuggestedEdits,
  parseSilenceDetectOutput,
  suggestionsFromSilences,
} from "../suggested-edits";

const ffmpegAvailable = Bun.which("ffmpeg") !== null;

let env: TestEnv;

beforeEach(async () => {
  env = await setupTestEnv();
});

afterEach(async () => {
  await teardownTestEnv(env);
});

describe("parseSilenceDetectOutput", () => {
  test("parses paired silence_start / silence_end lines", () => {
    const stderr = [
      "ffmpeg blah blah",
      "[silencedetect @ 0x123] silence_start: 4.123",
      "[silencedetect @ 0x123] silence_end: 8.567 | silence_duration: 4.444",
      "[silencedetect @ 0x123] silence_start: 30.0",
      "[silencedetect @ 0x123] silence_end: 33.2 | silence_duration: 3.2",
    ].join("\n");
    const result = parseSilenceDetectOutput(stderr, 60);
    expect(result).toEqual([
      { start: 4.123, end: 8.567 },
      { start: 30.0, end: 33.2 },
    ]);
  });

  test("treats an unmatched final silence_start as silence to end of file", () => {
    const stderr = [
      "[silencedetect @ 0x123] silence_start: 4.0",
      "[silencedetect @ 0x123] silence_end: 8.0 | silence_duration: 4.0",
      "[silencedetect @ 0x123] silence_start: 56.0",
    ].join("\n");
    const result = parseSilenceDetectOutput(stderr, 60);
    expect(result).toEqual([
      { start: 4.0, end: 8.0 },
      { start: 56.0, end: 60 },
    ]);
  });

  test("clamps negative starts and out-of-range ends", () => {
    const stderr = [
      "[silencedetect @ 0x123] silence_start: -0.5",
      "[silencedetect @ 0x123] silence_end: 3.0 | silence_duration: 3.0",
      "[silencedetect @ 0x123] silence_start: 10.0",
      "[silencedetect @ 0x123] silence_end: 65.0 | silence_duration: 55.0",
    ].join("\n");
    const result = parseSilenceDetectOutput(stderr, 60);
    expect(result[0]?.start).toBe(0);
    expect(result[1]?.end).toBe(60);
  });

  test("returns empty for stderr with no silence reports", () => {
    expect(parseSilenceDetectOutput("nothing here", 60)).toEqual([]);
  });
});

describe("suggestionsFromSilences", () => {
  test("interior silences become cuts with inward padding", () => {
    const result = suggestionsFromSilences([{ start: 30, end: 35 }], 60);
    expect(result).toEqual([{ type: "cut", startTime: 30.1, endTime: 34.9 }]);
  });

  test("leading silence rolls up into a suggested trim startTime", () => {
    const result = suggestionsFromSilences([{ start: 0, end: 5 }], 60);
    expect(result).toHaveLength(1);
    const trim = result[0];
    expect(trim).toBeDefined();
    expect(trim?.type).toBe("trim");
    expect(trim?.startTime).toBeCloseTo(4.9, 5);
    expect(trim?.endTime).toBe(60);
  });

  test("trailing silence rolls up into a suggested trim endTime", () => {
    const result = suggestionsFromSilences([{ start: 56, end: 60 }], 60);
    expect(result).toHaveLength(1);
    const trim = result[0];
    expect(trim).toBeDefined();
    expect(trim?.type).toBe("trim");
    expect(trim?.startTime).toBe(0);
    expect(trim?.endTime).toBeCloseTo(56.1, 5);
  });

  test("combines leading + trailing + interior into one trim and one cut", () => {
    const result = suggestionsFromSilences(
      [
        { start: 0, end: 4 },
        { start: 30, end: 33 },
        { start: 117, end: 120 },
      ],
      120,
    );
    const trim = result.find((e) => e.type === "trim");
    const cuts = result.filter((e) => e.type === "cut");
    expect(trim).toBeDefined();
    expect(trim?.startTime).toBeCloseTo(3.9, 5);
    expect(trim?.endTime).toBeCloseTo(117.1, 5);
    expect(cuts).toHaveLength(1);
    expect(cuts[0]?.startTime).toBeCloseTo(30.1, 5);
    expect(cuts[0]?.endTime).toBeCloseTo(32.9, 5);
  });

  test("returns empty when no silences present", () => {
    expect(suggestionsFromSilences([], 60)).toEqual([]);
  });
});

describe("generateSuggestedEdits", () => {
  test("returns false for very short videos", async () => {
    const dir = join(env.tempDir, "derivatives");
    await mkdir(dir, { recursive: true });
    expect(await generateSuggestedEdits(dir, 1)).toBe(false);
  });

  test("does not overwrite an existing suggested-edits.json", async () => {
    const dir = join(env.tempDir, "derivatives");
    await mkdir(dir, { recursive: true });
    const path = join(dir, "suggested-edits.json");
    const sentinel = '{"sentinel":true}';
    await Bun.write(path, sentinel);

    expect(await generateSuggestedEdits(dir, 60)).toBe(false);
    expect(await Bun.file(path).text()).toBe(sentinel);
  });

  test.skipIf(!ffmpegAvailable)(
    "writes a file for an audio source containing leading silence",
    async () => {
      const dir = join(env.tempDir, "derivatives");
      await mkdir(dir, { recursive: true });
      const sourcePath = join(dir, "silence-source.mp4");

      // 4s silence + 4s tone — should produce a leading-silence trim suggestion.
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
          "anullsrc=channel_layout=mono:sample_rate=48000",
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=440:sample_rate=48000",
          "-filter_complex",
          "[0]atrim=duration=4[a0];[1]atrim=duration=4[a1];[a0][a1]concat=n=2:v=0:a=1[out]",
          "-map",
          "[out]",
          "-c:a",
          "aac",
          "-b:a",
          "96k",
          "-t",
          "8",
          "-f",
          "mp4",
          sourcePath,
        ],
        { stderr: "pipe", stdout: "pipe" },
      );
      const exit = await proc.exited;
      if (exit !== 0) {
        throw new Error(
          `fixture build failed (exit ${exit}): ${await new Response(proc.stderr).text()}`,
        );
      }

      const generated = await generateSuggestedEdits(dir, 8, { inputPath: sourcePath });
      expect(generated).toBe(true);

      const file = Bun.file(join(dir, "suggested-edits.json"));
      expect(await file.exists()).toBe(true);
      const data = (await file.json()) as { edits: Array<{ type: string }> };
      expect(data.edits.length).toBeGreaterThan(0);
      // Leading silence at 0..4 should appear as a trim adjustment.
      expect(data.edits.some((e) => e.type === "trim")).toBe(true);
    },
    30_000,
  );
});
