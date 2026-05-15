import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { siteConfig } from "../../../lib/site-config";
import { createVideo, setVideoStatus, updateVideo } from "../../../lib/store";
import { createTag, updateTag } from "../../../lib/tags";
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
  test("returns 302 redirect to author URL", async () => {
    const res = await wellKnown.request("/", { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(siteConfig.authorUrl);
  });

  test("includes HTML body with feed hints for curl/AI agents", async () => {
    const res = await wellKnown.request("/", { redirect: "manual" });
    const body = await res.text();
    expect(body).toContain("<!DOCTYPE html>");
    expect(body).toContain("/llms.txt");
    expect(body).toContain("/feed.xml");
    expect(body).toContain("/feed.json");
    expect(body).toContain("/sitemap.xml");
  });

  test("includes Link header for RSS autodiscovery", async () => {
    const res = await wellKnown.request("/", { redirect: "manual" });
    const link = res.headers.get("link");
    expect(link).toContain("/feed.xml");
    expect(link).toContain("application/rss+xml");
  });

  test("does not contain loom-clone in public body", async () => {
    const res = await wellKnown.request("/", { redirect: "manual" });
    const body = await res.text();
    expect(body.toLowerCase()).not.toContain("loom-clone");
    expect(body.toLowerCase()).not.toContain("loom clone");
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

  test("includes public tag pages (no video child)", async () => {
    const tag = await createTag("tutorials");
    await updateTag(tag.id, { visibility: "public", slug: "tutorials" });

    const res = await wellKnown.request("/sitemap.xml");
    const body = await res.text();
    expect(body).toContain("/tutorials</loc>");
  });

  test("excludes unlisted and private tags", async () => {
    const u = await createTag("unl");
    await updateTag(u.id, { visibility: "unlisted", slug: "unlisted-tag" });
    await createTag("internal"); // remains private by default

    const res = await wellKnown.request("/sitemap.xml");
    const body = await res.text();
    expect(body).not.toContain("unlisted-tag");
    expect(body).not.toContain("internal");
  });
});
