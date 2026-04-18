import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createVideo, setVideoStatus, updateVideo } from "../../../lib/store";
import { setupTestEnv, type TestEnv, teardownTestEnv } from "../../../test-utils";
import wellKnown from "../well-known";

let env: TestEnv;
beforeEach(async () => {
  env = await setupTestEnv();
});
afterEach(async () => {
  await teardownTestEnv(env);
});

describe("GET /", () => {
  test("returns 200 HTML landing page", async () => {
    const res = await wellKnown.request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toMatch(/^<!DOCTYPE html>/i);
    expect(html).toContain("loom-clone");
  });
});

describe("GET /robots.txt", () => {
  test("returns text/plain disallowing /admin and /api", async () => {
    const res = await wellKnown.request("/robots.txt");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const body = await res.text();
    expect(body).toContain("Disallow: /admin");
    expect(body).toContain("Disallow: /api");
  });
});

describe("GET /favicon.ico", () => {
  test("returns 204 No Content", async () => {
    const res = await wellKnown.request("/favicon.ico");
    expect(res.status).toBe(204);
  });
});

describe("GET /sitemap.xml", () => {
  test("returns empty sitemap when no public videos exist", async () => {
    const res = await wellKnown.request("/sitemap.xml");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/xml");
    const body = await res.text();
    expect(body).toContain("<urlset");
    expect(body).toContain("</urlset>");
    expect(body).not.toContain("<url>");
  });

  test("includes public complete videos with video extension", async () => {
    const video = await createVideo();
    await updateVideo(video.id, { visibility: "public", title: "Public Video" });
    await setVideoStatus(video.id, "complete");

    const res = await wellKnown.request("/sitemap.xml");
    const body = await res.text();
    expect(body).toContain("<url>");
    expect(body).toContain(`/${video.slug}`);
    expect(body).toContain("<video:video>");
    expect(body).toContain("<video:title>Public Video</video:title>");
    expect(body).toContain("<video:content_loc>");
    expect(body).toContain("<video:player_loc>");
  });

  test("excludes unlisted videos", async () => {
    const video = await createVideo();
    await setVideoStatus(video.id, "complete");
    // visibility defaults to "unlisted"

    const res = await wellKnown.request("/sitemap.xml");
    const body = await res.text();
    expect(body).not.toContain(video.slug);
  });

  test("excludes incomplete videos", async () => {
    const video = await createVideo();
    await updateVideo(video.id, { visibility: "public" });
    // status defaults to "recording"

    const res = await wellKnown.request("/sitemap.xml");
    const body = await res.text();
    expect(body).not.toContain(video.slug);
  });
});
