import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createVideo, trashVideo, updateSlug, updateVideo } from "../../../lib/store";
import { setupTestEnv, type TestEnv, teardownTestEnv } from "../../../test-utils";
import videos from "../index";

let env: TestEnv;
beforeEach(async () => {
  env = await setupTestEnv();
});
afterEach(async () => {
  await teardownTestEnv(env);
});

describe("GET /:slug.json", () => {
  test("returns 404 JSON for unknown slug", async () => {
    const res = await videos.request("/deadbeef.json");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Not found");
  });

  test("returns JSON with video data and URL bundle", async () => {
    const video = await createVideo();
    await updateVideo(video.id, { title: "My Video" });
    const res = await videos.request(`/${video.slug}.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json();
    expect(body.id).toBe(video.id);
    expect(body.slug).toBe(video.slug);
    expect(body.title).toBe("My Video");
    expect(body.urls.page).toBe(`/${video.slug}`);
    expect(body.urls.raw).toBe(`/${video.slug}/raw/source.mp4`);
    expect(body.urls.hls).toBe(`/${video.slug}/stream/stream.m3u8`);
    expect(body.urls.poster).toBe(`/${video.slug}/poster.jpg`);
  });

  test("old slug 301-redirects to canonical .json URL", async () => {
    const video = await createVideo();
    const oldSlug = video.slug;
    await updateSlug(video.id, "nice-slug");
    const res = await videos.request(`/${oldSlug}.json`, { redirect: "manual" });
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/nice-slug.json");
  });

  test("trashed video returns 404", async () => {
    const video = await createVideo();
    await trashVideo(video.id);
    const res = await videos.request(`/${video.slug}.json`);
    expect(res.status).toBe(404);
  });
});

describe("GET /:slug.md", () => {
  test("returns 404 for unknown slug", async () => {
    const res = await videos.request("/deadbeef.md");
    expect(res.status).toBe(404);
  });

  test("returns Markdown with heading and watch link", async () => {
    const video = await createVideo();
    await updateVideo(video.id, { title: "Tutorial", description: "Learn things." });
    const res = await videos.request(`/${video.slug}.md`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    const md = await res.text();
    expect(md).toContain("# Tutorial");
    expect(md).toContain("Learn things.");
    expect(md).toContain(`[Watch](/${video.slug})`);
  });

  test("uses slug as heading when no title is set", async () => {
    const video = await createVideo();
    const res = await videos.request(`/${video.slug}.md`);
    const md = await res.text();
    expect(md).toContain(`# ${video.slug}`);
  });

  test("old slug 301-redirects to canonical .md URL", async () => {
    const video = await createVideo();
    const oldSlug = video.slug;
    await updateSlug(video.id, "docs-intro");
    const res = await videos.request(`/${oldSlug}.md`, { redirect: "manual" });
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/docs-intro.md");
  });
});
