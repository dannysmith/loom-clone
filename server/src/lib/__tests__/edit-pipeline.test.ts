import { describe, expect, test } from "bun:test";
import { _buildFfmpegEditArgs } from "../edit-pipeline";

// The edited re-encode reads the same genuinely-VFR source.mp4 as the variant
// encode, so it needs the same `-fps_mode passthrough` guard — otherwise
// libx264 re-times frames onto the source's unreliable declared r_frame_rate
// and silently drops the surplus. See _variantFfmpegArgs in derivatives.ts.
describe("buildFfmpegEditArgs frame-rate handling", () => {
  function assertPassthrough(args: string[]) {
    const i = args.indexOf("-fps_mode");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe("passthrough");
    // Must not force a constant rate.
    expect(args).not.toContain("-r");
  }

  test("simple single-segment trim requests passthrough", () => {
    const args = _buildFfmpegEditArgs("/in/source.mp4", "/out/edited.mp4.tmp", [
      { start: 1, end: 5 },
    ]);
    assertPassthrough(args);
  });

  test("multi-segment concat requests passthrough", () => {
    const args = _buildFfmpegEditArgs("/in/source.mp4", "/out/edited.mp4.tmp", [
      { start: 1, end: 5 },
      { start: 10, end: 12 },
    ]);
    assertPassthrough(args);
  });
});
