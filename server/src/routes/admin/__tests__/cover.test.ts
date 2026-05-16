import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "fs/promises";
import { join } from "path";
import { createApp } from "../../../app";
import { createVideo, DATA_DIR, trashVideo, updateVideo } from "../../../lib/store";
import { setupTestEnv, type TestEnv, teardownTestEnv } from "../../../test-utils";

const ffmpegAvailable = Bun.which("ffmpeg") !== null;
const ORIGIN = "http://localhost";

let env: TestEnv;
beforeEach(async () => {
  env = await setupTestEnv();
});
afterEach(async () => {
  await teardownTestEnv(env);
});

describe("GET /admin/videos/:id/cover", () => {
  test("returns 200 with the cover-root shell and data-* attributes", async () => {
    const app = createApp();
    const video = await createVideo();
    await updateVideo(video.id, { title: "My talk" });

    const res = await app.request(`/admin/videos/${video.id}/cover`);
    expect(res.status).toBe(200);

    const html = await res.text();
    expect(html).toContain('id="cover-root"');
    expect(html).toContain(`data-video-id="${video.id}"`);
    expect(html).toContain(`data-video-slug="${video.slug}"`);
    expect(html).toContain('data-video-title="My talk"');
    // publicUrl ends in /:slug (absolute URL)
    expect(html).toMatch(new RegExp(`data-video-public-url="https?:\\/\\/[^"]+\\/${video.slug}"`));
    // current thumbnail URL points at the admin media route
    expect(html).toContain(`data-video-thumbnail-url="/admin/videos/${video.id}/media/poster.jpg"`);
  });

  test("renders an empty title attr when the video has no title", async () => {
    const app = createApp();
    const video = await createVideo();
    const res = await app.request(`/admin/videos/${video.id}/cover`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-video-title=""');
  });

  test("rejects trashed videos", async () => {
    const app = createApp();
    const video = await createVideo();
    await trashVideo(video.id);
    const res = await app.request(`/admin/videos/${video.id}/cover`);
    expect(res.status).toBe(400);
  });

  test("returns 404 for unknown video", async () => {
    const app = createApp();
    const res = await app.request("/admin/videos/nope/cover");
    expect(res.status).toBe(404);
  });
});

describe("POST /admin/videos/:id/thumbnail/add-candidate", () => {
  test("rejects requests without a file", async () => {
    const app = createApp();
    const video = await createVideo();
    const fd = new FormData();
    const res = await app.request(`/admin/videos/${video.id}/thumbnail/add-candidate`, {
      method: "POST",
      body: fd,
      headers: { Origin: ORIGIN },
    });
    expect(res.status).toBe(400);
  });

  test("rejects oversized files", async () => {
    const app = createApp();
    const video = await createVideo();
    // 6 MB blob — over the 5 MB limit.
    const big = new Blob([new Uint8Array(6 * 1024 * 1024)], { type: "image/jpeg" });
    const fd = new FormData();
    fd.append("thumbnail", big, "cover.jpg");
    const res = await app.request(`/admin/videos/${video.id}/thumbnail/add-candidate`, {
      method: "POST",
      body: fd,
      headers: { Origin: ORIGIN },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/too large/i);
  });

  test("rejects non-image content types", async () => {
    const app = createApp();
    const video = await createVideo();
    const fd = new FormData();
    fd.append("thumbnail", new Blob(["hi"], { type: "text/plain" }), "cover.txt");
    const res = await app.request(`/admin/videos/${video.id}/thumbnail/add-candidate`, {
      method: "POST",
      body: fd,
      headers: { Origin: ORIGIN },
    });
    expect(res.status).toBe(400);
  });

  test.skipIf(!ffmpegAvailable)(
    "saves a candidate without auto-promoting",
    async () => {
      const app = createApp();
      const video = await createVideo();
      await mkdir(join(DATA_DIR, video.id, "derivatives", "thumbnail-candidates"), {
        recursive: true,
      });

      // Generate a real JPEG with ffmpeg so saveCustomThumbnail can resize it.
      const tmpJpeg = join(DATA_DIR, video.id, "input.jpg");
      const proc = Bun.spawn(
        [
          "ffmpeg",
          "-y",
          "-hide_banner",
          "-loglevel",
          "error",
          "-f",
          "lavfi",
          "-i",
          "testsrc=duration=1:size=1545x869:rate=1",
          "-vframes",
          "1",
          "-f",
          "image2",
          tmpJpeg,
        ],
        { stderr: "pipe", stdout: "pipe" },
      );
      await proc.exited;

      const jpegBytes = await Bun.file(tmpJpeg).arrayBuffer();
      const fd = new FormData();
      fd.append("thumbnail", new Blob([jpegBytes], { type: "image/jpeg" }), "cover.jpg");

      const res = await app.request(`/admin/videos/${video.id}/thumbnail/add-candidate`, {
        method: "POST",
        body: fd,
        headers: { Origin: ORIGIN },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; candidateId: string };
      expect(body.ok).toBe(true);
      expect(body.candidateId).toMatch(/^custom-/);

      // The candidate file exists.
      const candPath = join(
        DATA_DIR,
        video.id,
        "derivatives",
        "thumbnail-candidates",
        `${body.candidateId}.jpg`,
      );
      expect(await Bun.file(candPath).exists()).toBe(true);

      // thumbnail.jpg should NOT exist — no auto-promote.
      const thumbPath = join(DATA_DIR, video.id, "derivatives", "thumbnail.jpg");
      expect(await Bun.file(thumbPath).exists()).toBe(false);
    },
    30_000,
  );
});
