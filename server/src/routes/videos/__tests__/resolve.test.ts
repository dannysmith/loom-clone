import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { mkdir } from "fs/promises";
import { join } from "path";
import { getDb } from "../../../db/client";
import { videos as videosTable } from "../../../db/schema";
import { createVideo, DATA_DIR, type Video } from "../../../lib/store";
import { setupTestEnv, type TestEnv, teardownTestEnv } from "../../../test-utils";
import { resolveForViewer, type ViewerVideo } from "../resolve";

let env: TestEnv;

beforeEach(async () => {
  env = await setupTestEnv();
});

afterEach(async () => {
  await teardownTestEnv(env);
});

async function writeDerivative(video: Video, filename: string): Promise<void> {
  const dir = join(DATA_DIR, video.id, "derivatives");
  await mkdir(dir, { recursive: true });
  await Bun.write(join(dir, filename), "stub");
}

// Width/height/aspect are written by the metadata extraction step in
// derivatives.ts (which requires ffmpeg). For these tests we set them
// directly via drizzle so the tests stay ffmpeg-free.
async function setDimensions(videoId: string, width: number, height: number): Promise<void> {
  const aspectRatio = Math.round((width / height) * 10000) / 10000;
  await getDb()
    .update(videosTable)
    .set({ width, height, aspectRatio })
    .where(eq(videosTable.id, videoId));
}

function asViewer(result: Awaited<ReturnType<typeof resolveForViewer>>): ViewerVideo {
  if (!result || "redirect" in result) throw new Error("expected ViewerVideo");
  return result;
}

describe("resolveForViewer — <source> ordering", () => {
  test("HLS fallback when no MP4 source exists", async () => {
    const video = await createVideo();
    const v = asViewer(await resolveForViewer(video.slug));
    expect(v.sources).toBeNull();
    expect(v.src).toBe(`/${video.slug}/stream/stream.m3u8`);
  });

  test("source ≤720p: only source.mp4 in sources", async () => {
    const video = await createVideo();
    await setDimensions(video.id, 1280, 720);
    await writeDerivative(video, "source.mp4");

    const v = asViewer(await resolveForViewer(video.slug));
    expect(v.sources).not.toBeNull();
    expect(v.sources?.map((s) => s.src)).toEqual([`/${video.slug}/raw/source.mp4`]);
  });

  test("source = 1080p: source.mp4 first, 720p second (no 1080p variant on disk)", async () => {
    const video = await createVideo();
    await setDimensions(video.id, 1920, 1080);
    await writeDerivative(video, "source.mp4");
    await writeDerivative(video, "720p.mp4");

    const v = asViewer(await resolveForViewer(video.slug));
    expect(v.sources?.map((s) => s.src)).toEqual([
      `/${video.slug}/raw/source.mp4`,
      `/${video.slug}/raw/720p.mp4`,
    ]);
  });

  test("source > 1080p: 1080p.mp4 first (default playback), source.mp4 second, 720p.mp4 third", async () => {
    const video = await createVideo();
    await setDimensions(video.id, 2560, 1440);
    await writeDerivative(video, "source.mp4");
    await writeDerivative(video, "1080p.mp4");
    await writeDerivative(video, "720p.mp4");

    const v = asViewer(await resolveForViewer(video.slug));
    expect(v.sources?.map((s) => s.src)).toEqual([
      `/${video.slug}/raw/1080p.mp4`,
      `/${video.slug}/raw/source.mp4`,
      `/${video.slug}/raw/720p.mp4`,
    ]);
  });

  test("source > 1080p: leading 1080p variant carries data-width/height for the Quality menu", async () => {
    const video = await createVideo();
    // 16:9 4K source
    await setDimensions(video.id, 3840, 2160);
    await writeDerivative(video, "source.mp4");
    await writeDerivative(video, "1080p.mp4");
    await writeDerivative(video, "720p.mp4");

    const v = asViewer(await resolveForViewer(video.slug));
    const first = v.sources?.[0];
    expect(first?.height).toBe(1080);
    // 1080 × (3840/2160) = 1920, rounded to even
    expect(first?.width).toBe(1920);
    // source.mp4 (2nd) keeps its native dimensions
    const second = v.sources?.[1];
    expect(second?.width).toBe(3840);
    expect(second?.height).toBe(2160);
  });
});
