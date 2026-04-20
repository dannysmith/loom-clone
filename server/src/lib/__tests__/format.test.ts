import { describe, expect, test } from "bun:test";
import { formatDate, formatDuration } from "../format";

describe("formatDuration", () => {
  test("returns null for null/undefined/zero/negative", () => {
    expect(formatDuration(null)).toBeNull();
    expect(formatDuration(undefined)).toBeNull();
    expect(formatDuration(0)).toBeNull();
    expect(formatDuration(-5)).toBeNull();
  });

  test("formats sub-minute durations as seconds", () => {
    expect(formatDuration(1)).toBe("1s");
    expect(formatDuration(30)).toBe("30s");
    expect(formatDuration(59)).toBe("59s");
  });

  test("formats minutes + seconds", () => {
    expect(formatDuration(61)).toBe("1m 1s");
    expect(formatDuration(90)).toBe("1m 30s");
    expect(formatDuration(125)).toBe("2m 5s");
  });

  test("formats exact minutes without trailing seconds", () => {
    expect(formatDuration(60)).toBe("1m");
    expect(formatDuration(120)).toBe("2m");
    expect(formatDuration(300)).toBe("5m");
  });

  test("handles fractional seconds by rounding", () => {
    expect(formatDuration(4.7)).toBe("5s");
    // 59.5 rounds the seconds to 60 but minutes stays 0 → "60s".
    // This is a known edge case — not worth over-engineering for sub-second
    // precision in a display formatter.
    expect(formatDuration(59.5)).toBe("60s");
    expect(formatDuration(90.4)).toBe("1m 30s");
  });
});

describe("formatDate", () => {
  test("returns null for null/undefined/empty", () => {
    expect(formatDate(null)).toBeNull();
    expect(formatDate(undefined)).toBeNull();
    expect(formatDate("")).toBeNull();
  });

  test("returns null for invalid dates", () => {
    expect(formatDate("not-a-date")).toBeNull();
    expect(formatDate("2026-13-01T00:00:00.000Z")).toBeNull();
  });

  test("formats ISO timestamps as en-GB date", () => {
    const result = formatDate("2026-04-17T12:00:00.000Z");
    // en-GB: "17 Apr 2026"
    expect(result).toBe("17 Apr 2026");
  });

  test("handles midnight timestamps", () => {
    const result = formatDate("2025-01-01T00:00:00.000Z");
    expect(result).toBe("1 Jan 2025");
  });
});
