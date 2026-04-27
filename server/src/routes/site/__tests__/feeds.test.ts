import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { siteConfig } from "../../../lib/site-config";
import { createVideo, setVideoStatus, trashVideo, updateVideo } from "../../../lib/store";
import { setupTestEnv, type TestEnv, teardownTestEnv } from "../../../test-utils";
import feeds from "../feeds";

let env: TestEnv;
beforeEach(async () => {
  env = await setupTestEnv();
});
afterEach(async () => {
  await teardownTestEnv(env);
});

describe("GET /feed.xml", () => {
  test("returns valid RSS+MRSS XML with correct content type", async () => {
    const res = await feeds.request("/feed.xml");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/rss+xml");
    const body = await res.text();
    expect(body).toMatch(/^<\?xml version="1.0"/);
    expect(body).toContain("xmlns:media=");
    expect(body).toContain("<channel>");
    expect(body).toContain("</channel>");
  });

  test("includes site config metadata in channel", async () => {
    const res = await feeds.request("/feed.xml");
    const body = await res.text();
    // Apostrophes are XML-escaped in the output
    expect(body).toContain(`<title>Danny&#39;s Videos</title>`);
    expect(body).toContain(siteConfig.tagline);
    expect(body).toContain("<language>en</language>");
    expect(body).toContain('rel="self"');
  });

  test("returns empty feed when no public videos exist", async () => {
    const res = await feeds.request("/feed.xml");
    const body = await res.text();
    expect(body).not.toContain("<item>");
  });

  test("includes public complete videos", async () => {
    const video = await createVideo();
    await updateVideo(video.id, { visibility: "public", title: "Public Video" });
    await setVideoStatus(video.id, "complete");

    const res = await feeds.request("/feed.xml");
    const body = await res.text();
    expect(body).toContain("<item>");
    expect(body).toContain("<title>Public Video</title>");
    expect(body).toContain(`/${video.slug}`);
    expect(body).toContain("<enclosure");
    expect(body).toContain("video/mp4");
    expect(body).toContain("<media:content");
    expect(body).toContain("<media:thumbnail");
    expect(body).toContain("<media:title>Public Video</media:title>");
  });

  test("uses slug as title when video has no title", async () => {
    const video = await createVideo();
    await updateVideo(video.id, { visibility: "public" });
    await setVideoStatus(video.id, "complete");

    const res = await feeds.request("/feed.xml");
    const body = await res.text();
    expect(body).toContain(`<title>${video.slug}</title>`);
  });

  test("includes description when present", async () => {
    const video = await createVideo();
    await updateVideo(video.id, {
      visibility: "public",
      title: "Described",
      description: "A cool walkthrough",
    });
    await setVideoStatus(video.id, "complete");

    const res = await feeds.request("/feed.xml");
    const body = await res.text();
    expect(body).toContain("A cool walkthrough");
  });

  test("excludes unlisted videos", async () => {
    const video = await createVideo();
    await setVideoStatus(video.id, "complete");
    // visibility defaults to "unlisted"

    const res = await feeds.request("/feed.xml");
    const body = await res.text();
    expect(body).not.toContain(video.slug);
  });

  test("excludes private videos", async () => {
    const video = await createVideo();
    await updateVideo(video.id, { visibility: "private" });
    await setVideoStatus(video.id, "complete");

    const res = await feeds.request("/feed.xml");
    const body = await res.text();
    expect(body).not.toContain(video.slug);
  });

  test("excludes incomplete videos", async () => {
    const video = await createVideo();
    await updateVideo(video.id, { visibility: "public" });
    // status defaults to "recording"

    const res = await feeds.request("/feed.xml");
    const body = await res.text();
    expect(body).not.toContain(video.slug);
  });

  test("excludes trashed videos", async () => {
    const video = await createVideo();
    await updateVideo(video.id, { visibility: "public" });
    await setVideoStatus(video.id, "complete");
    await trashVideo(video.id);

    const res = await feeds.request("/feed.xml");
    const body = await res.text();
    expect(body).not.toContain(video.slug);
  });

  test("orders videos newest first", async () => {
    const v1 = await createVideo();
    await updateVideo(v1.id, { visibility: "public", title: "First" });
    await setVideoStatus(v1.id, "complete");

    const v2 = await createVideo();
    await updateVideo(v2.id, { visibility: "public", title: "Second" });
    await setVideoStatus(v2.id, "complete");

    const res = await feeds.request("/feed.xml");
    const body = await res.text();
    const firstIdx = body.indexOf("<title>First</title>");
    const secondIdx = body.indexOf("<title>Second</title>");
    // Second (newer) should appear before First (older)
    expect(secondIdx).toBeLessThan(firstIdx);
  });

  test("escapes XML special characters in titles", async () => {
    const video = await createVideo();
    await updateVideo(video.id, { visibility: "public", title: 'Test <script> & "quotes"' });
    await setVideoStatus(video.id, "complete");

    const res = await feeds.request("/feed.xml");
    const body = await res.text();
    expect(body).toContain("&lt;script&gt;");
    expect(body).toContain("&amp;");
    expect(body).toContain("&quot;quotes&quot;");
    expect(body).not.toContain("<script>");
  });
});

describe("GET /rss", () => {
  test("redirects to /feed.xml with 301", async () => {
    const res = await feeds.request("/rss", { redirect: "manual" });
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/feed.xml");
  });
});
