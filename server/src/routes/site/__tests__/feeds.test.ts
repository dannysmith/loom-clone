import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { siteConfig } from "../../../lib/site-config";
import {
  createVideo,
  setVideoStatus,
  trashVideo,
  updateVideo,
  upsertTranscript,
} from "../../../lib/store";
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

// ---------------------------------------------------------------------------
// JSON Feed
// ---------------------------------------------------------------------------

describe("GET /feed.json", () => {
  test("returns valid JSON Feed 1.1 with correct content type", async () => {
    const res = await feeds.request("/feed.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/feed+json");
    const body = await res.json();
    expect(body.version).toBe("https://jsonfeed.org/version/1.1");
    expect(body.title).toBe(siteConfig.name);
    expect(body.items).toBeArray();
  });

  test("includes info_for_llms key", async () => {
    const res = await feeds.request("/feed.json");
    const body = await res.json();
    expect(body.info_for_llms).toBeString();
    expect(body.info_for_llms).toContain("llms.txt");
    expect(body.info_for_llms).toContain(".json");
  });

  test("includes public complete videos with attachments and _urls", async () => {
    const video = await createVideo();
    await updateVideo(video.id, {
      visibility: "public",
      title: "JSON Test",
      description: "A test video",
    });
    await setVideoStatus(video.id, "complete");

    const res = await feeds.request("/feed.json");
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    const item = body.items[0];
    expect(item.title).toBe("JSON Test");
    expect(item.content_text).toBe("A test video");
    expect(item.url).toContain(`/${video.slug}`);
    expect(item.attachments).toHaveLength(1);
    expect(item.attachments[0].mime_type).toBe("video/mp4");
    expect(item._urls).toBeDefined();
    expect(item._urls.embed).toContain("/embed");
    expect(item._urls.json).toContain(".json");
    expect(item._urls.md).toContain(".md");
  });

  test("excludes unlisted and private videos", async () => {
    const unlisted = await createVideo();
    await setVideoStatus(unlisted.id, "complete");

    const priv = await createVideo();
    await updateVideo(priv.id, { visibility: "private" });
    await setVideoStatus(priv.id, "complete");

    const res = await feeds.request("/feed.json");
    const body = await res.json();
    expect(body.items).toHaveLength(0);
  });

  test("includes truncated transcript excerpt", async () => {
    const video = await createVideo();
    await updateVideo(video.id, { visibility: "public", title: "With Transcript" });
    await setVideoStatus(video.id, "complete");

    // Create a transcript with more than 200 words
    const longText = Array.from({ length: 250 }, (_, i) => `word${i}`).join(" ");
    await upsertTranscript(video.id, "srt", longText);

    const res = await feeds.request("/feed.json");
    const body = await res.json();
    const item = body.items[0];
    expect(item._transcript_excerpt).toBeString();
    expect(item._transcript_excerpt).toContain("word0");
    expect(item._transcript_excerpt).toEndWith("…");
    // Should have roughly 200 words, not 250
    const excerptWords = item._transcript_excerpt.split(/\s+/).length;
    expect(excerptWords).toBeLessThanOrEqual(201); // 200 words + possible trailing ellipsis word
  });

  test("omits transcript fields when no transcript exists", async () => {
    const video = await createVideo();
    await updateVideo(video.id, { visibility: "public" });
    await setVideoStatus(video.id, "complete");

    const res = await feeds.request("/feed.json");
    const body = await res.json();
    expect(body.items[0]._transcript_excerpt).toBeUndefined();
  });

  test("uses slug as title when video has no title", async () => {
    const video = await createVideo();
    await updateVideo(video.id, { visibility: "public" });
    await setVideoStatus(video.id, "complete");

    const res = await feeds.request("/feed.json");
    const body = await res.json();
    expect(body.items[0].title).toBe(video.slug);
  });
});

// ---------------------------------------------------------------------------
// llms.txt
// ---------------------------------------------------------------------------

describe("GET /llms.txt", () => {
  test("returns text/plain with site header", async () => {
    const res = await feeds.request("/llms.txt");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const body = await res.text();
    expect(body).toContain(`# ${siteConfig.name}`);
    expect(body).toContain(siteConfig.tagline);
  });

  test("includes How to Use section with endpoint docs", async () => {
    const res = await feeds.request("/llms.txt");
    const body = await res.text();
    expect(body).toContain("## How to Use This Site");
    expect(body).toContain("/<slug>/embed");
    expect(body).toContain("/<slug>.json");
    expect(body).toContain("/<slug>.md");
    expect(body).toContain("/<slug>.mp4");
    expect(body).toContain("/feed.json");
  });

  test("includes Links section with feed URLs", async () => {
    const res = await feeds.request("/llms.txt");
    const body = await res.text();
    expect(body).toContain("## Links");
    expect(body).toContain("/feed.xml");
    expect(body).toContain("/feed.json");
    expect(body).toContain("/sitemap.xml");
    expect(body).toContain(siteConfig.authorUrl);
  });

  test("lists public complete videos", async () => {
    const video = await createVideo();
    await updateVideo(video.id, { visibility: "public", title: "LLM Test Video" });
    await setVideoStatus(video.id, "complete");

    const res = await feeds.request("/llms.txt");
    const body = await res.text();
    expect(body).toContain("## Public Videos");
    expect(body).toContain("LLM Test Video");
    expect(body).toContain(`/${video.slug}`);
  });

  test("includes description when present", async () => {
    const video = await createVideo();
    await updateVideo(video.id, {
      visibility: "public",
      title: "Described",
      description: "A detailed walkthrough",
    });
    await setVideoStatus(video.id, "complete");

    const res = await feeds.request("/llms.txt");
    const body = await res.text();
    expect(body).toContain("A detailed walkthrough");
  });

  test("omits Public Videos section when no public videos exist", async () => {
    const res = await feeds.request("/llms.txt");
    const body = await res.text();
    expect(body).not.toContain("## Public Videos");
  });

  test("excludes unlisted and private videos", async () => {
    const unlisted = await createVideo();
    await setVideoStatus(unlisted.id, "complete");

    const priv = await createVideo();
    await updateVideo(priv.id, { visibility: "private" });
    await setVideoStatus(priv.id, "complete");

    const res = await feeds.request("/llms.txt");
    const body = await res.text();
    expect(body).not.toContain(unlisted.slug);
    expect(body).not.toContain(priv.slug);
  });

  test("uses slug as title when video has no title", async () => {
    const video = await createVideo();
    await updateVideo(video.id, { visibility: "public" });
    await setVideoStatus(video.id, "complete");

    const res = await feeds.request("/llms.txt");
    const body = await res.text();
    expect(body).toContain(`[${video.slug}]`);
  });

  test("does not contain loom-clone", async () => {
    const res = await feeds.request("/llms.txt");
    const body = await res.text();
    expect(body.toLowerCase()).not.toContain("loom-clone");
    expect(body.toLowerCase()).not.toContain("loom clone");
  });
});
