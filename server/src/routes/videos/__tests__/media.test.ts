import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "fs/promises";
import { join } from "path";
import { createVideo, DATA_DIR, trashVideo, updateSlug } from "../../../lib/store";
import { setupTestEnv, type TestEnv, teardownTestEnv } from "../../../test-utils";
import videos from "../index";
import media from "../media";

let env: TestEnv;
beforeEach(async () => {
  env = await setupTestEnv();
});
afterEach(async () => {
  await teardownTestEnv(env);
});

async function writeVideoFile(videoId: string, relPath: string, content: string | Uint8Array) {
  const full = join(DATA_DIR, videoId, relPath);
  const dir = full.substring(0, full.lastIndexOf("/"));
  await mkdir(dir, { recursive: true });
  await Bun.write(full, content);
}

describe("GET /:slug/raw/:file", () => {
  test("serves source.mp4 with video/mp4 content type", async () => {
    const video = await createVideo();
    await writeVideoFile(video.id, "derivatives/source.mp4", "fake-mp4");
    const res = await media.request(`/${video.slug}/raw/source.mp4`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("video/mp4");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(await res.text()).toBe("fake-mp4");
  });

  test("accepts resolution-based names like 720p.mp4", async () => {
    const video = await createVideo();
    await writeVideoFile(video.id, "derivatives/720p.mp4", "data");
    const res = await media.request(`/${video.slug}/raw/720p.mp4`);
    expect(res.status).toBe(200);
  });

  test("rejects files not matching the allowlist", async () => {
    const video = await createVideo();
    const res = await media.request(`/${video.slug}/raw/evil.sh`);
    expect(res.status).toBe(404);
  });

  test("returns 404 for missing file on disk", async () => {
    const video = await createVideo();
    const res = await media.request(`/${video.slug}/raw/source.mp4`);
    expect(res.status).toBe(404);
  });

  test("returns 404 for unknown slug", async () => {
    const res = await media.request("/nonexist/raw/source.mp4");
    expect(res.status).toBe(404);
  });

  test("resolves old slug transparently (no redirect)", async () => {
    const video = await createVideo();
    const oldSlug = video.slug;
    await updateSlug(video.id, "newname");
    await writeVideoFile(video.id, "derivatives/source.mp4", "bytes");
    const res = await media.request(`/${oldSlug}/raw/source.mp4`);
    expect(res.status).toBe(200);
  });

  test("supports Range requests", async () => {
    const video = await createVideo();
    await writeVideoFile(video.id, "derivatives/source.mp4", "0123456789");
    const res = await media.request(`/${video.slug}/raw/source.mp4`, {
      headers: { Range: "bytes=2-5" },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(await res.text()).toBe("2345");
  });
});

describe("GET /:slug/stream/:file", () => {
  test("serves stream.m3u8 with correct content type", async () => {
    const video = await createVideo();
    await writeVideoFile(video.id, "stream.m3u8", "#EXTM3U\n");
    const res = await media.request(`/${video.slug}/stream/stream.m3u8`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/vnd.apple.mpegurl");
  });

  test("serves init.mp4 with video/mp4 content type", async () => {
    const video = await createVideo();
    await writeVideoFile(video.id, "init.mp4", "init");
    const res = await media.request(`/${video.slug}/stream/init.mp4`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("video/mp4");
  });

  test("serves seg_NNN.m4s with correct content type", async () => {
    const video = await createVideo();
    await writeVideoFile(video.id, "seg_001.m4s", "segment");
    const res = await media.request(`/${video.slug}/stream/seg_001.m4s`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("video/iso.segment");
  });

  test("rejects invalid filenames", async () => {
    const video = await createVideo();
    const res = await media.request(`/${video.slug}/stream/../../etc/passwd`);
    expect(res.status).toBe(404);
  });

  test("returns 404 for unknown slug", async () => {
    const res = await media.request("/nonexist/stream/stream.m3u8");
    expect(res.status).toBe(404);
  });
});

describe("GET /:slug/poster.jpg", () => {
  test("serves thumbnail.jpg as image/jpeg", async () => {
    const video = await createVideo();
    await writeVideoFile(video.id, "derivatives/thumbnail.jpg", "jpeg-data");
    const res = await media.request(`/${video.slug}/poster.jpg`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
  });

  test("returns 404 when thumbnail doesn't exist yet", async () => {
    const video = await createVideo();
    const res = await media.request(`/${video.slug}/poster.jpg`);
    expect(res.status).toBe(404);
  });

  test("returns 404 for unknown slug", async () => {
    const res = await media.request("/nonexist/poster.jpg");
    expect(res.status).toBe(404);
  });
});

describe("GET /:slug.mp4 (via aggregator)", () => {
  test("302 redirects to /raw/source.mp4", async () => {
    const video = await createVideo();
    const res = await videos.request(`/${video.slug}.mp4`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/${video.slug}/raw/source.mp4`);
  });

  test("returns 404 for unknown slug", async () => {
    const res = await videos.request("/nonexist.mp4");
    expect(res.status).toBe(404);
  });

  test("resolves old slug and redirects to canonical", async () => {
    const video = await createVideo();
    const oldSlug = video.slug;
    await updateSlug(video.id, "latest");
    const res = await videos.request(`/${oldSlug}.mp4`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/latest/raw/source.mp4");
  });

  test("returns 404 for trashed video", async () => {
    const video = await createVideo();
    await trashVideo(video.id);
    const res = await videos.request(`/${video.slug}.mp4`);
    expect(res.status).toBe(404);
  });
});
