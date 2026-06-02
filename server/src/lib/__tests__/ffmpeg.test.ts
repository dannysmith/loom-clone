import { describe, expect, test } from "bun:test";
import { spawnFfmpeg } from "../ffmpeg";

// Drives the helper with the bun binary as a stand-in "ffmpeg" so we can emit
// an exact, known amount to stdout/stderr and assert the bounded-tail behaviour
// deterministically (no real ffmpeg dependency).
const BUN = process.execPath;
const emit = (script: string) => spawnFfmpeg(BUN, ["-e", script]);

describe("spawnFfmpeg bounded stderr capture", () => {
  test("returns short stderr in full", async () => {
    const { exitCode, stderr } = await emit(`process.stderr.write("hello stderr")`);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("hello stderr");
  });

  test("propagates non-zero exit code", async () => {
    const { exitCode } = await emit(`process.stderr.write("boom"); process.exit(7)`);
    expect(exitCode).toBe(7);
  });

  test("keeps only the last N bytes when stderr exceeds the tail", async () => {
    // 200 KB of filler then a marker — only the marker-bearing tail should survive.
    const script = `process.stderr.write("A".repeat(200000) + "TAIL_MARKER")`;
    const { stderr } = await spawnFfmpeg(BUN, ["-e", script], { tailBytes: 64 * 1024 });
    expect(stderr.endsWith("TAIL_MARKER")).toBe(true);
    // Bounded: tail cap + at most one trailing chunk; nowhere near the 200 KB total.
    expect(stderr.length).toBeLessThanOrEqual(64 * 1024 + 64 * 1024);
    expect(stderr.length).toBeGreaterThanOrEqual(64 * 1024);
  });

  test("a trailing JSON block survives tail truncation (loudnorm-shaped)", async () => {
    // Mirrors how loudnorm prints: lots of progress-like noise, JSON at the end.
    const json = '{ "input_i": "-21.75", "target_offset": "0.05" }';
    const script = `process.stderr.write("noise\\n".repeat(50000) + ${JSON.stringify(json)})`;
    const { stderr } = await spawnFfmpeg(BUN, ["-e", script], { tailBytes: 64 * 1024 });
    const lastBrace = stderr.lastIndexOf("}");
    const firstBrace = stderr.lastIndexOf("{", lastBrace);
    const parsed = JSON.parse(stderr.substring(firstBrace, lastBrace + 1));
    expect(parsed.input_i).toBe("-21.75");
  });

  test("keepStderrLines retains every matching line, including early ones", async () => {
    // 5000 markers interleaved with filler that far exceeds the 64 KB tail —
    // a rolling tail would drop the early markers; the line collector must not.
    const script = [
      "for (let i = 0; i < 5000; i++) {",
      `  process.stderr.write("filler ".repeat(20) + "\\n");`,
      `  process.stderr.write("[silencedetect] silence_start: " + i + "\\n");`,
      "}",
    ].join("\n");
    const { stderr } = await spawnFfmpeg(BUN, ["-e", script], {
      keepStderrLines: /silence_(start|end):/,
    });
    const lines = stderr.split("\n").filter(Boolean);
    expect(lines.length).toBe(5000);
    expect(lines[0]).toContain("silence_start: 0"); // earliest survived
    expect(lines.at(-1)).toContain("silence_start: 4999"); // latest too
    expect(lines.every((l) => l.includes("silence_"))).toBe(true); // only matches kept
  });

  test("stdout is ignored unless captureStdout is set", async () => {
    const without = await emit(`process.stdout.write("data on stdout")`);
    expect(without.stdout).toBe("");

    const withCapture = await spawnFfmpeg(BUN, ["-e", `process.stdout.write("data on stdout")`], {
      captureStdout: true,
    });
    expect(withCapture.stdout).toBe("data on stdout");
  });
});
