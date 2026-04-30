import { describe, expect, test } from "bun:test";
import { slugFromTitle } from "../slug-utils";

describe("slugFromTitle", () => {
  test("basic title produces lowercase dashed slug", () => {
    expect(slugFromTitle("Welcome to the Team")).toBe("welcome-team");
  });

  test("strips common stop words", () => {
    expect(slugFromTitle("How to Build a Great Product")).toBe("build-great-product");
  });

  test("strips punctuation", () => {
    expect(slugFromTitle("Hello, World! This is a test.")).toBe("hello-world-test");
  });

  test("strips emojis", () => {
    expect(slugFromTitle("🚀 Launch Day Recap 🎉")).toBe("launch-day-recap");
  });

  test("falls back to unfiltered words when all are stop words", () => {
    expect(slugFromTitle("it is what it is")).toBe("it-is-what-it-is");
  });

  test("returns empty string for empty input", () => {
    expect(slugFromTitle("")).toBe("");
  });

  test("returns empty string for emoji-only input", () => {
    expect(slugFromTitle("🎉🚀✨")).toBe("");
  });

  test("truncates single long word to target length", () => {
    const long = "a".repeat(100);
    const result = slugFromTitle(long);
    expect(result.length).toBe(50);
  });

  test("stops adding words near target length", () => {
    const title = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike";
    const result = slugFromTitle(title);
    expect(result.length).toBeLessThanOrEqual(55); // may slightly exceed due to full-word inclusion
    expect(result.length).toBeGreaterThan(20);
    expect(result).toMatch(/^[a-z]+(-[a-z]+)*$/);
  });

  test("handles hyphens in original title", () => {
    expect(slugFromTitle("Pre-brief for Monday's Meeting")).toBe("pre-brief-mondays-meeting");
  });

  test("keeps numbers", () => {
    expect(slugFromTitle("Q4 2025 Product Update")).toBe("q4-2025-product-update");
  });

  test("collapses multiple spaces", () => {
    expect(slugFromTitle("lots   of    spaces")).toBe("lots-spaces");
  });

  test("trims leading and trailing whitespace", () => {
    expect(slugFromTitle("  hello world  ")).toBe("hello-world");
  });

  test("produces valid slug characters only", () => {
    const result = slugFromTitle("Über Cool Feature — Pro™ Edition (v2.1)");
    expect(result).toMatch(/^[a-z0-9](-?[a-z0-9])*$/);
  });
});
