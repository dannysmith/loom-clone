import { describe, expect, test } from "bun:test";
import { parseRange } from "../file-serve";

describe("parseRange", () => {
  const size = 1000;

  test("parses a standard range", () => {
    expect(parseRange("bytes=0-499", size)).toEqual({ start: 0, end: 499 });
    expect(parseRange("bytes=500-999", size)).toEqual({ start: 500, end: 999 });
    expect(parseRange("bytes=2-5", size)).toEqual({ start: 2, end: 5 });
  });

  test("parses an open-ended range (bytes=N-)", () => {
    expect(parseRange("bytes=500-", size)).toEqual({ start: 500, end: 999 });
    expect(parseRange("bytes=0-", size)).toEqual({ start: 0, end: 999 });
    expect(parseRange("bytes=999-", size)).toEqual({ start: 999, end: 999 });
  });

  test("parses a suffix range (bytes=-N)", () => {
    expect(parseRange("bytes=-100", size)).toEqual({ start: 900, end: 999 });
    expect(parseRange("bytes=-1", size)).toEqual({ start: 999, end: 999 });
    expect(parseRange("bytes=-1000", size)).toEqual({ start: 0, end: 999 });
    // Suffix larger than file — clamps to start of file
    expect(parseRange("bytes=-2000", size)).toEqual({ start: 0, end: 999 });
  });

  test("returns null for malformed headers", () => {
    expect(parseRange("", size)).toBeNull();
    expect(parseRange("bytes=", size)).toBeNull();
    expect(parseRange("bytes=abc-def", size)).toBeNull();
    expect(parseRange("characters=0-100", size)).toBeNull();
    expect(parseRange("bytes=0-100, 200-300", size)).toBeNull(); // multi-range
    expect(parseRange("bytes=--5", size)).toBeNull();
  });

  test("returns null when start > end", () => {
    expect(parseRange("bytes=500-100", size)).toBeNull();
  });

  test("clamps end to file boundary (RFC 7233)", () => {
    // End beyond file size → clamped to last byte, not rejected
    expect(parseRange("bytes=0-1000", size)).toEqual({ start: 0, end: 999 });
    expect(parseRange("bytes=0-5242879", size)).toEqual({ start: 0, end: 999 });
    expect(parseRange("bytes=900-2000", size)).toEqual({ start: 900, end: 999 });
  });

  test("returns null when start is at or beyond file size", () => {
    expect(parseRange("bytes=1000-1000", size)).toBeNull(); // start >= size
    expect(parseRange("bytes=1001-", size)).toBeNull();
  });

  test("handles zero-size file", () => {
    // Any range on a zero-byte file is unsatisfiable
    expect(parseRange("bytes=0-0", 0)).toBeNull();
    expect(parseRange("bytes=0-", 0)).toBeNull();
    // Suffix range on zero-byte file: start = max(0, 0-N) = 0, end = -1 → start > end
    expect(parseRange("bytes=-1", 0)).toBeNull();
  });

  test("handles single-byte file", () => {
    expect(parseRange("bytes=0-0", 1)).toEqual({ start: 0, end: 0 });
    expect(parseRange("bytes=0-", 1)).toEqual({ start: 0, end: 0 });
    expect(parseRange("bytes=-1", 1)).toEqual({ start: 0, end: 0 });
  });
});
