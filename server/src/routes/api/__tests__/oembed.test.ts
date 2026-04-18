import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createVideo, trashVideo, updateVideo } from "../../../lib/store";
import { setupTestEnv, type TestEnv, teardownTestEnv } from "../../../test-utils";
import api from "../index";

let env: TestEnv;
beforeEach(async () => {
  env = await setupTestEnv();
});
afterEach(async () => {
  await teardownTestEnv(env);
});

describe("GET /oembed", () => {
  test("returns 400 when url param is missing", async () => {
    const res = await api.request("/oembed");
    expect(res.status).toBe(400);
  });

  test("returns 404 for unknown video URL", async () => {
    const res = await api.request("/oembed?url=%2Fnonexist");
    expect(res.status).toBe(404);
  });

  test("returns video-type oEmbed for a valid video", async () => {
    const video = await createVideo();
    await updateVideo(video.id, { title: "My Demo" });
    const res = await api.request(`/oembed?url=%2F${video.slug}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.version).toBe("1.0");
    expect(body.type).toBe("video");
    expect(body.title).toBe("My Demo");
    expect(body.html).toContain("<iframe");
    expect(body.html).toContain(`/${video.slug}/embed`);
    expect(body.width).toBeGreaterThan(0);
    expect(body.height).toBeGreaterThan(0);
    expect(body.thumbnail_url).toContain("poster.jpg");
  });

  test("uses slug as title when no title set", async () => {
    const video = await createVideo();
    const res = await api.request(`/oembed?url=%2F${video.slug}`);
    const body = await res.json();
    expect(body.title).toBe(video.slug);
  });

  test("respects maxwidth/maxheight while maintaining aspect ratio", async () => {
    const video = await createVideo();
    const res = await api.request(`/oembed?url=%2F${video.slug}&maxwidth=400&maxheight=300`);
    const body = await res.json();
    expect(body.width).toBeLessThanOrEqual(400);
    expect(body.height).toBeLessThanOrEqual(300);
    // 16:9 aspect ratio maintained
    expect(Math.abs(body.width / body.height - 16 / 9)).toBeLessThan(0.1);
  });

  test("returns 404 for trashed video", async () => {
    const video = await createVideo();
    await trashVideo(video.id);
    const res = await api.request(`/oembed?url=%2F${video.slug}`);
    expect(res.status).toBe(404);
  });

  test("accepts absolute URL in the url param", async () => {
    const video = await createVideo();
    const encoded = encodeURIComponent(`http://127.0.0.1:3000/${video.slug}`);
    const res = await api.request(`/oembed?url=${encoded}`);
    expect(res.status).toBe(200);
    expect((await res.json()).type).toBe("video");
  });
});
