import { describe, expect, test } from "bun:test";
import { parseSrtToPlainText } from "../srt";

describe("parseSrtToPlainText", () => {
  test("extracts text from standard SRT", () => {
    const srt = `1
00:00:00,000 --> 00:00:03,000
Hello world.

2
00:00:03,000 --> 00:00:06,000
Second cue here.
`;
    expect(parseSrtToPlainText(srt)).toBe("Hello world. Second cue here.");
  });

  test("handles multi-line cues", () => {
    const srt = `1
00:00:00,000 --> 00:00:03,000
Line one
Line two
`;
    expect(parseSrtToPlainText(srt)).toBe("Line one Line two");
  });

  test("handles Windows line endings", () => {
    const srt = "1\r\n00:00:00,000 --> 00:00:03,000\r\nHello.\r\n";
    expect(parseSrtToPlainText(srt)).toBe("Hello.");
  });

  test("returns empty string for empty input", () => {
    expect(parseSrtToPlainText("")).toBe("");
    expect(parseSrtToPlainText("   \n\n  ")).toBe("");
  });

  test("handles cues with only sequence numbers and timestamps", () => {
    const srt = `1
00:00:00,000 --> 00:00:03,000

2
00:00:03,000 --> 00:00:06,000
`;
    expect(parseSrtToPlainText(srt)).toBe("");
  });
});
