import { describe, expect, test } from "bun:test";
import {
  computeKeptSegments,
  deriveEditedTranscript,
  type Edit,
  type Word,
} from "../edit-transcript";

describe("computeKeptSegments", () => {
  test("no edits returns full duration", () => {
    const result = computeKeptSegments([], 60);
    expect(result).toEqual([{ start: 0, end: 60 }]);
  });

  test("trim only", () => {
    const edits: Edit[] = [{ type: "trim", startTime: 5, endTime: 55 }];
    const result = computeKeptSegments(edits, 60);
    expect(result).toEqual([{ start: 5, end: 55 }]);
  });

  test("single cut in the middle", () => {
    const edits: Edit[] = [{ type: "cut", startTime: 20, endTime: 30 }];
    const result = computeKeptSegments(edits, 60);
    expect(result).toEqual([
      { start: 0, end: 20 },
      { start: 30, end: 60 },
    ]);
  });

  test("multiple cuts", () => {
    const edits: Edit[] = [
      { type: "cut", startTime: 10, endTime: 15 },
      { type: "cut", startTime: 40, endTime: 50 },
    ];
    const result = computeKeptSegments(edits, 60);
    expect(result).toEqual([
      { start: 0, end: 10 },
      { start: 15, end: 40 },
      { start: 50, end: 60 },
    ]);
  });

  test("trim + cuts", () => {
    const edits: Edit[] = [
      { type: "trim", startTime: 5, endTime: 55 },
      { type: "cut", startTime: 20, endTime: 30 },
    ];
    const result = computeKeptSegments(edits, 60);
    expect(result).toEqual([
      { start: 5, end: 20 },
      { start: 30, end: 55 },
    ]);
  });

  test("cut at the very start of kept range", () => {
    const edits: Edit[] = [{ type: "cut", startTime: 0, endTime: 10 }];
    const result = computeKeptSegments(edits, 60);
    expect(result).toEqual([{ start: 10, end: 60 }]);
  });

  test("cut at the very end of kept range", () => {
    const edits: Edit[] = [{ type: "cut", startTime: 50, endTime: 60 }];
    const result = computeKeptSegments(edits, 60);
    expect(result).toEqual([{ start: 0, end: 50 }]);
  });

  test("overlapping cuts are handled correctly", () => {
    const edits: Edit[] = [
      { type: "cut", startTime: 10, endTime: 25 },
      { type: "cut", startTime: 20, endTime: 35 },
    ];
    const result = computeKeptSegments(edits, 60);
    expect(result).toEqual([
      { start: 0, end: 10 },
      { start: 35, end: 60 },
    ]);
  });

  test("cut that spans entire duration returns empty", () => {
    const edits: Edit[] = [{ type: "cut", startTime: 0, endTime: 60 }];
    const result = computeKeptSegments(edits, 60);
    expect(result).toEqual([]);
  });

  test("adjacent cuts with no gap", () => {
    const edits: Edit[] = [
      { type: "cut", startTime: 10, endTime: 20 },
      { type: "cut", startTime: 20, endTime: 30 },
    ];
    const result = computeKeptSegments(edits, 60);
    expect(result).toEqual([
      { start: 0, end: 10 },
      { start: 30, end: 60 },
    ]);
  });
});

describe("deriveEditedTranscript", () => {
  const words: Word[] = [
    { word: "Hello", start: 0.0, end: 0.3 },
    { word: "world", start: 0.5, end: 0.8 },
    { word: "this", start: 1.0, end: 1.2 },
    { word: "is", start: 1.3, end: 1.5 },
    { word: "um", start: 2.0, end: 2.3 },
    { word: "a", start: 2.5, end: 2.6 },
    { word: "test", start: 2.8, end: 3.0 },
    { word: "video", start: 3.2, end: 3.5 },
    { word: "recording", start: 4.0, end: 4.5 },
    { word: "thanks", start: 5.0, end: 5.3 },
  ];

  test("no edits preserves all words", () => {
    const segments = [{ start: 0, end: 6 }];
    const result = deriveEditedTranscript(words, segments);
    expect(result.words).toHaveLength(10);
    expect(result.plainText).toBe("Hello world this is um a test video recording thanks");
  });

  test("trim from start removes early words", () => {
    const segments = [{ start: 2.0, end: 6 }];
    const result = deriveEditedTranscript(words, segments);
    // Words starting at 2.0+ with timestamps shifted by 2.0
    expect(result.words[0]!.word).toBe("um");
    expect(result.words[0]!.start).toBe(0);
    expect(result.words[0]!.end).toBe(0.3);
    expect(result.plainText).not.toContain("Hello");
    expect(result.plainText).toContain("um");
  });

  test("cut in the middle removes words and shifts timestamps", () => {
    // Cut out "um a test" (2.0 - 3.0)
    const segments = [
      { start: 0, end: 2.0 },
      { start: 3.0, end: 6 },
    ];
    const result = deriveEditedTranscript(words, segments);
    const wordTexts = result.words.map((w) => w.word);
    expect(wordTexts).not.toContain("um");
    expect(wordTexts).not.toContain("a");
    // "test" ends at 3.0 which is the cut boundary — it won't be included
    // because its start (2.8) is in the cut region.
    expect(wordTexts).toContain("Hello");
    expect(wordTexts).toContain("video");

    // "video" was at 3.2-3.5 in original. After cutting 2.0-3.0 (1 second),
    // it should be shifted back by 1.0 to 2.2-2.5.
    const videoWord = result.words.find((w) => w.word === "video");
    expect(videoWord!.start).toBe(2.2);
    expect(videoWord!.end).toBe(2.5);
  });

  test("produces valid SRT output", () => {
    const segments = [{ start: 0, end: 6 }];
    const result = deriveEditedTranscript(words, segments);
    expect(result.srt).toContain("1\n00:00:00,000 -->");
    expect(result.srt).toContain("Hello");
  });

  test("empty kept segments returns empty result", () => {
    const result = deriveEditedTranscript(words, []);
    expect(result.words).toHaveLength(0);
    expect(result.plainText).toBe("");
    expect(result.srt).toBe("");
  });

  test("words partially overlapping a segment boundary are excluded", () => {
    // A word that starts before the segment but ends inside it is excluded
    // (the filter requires w.start >= seg.start AND w.end <= seg.end).
    const segments = [{ start: 0.4, end: 1.0 }];
    const result = deriveEditedTranscript(words, segments);
    // Only "world" (0.5-0.8) fits entirely within 0.4-1.0.
    expect(result.words).toHaveLength(1);
    expect(result.words[0]!.word).toBe("world");
  });
});
