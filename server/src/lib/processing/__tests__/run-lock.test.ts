import { describe, expect, test } from "bun:test";
import { clearRunActive, hasActiveRun, markRunActive } from "../run-lock";

describe("run-lock (reference-counted advisory signal)", () => {
  test("a single mark/clear toggles the signal", () => {
    const id = "rl-single";
    expect(hasActiveRun(id)).toBe(false);
    markRunActive(id);
    expect(hasActiveRun(id)).toBe(true);
    clearRunActive(id);
    expect(hasActiveRun(id)).toBe(false);
  });

  test("overlapping holders stay active until the LAST one releases", () => {
    const id = "rl-overlap";
    markRunActive(id); // holder A
    markRunActive(id); // holder B
    expect(hasActiveRun(id)).toBe(true);
    clearRunActive(id); // A done — B still holds
    expect(hasActiveRun(id)).toBe(true);
    clearRunActive(id); // B done
    expect(hasActiveRun(id)).toBe(false);
  });

  test("clearing an unknown id is a safe no-op (never goes negative)", () => {
    const id = "rl-unknown";
    clearRunActive(id);
    expect(hasActiveRun(id)).toBe(false);
    markRunActive(id);
    expect(hasActiveRun(id)).toBe(true);
  });
});
