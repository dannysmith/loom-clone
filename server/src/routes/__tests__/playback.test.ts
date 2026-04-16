import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "fs/promises";
import { join } from "path";
import { createVideo, DATA_DIR, type VideoRecord } from "../../lib/store";
import { setupTestEnv, type TestEnv, teardownTestEnv } from "../../test-utils";
import playback from "../playback";

let env: TestEnv;

beforeEach(async () => {
  env = await setupTestEnv();
});

afterEach(async () => {
  await teardownTestEnv(env);
});

async function writeDerivative(video: VideoRecord, filename: string): Promise<void> {
  const dir = join(DATA_DIR, video.id, "derivatives");
  await mkdir(dir, { recursive: true });
  await Bun.write(join(dir, filename), "stub");
}

describe("GET /v/:slug", () => {
  test("returns 404 for unknown slug", async () => {
    const res = await playback.request("/v/deadbeef");
    expect(res.status).toBe(404);
  });

  test("returns HTML page with video player for valid slug", async () => {
    const video = await createVideo();
    const res = await playback.request(`/v/${video.slug}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("<media-player");
    expect(html).toContain(video.slug);
  });

  test("falls back to HLS playlist when source.mp4 is absent", async () => {
    const video = await createVideo();
    const res = await playback.request(`/v/${video.slug}`);
    const html = await res.text();
    expect(html).toContain(`/data/${video.id}/stream.m3u8`);
    expect(html).not.toContain(`/data/${video.id}/derivatives/source.mp4`);
  });

  test("prefers source.mp4 when the derivative exists", async () => {
    const video = await createVideo();
    await writeDerivative(video, "source.mp4");
    const res = await playback.request(`/v/${video.slug}`);
    const html = await res.text();
    expect(html).toContain(`/data/${video.id}/derivatives/source.mp4`);
    expect(html).not.toContain(`stream.m3u8`);
  });

  test("sets poster attribute when thumbnail.jpg exists", async () => {
    const video = await createVideo();
    await writeDerivative(video, "thumbnail.jpg");
    const res = await playback.request(`/v/${video.slug}`);
    const html = await res.text();
    expect(html).toContain(`poster="/data/${video.id}/derivatives/thumbnail.jpg"`);
  });

  test("no poster attribute when thumbnail is absent", async () => {
    const video = await createVideo();
    const res = await playback.request(`/v/${video.slug}`);
    const html = await res.text();
    expect(html).not.toContain("poster=");
  });
});
