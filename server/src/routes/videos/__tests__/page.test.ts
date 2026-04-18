import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "fs/promises";
import { join } from "path";
import {
  createVideo,
  DATA_DIR,
  trashVideo,
  updateSlug,
  type VideoRecord,
} from "../../../lib/store";
import { setupTestEnv, type TestEnv, teardownTestEnv } from "../../../test-utils";
import videos from "../index";
import page from "../page";

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
    const res = await page.request("/v/deadbeef");
    expect(res.status).toBe(404);
  });

  test("returns HTML page with video player for valid slug", async () => {
    const video = await createVideo();
    const res = await page.request(`/v/${video.slug}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toMatch(/^<!DOCTYPE html>/i);
    expect(html).toContain("<media-player");
    expect(html).toContain(video.slug);
    expect(html).toContain("/static/styles/app.css");
    expect(html).toContain("/static/styles/viewer.css");
  });

  test("falls back to HLS playlist when source.mp4 is absent", async () => {
    const video = await createVideo();
    const res = await page.request(`/v/${video.slug}`);
    const html = await res.text();
    expect(html).toContain(`/data/${video.id}/stream.m3u8`);
    expect(html).not.toContain(`/data/${video.id}/derivatives/source.mp4`);
  });

  test("prefers source.mp4 when the derivative exists", async () => {
    const video = await createVideo();
    await writeDerivative(video, "source.mp4");
    const res = await page.request(`/v/${video.slug}`);
    const html = await res.text();
    expect(html).toContain(`/data/${video.id}/derivatives/source.mp4`);
    expect(html).not.toContain(`stream.m3u8`);
  });

  test("sets poster attribute when thumbnail.jpg exists", async () => {
    const video = await createVideo();
    await writeDerivative(video, "thumbnail.jpg");
    const res = await page.request(`/v/${video.slug}`);
    const html = await res.text();
    expect(html).toContain(`poster="/data/${video.id}/derivatives/thumbnail.jpg"`);
  });

  test("no poster attribute when thumbnail is absent", async () => {
    const video = await createVideo();
    const res = await page.request(`/v/${video.slug}`);
    const html = await res.text();
    expect(html).not.toContain("poster=");
  });

  test("old slug 301-redirects to current slug after rename", async () => {
    const video = await createVideo();
    const oldSlug = video.slug;
    await updateSlug(video.id, "welcome");

    const res = await page.request(`/v/${oldSlug}`, { redirect: "manual" });
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/v/welcome");
  });

  test("current slug returns 200 (not a redirect) after rename", async () => {
    const video = await createVideo();
    await updateSlug(video.id, "fresh");

    const res = await page.request(`/v/fresh`);
    expect(res.status).toBe(200);
  });

  test("trashed video returns 404 on its current slug", async () => {
    const video = await createVideo();
    await trashVideo(video.id);

    const res = await page.request(`/v/${video.slug}`);
    expect(res.status).toBe(404);
  });

  test("trashed video returns 404 on an old redirect slug too", async () => {
    const video = await createVideo();
    const oldSlug = video.slug;
    await updateSlug(video.id, "renamed");
    await trashVideo(video.id);

    const res = await page.request(`/v/${oldSlug}`);
    expect(res.status).toBe(404);
  });
});

describe("GET /:slug (slug-namespaced, via aggregator)", () => {
  test("returns 404 for unknown slug", async () => {
    const res = await videos.request("/deadbeef");
    expect(res.status).toBe(404);
  });

  test("returns HTML page with video player for valid slug", async () => {
    const video = await createVideo();
    const res = await videos.request(`/${video.slug}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("<media-player");
    expect(html).toContain(video.slug);
  });

  test("uses slug-namespaced HLS URL when no MP4 derivative", async () => {
    const video = await createVideo();
    const res = await videos.request(`/${video.slug}`);
    const html = await res.text();
    expect(html).toContain(`/${video.slug}/stream/stream.m3u8`);
    expect(html).not.toContain("/data/");
  });

  test("uses slug-namespaced MP4 URL when derivative exists", async () => {
    const video = await createVideo();
    await writeDerivative(video, "source.mp4");
    const res = await videos.request(`/${video.slug}`);
    const html = await res.text();
    expect(html).toContain(`/${video.slug}/raw/source.mp4`);
    expect(html).not.toContain("/data/");
  });

  test("sets slug-namespaced poster URL", async () => {
    const video = await createVideo();
    await writeDerivative(video, "thumbnail.jpg");
    const res = await videos.request(`/${video.slug}`);
    const html = await res.text();
    expect(html).toContain(`poster="/${video.slug}/poster.jpg"`);
  });

  test("old slug 301-redirects to canonical slug", async () => {
    const video = await createVideo();
    const oldSlug = video.slug;
    await updateSlug(video.id, "hello");

    const res = await videos.request(`/${oldSlug}`, { redirect: "manual" });
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/hello");
  });
});
