import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { mkdir } from "fs/promises";
import { join } from "path";
import { getDb } from "../../../db/client";
import type { ProcessingStepKind } from "../../../db/schema";
import { videos } from "../../../db/schema";
import { setupTestEnv, type TestEnv, teardownTestEnv } from "../../../test-utils";
import { createVideo, DATA_DIR, getVideo } from "../../store";
import { canReprocess, computeReadiness, type ReadinessItem, reprocessability } from "../readiness";
import { markStepFailed, markStepReady } from "../steps-store";

let env: TestEnv;

beforeEach(async () => {
  env = await setupTestEnv();
});

afterEach(async () => {
  await teardownTestEnv(env);
});

// Artifact filename per file-producing step (mirrors the registry). Steps not
// listed (metadata, audio, external items) produce no on-disk file.
const ARTIFACT: Partial<Record<ProcessingStepKind, string>> = {
  source: "source.mp4",
  thumbnail: "thumbnail.jpg",
  variant_1080: "1080p.mp4",
  variant_720: "720p.mp4",
  storyboard: "storyboard.vtt",
  peaks: "peaks.json",
  suggested_edits: "suggested-edits.json",
};

// Mark a step ready AND write its artifact (a `ready` row only renders ✅ when
// the file is actually present).
async function markReady(videoId: string, kind: ProcessingStepKind): Promise<void> {
  const file = ARTIFACT[kind];
  if (file) {
    const dir = join(DATA_DIR, videoId, "derivatives");
    await mkdir(dir, { recursive: true });
    await Bun.write(join(dir, file), "stub");
  }
  await markStepReady(videoId, kind);
}

// A ready recorded video at the given resolution/duration, with source +
// metadata validated (the mandatory set).
async function readyVideo(opts: { width: number; height: number; duration: number }) {
  const video = await createVideo();
  await getDb()
    .update(videos)
    .set({
      status: "ready",
      width: opts.width,
      height: opts.height,
      durationSeconds: opts.duration,
      completedAt: new Date().toISOString(),
    })
    .where(eq(videos.id, video.id));
  await markReady(video.id, "source");
  await markReady(video.id, "metadata");
  return (await getVideo(video.id))!;
}

function icon(items: ReadinessItem[], kind: string): string | undefined {
  return items.find((i) => i.kind === kind)?.icon;
}

describe("computeReadiness — icons", () => {
  test("required steps that are ready show ✅; not-applicable variant shows —", async () => {
    const video = await readyVideo({ width: 1920, height: 1080, duration: 120 });
    const { items } = await computeReadiness(video);

    expect(icon(items, "source")).toBe("ready");
    expect(icon(items, "metadata")).toBe("ready");
    // 1080p source: a 1080p variant doesn't apply, a 720p one does.
    expect(icon(items, "variant_1080")).toBe("na");
  });

  test("an applicable expected step not yet produced on a ready video shows ⏳ (enriching)", async () => {
    const video = await readyVideo({ width: 1920, height: 1080, duration: 120 });
    const { items } = await computeReadiness(video);
    // variant_720 applies (1080 > 720) but hasn't been marked ready.
    expect(icon(items, "variant_720")).toBe("pending");
  });

  test("a missing external item on a ready video shows ❌ (never ⏳)", async () => {
    const video = await readyVideo({ width: 1280, height: 720, duration: 30 });
    const { items } = await computeReadiness(video);
    expect(icon(items, "transcript")).toBe("missing");
  });

  test("a ready row whose file was hand-deleted shows ❌", async () => {
    const video = await readyVideo({ width: 1280, height: 720, duration: 30 });
    // Mark peaks ready but never write the file.
    await markStepReady(video.id, "peaks");
    const { items } = await computeReadiness(video);
    expect(icon(items, "peaks")).toBe("missing");
  });

  test("a ready row with its file present shows ✅", async () => {
    const video = await readyVideo({ width: 1280, height: 720, duration: 30 });
    const dir = join(DATA_DIR, video.id, "derivatives");
    await mkdir(dir, { recursive: true });
    await Bun.write(join(dir, "peaks.json"), "[]");
    await markStepReady(video.id, "peaks");
    const { items } = await computeReadiness(video);
    expect(icon(items, "peaks")).toBe("ready");
  });

  test("uploaded videos never expect the Mac-sent items (—) or audio", async () => {
    const video = await createVideo();
    await getDb()
      .update(videos)
      .set({ status: "ready", source: "uploaded", width: 1280, height: 720, durationSeconds: 30 })
      .where(eq(videos.id, video.id));
    const { items } = await computeReadiness((await getVideo(video.id))!);
    expect(icon(items, "transcript")).toBe("na");
    expect(icon(items, "audio")).toBe("na");
  });
});

describe("computeReadiness — badge", () => {
  test("null for non-ready videos", async () => {
    const video = await createVideo(); // status: recording
    expect((await computeReadiness(video)).badge).toBeNull();
  });

  test("'enriching (N left)' when expected steps are still pending", async () => {
    const video = await readyVideo({ width: 1920, height: 1080, duration: 120 });
    const { badge } = await computeReadiness(video);
    expect(badge).toMatch(/^enriching \(\d+ left\)$/);
  });

  test("'awaiting transcript' when only the transcript is missing", async () => {
    // Upload (no audio/external-expected): mark every applicable expected step
    // ready so the only gap is... nothing external for uploads. Use a recorded
    // video and satisfy all expected steps, leaving only externals.
    const video = await readyVideo({ width: 1280, height: 720, duration: 30 });
    // Applicable expected for 720p/30s recorded: audio, thumbnail, peaks, suggested_edits.
    for (const k of ["audio", "thumbnail", "peaks", "suggested_edits"] as const) {
      await markReady(video.id, k);
    }
    // Satisfy all external items except transcript.
    for (const k of [
      "words",
      "title_suggestion",
      "description_suggestion",
      "chapter_titles",
    ] as const) {
      await markReady(video.id, k);
    }
    const { badge } = await computeReadiness(video);
    expect(badge).toBe("awaiting transcript");
  });

  test("'complete ✓' when every applicable item is satisfied", async () => {
    // Uploaded video: no audio, no external items — so satisfying the handful of
    // applicable expected steps completes it.
    const video = await createVideo();
    await getDb()
      .update(videos)
      .set({ status: "ready", source: "uploaded", width: 1280, height: 720, durationSeconds: 30 })
      .where(eq(videos.id, video.id));
    await markReady(video.id, "source");
    await markReady(video.id, "metadata");
    for (const k of ["thumbnail", "peaks", "suggested_edits"] as const) {
      await markReady(video.id, k);
    }
    const { badge } = await computeReadiness((await getVideo(video.id))!);
    expect(badge).toBe("complete ✓");
  });

  test("'N failed' (not 'enriching') when an expected step failed", async () => {
    // Uploaded ready video with everything satisfied except a FAILED expected
    // step — it won't progress, so the badge must flag it rather than counting
    // it as forever-enriching.
    const video = await createVideo();
    await getDb()
      .update(videos)
      .set({ status: "ready", source: "uploaded", width: 1280, height: 720, durationSeconds: 30 })
      .where(eq(videos.id, video.id));
    await markReady(video.id, "source");
    await markReady(video.id, "metadata");
    for (const k of ["thumbnail", "peaks"] as const) await markReady(video.id, k);
    await markStepFailed(video.id, "suggested_edits", "boom");

    const { badge } = await computeReadiness((await getVideo(video.id))!);
    expect(badge).toBe("1 failed");
  });
});

describe("canReprocess", () => {
  test("allowed for ready/processing_failed/incomplete, refused otherwise", async () => {
    const video = await createVideo();
    const withStatus = (s: string) => ({ ...video, status: s, trashedAt: null }) as never;
    expect(canReprocess(withStatus("ready"))).toBe(true);
    expect(canReprocess(withStatus("processing_failed"))).toBe(true);
    expect(canReprocess(withStatus("incomplete"))).toBe(true);
    expect(canReprocess(withStatus("recording"))).toBe(false);
    expect(canReprocess(withStatus("reprocessing"))).toBe(false);
    expect(canReprocess({ ...video, status: "ready", trashedAt: "x" } as never)).toBe(false);
  });
});

describe("reprocessability", () => {
  test("valid source + HLS present → rebuildable both ways, no data loss", async () => {
    const video = await readyVideo({ width: 1280, height: 720, duration: 30 }); // writes source.mp4 + source step
    await Bun.write(join(DATA_DIR, video.id, "stream.m3u8"), "#EXTM3U");

    const r = await reprocessability((await getVideo(video.id))!);
    expect(r).toEqual({ canRebuildSource: true, sourceValid: true, dataLoss: false });
  });

  test("cleaned-up video (valid source, no HLS) can't rebuild source but isn't data-loss", async () => {
    const video = await readyVideo({ width: 1280, height: 720, duration: 30 });
    const r = await reprocessability(video);
    expect(r.sourceValid).toBe(true);
    expect(r.canRebuildSource).toBe(false);
    expect(r.dataLoss).toBe(false);
  });

  test("no source and no HLS → data loss", async () => {
    const video = await createVideo();
    await getDb().update(videos).set({ status: "ready" }).where(eq(videos.id, video.id));
    const r = await reprocessability((await getVideo(video.id))!);
    expect(r.dataLoss).toBe(true);
  });

  test("uploaded video with upload.mp4 present can rebuild source", async () => {
    const video = await createVideo();
    await getDb()
      .update(videos)
      .set({ status: "ready", source: "uploaded" })
      .where(eq(videos.id, video.id));
    await Bun.write(join(DATA_DIR, video.id, "upload.mp4"), "stub");
    const r = await reprocessability((await getVideo(video.id))!);
    expect(r.canRebuildSource).toBe(true);
  });
});

describe("computeReadiness — regenerable flag", () => {
  test("downstream items are regenerable when source is valid; required source is not", async () => {
    const video = await readyVideo({ width: 1920, height: 1080, duration: 120 });
    const { items } = await computeReadiness(video);
    expect(items.find((i) => i.kind === "thumbnail")?.regenerable).toBe(true);
    expect(items.find((i) => i.kind === "peaks")?.regenerable).toBe(true);
    // source/audio are not standalone-regenerable; external items aren't either.
    expect(items.find((i) => i.kind === "source")?.regenerable).toBe(false);
    expect(items.find((i) => i.kind === "audio")?.regenerable).toBe(false);
    expect(items.find((i) => i.kind === "transcript")?.regenerable).toBe(false);
  });

  test("nothing is regenerable when source is invalid", async () => {
    const video = await createVideo();
    await getDb()
      .update(videos)
      .set({ status: "ready", width: 1280, height: 720, durationSeconds: 30 })
      .where(eq(videos.id, video.id));
    const { items } = await computeReadiness((await getVideo(video.id))!);
    expect(items.every((i) => !i.regenerable)).toBe(true);
  });
});
