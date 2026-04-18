import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "fs/promises";
import { join } from "path";
import { createVideo, DATA_DIR, updateSlug, type VideoRecord } from "../../../lib/store";
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

describe("GET /v/:slug (back-compat redirect)", () => {
  test("301 redirects to /:slug", async () => {
    const video = await createVideo();
    const res = await page.request(`/v/${video.slug}`, { redirect: "manual" });
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe(`/${video.slug}`);
  });

  test("redirects unknown slugs too — resolution happens at the target", async () => {
    const res = await page.request("/v/nonexist", { redirect: "manual" });
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/nonexist");
  });

  test("redirects sub-paths: /v/:slug/embed → /:slug/embed", async () => {
    const video = await createVideo();
    const res = await page.request(`/v/${video.slug}/embed`, { redirect: "manual" });
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe(`/${video.slug}/embed`);
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
