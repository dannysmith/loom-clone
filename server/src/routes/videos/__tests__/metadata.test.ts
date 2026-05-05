import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { mkdir } from "fs/promises";
import { join } from "path";
import { getDb } from "../../../db/client";
import { videos as videosTable } from "../../../db/schema";
import {
  createVideo,
  DATA_DIR,
  trashVideo,
  updateSlug,
  updateVideo,
  upsertTranscript,
  type Video,
} from "../../../lib/store";
import { setupTestEnv, type TestEnv, teardownTestEnv } from "../../../test-utils";
import videos from "../index";

async function writeDerivative(video: Video, filename: string): Promise<void> {
  const dir = join(DATA_DIR, video.id, "derivatives");
  await mkdir(dir, { recursive: true });
  await Bun.write(join(dir, filename), "stub");
}

async function setMeta(
  videoId: string,
  patch: { width?: number; height?: number; durationSeconds?: number; lastEditedAt?: string },
): Promise<void> {
  const set: Record<string, unknown> = { ...patch };
  if (patch.width && patch.height) {
    set.aspectRatio = Math.round((patch.width / patch.height) * 10000) / 10000;
  }
  await getDb().update(videosTable).set(set).where(eq(videosTable.id, videoId));
}

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

  test("returns JSON with video data, absolute URLs, and enriched fields", async () => {
    const video = await createVideo();
    await updateVideo(video.id, { title: "My Video" });
    const res = await videos.request(`/${video.slug}.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json();
    expect(body.id).toBe(video.id);
    expect(body.slug).toBe(video.slug);
    expect(body.title).toBe("My Video");
    expect(body.status).toBe("recording");
    expect(body.visibility).toBe("unlisted");
    expect(body.createdAt).toBeTruthy();
    expect(body.url).toMatch(/^https?:\/\//);
    // URLs should all be absolute
    expect(body.urls.page).toMatch(/^https?:\/\//);
    expect(body.urls.raw).toContain("/raw/source.mp4");
    expect(body.urls.embed).toContain("/embed");
    expect(body.urls.json).toContain(".json");
    expect(body.urls.md).toContain(".md");
    expect(body.urls.mp4).toContain(".mp4");
  });

  test("includes width/height/aspectRatio when set on the video", async () => {
    const video = await createVideo();
    await setMeta(video.id, { width: 1920, height: 1080, durationSeconds: 120 });
    const res = await videos.request(`/${video.slug}.json`);
    const body = await res.json();
    expect(body.width).toBe(1920);
    expect(body.height).toBe(1080);
    expect(body.aspectRatio).toBeCloseTo(1.7778, 3);
  });

  test("sources lists active raw + downscales, highest first (unedited 1080p)", async () => {
    const video = await createVideo();
    await setMeta(video.id, { width: 1920, height: 1080, durationSeconds: 120 });
    await writeDerivative(video, "source.mp4");
    await writeDerivative(video, "720p.mp4");
    const res = await videos.request(`/${video.slug}.json`);
    const body = await res.json();
    expect(body.sources).toHaveLength(2);
    expect(body.sources[0]).toEqual({
      height: 1080,
      width: 1920,
      type: "video/mp4",
      url: expect.stringMatching(/\/raw\/source\.mp4$/),
    });
    expect(body.sources[1]).toEqual({
      height: 720,
      width: 1280,
      type: "video/mp4",
      url: expect.stringMatching(/\/raw\/720p\.mp4$/),
    });
    // URLs absolute
    expect(body.sources[0].url).toMatch(/^https?:\/\//);
  });

  test("sources points active raw at NNNNp.mp4 for edited videos", async () => {
    const video = await createVideo();
    await setMeta(video.id, {
      width: 1920,
      height: 1080,
      durationSeconds: 120,
      lastEditedAt: new Date().toISOString(),
    });
    await writeDerivative(video, "1080p.mp4");
    await writeDerivative(video, "720p.mp4");
    const res = await videos.request(`/${video.slug}.json`);
    const body = await res.json();
    expect(body.sources).toHaveLength(2);
    expect(body.sources[0].url).toMatch(/\/raw\/1080p\.mp4$/);
    expect(body.sources[1].url).toMatch(/\/raw\/720p\.mp4$/);
  });

  test("sources is empty when no derivatives exist on disk", async () => {
    const video = await createVideo();
    await setMeta(video.id, { width: 1920, height: 1080, durationSeconds: 120 });
    const res = await videos.request(`/${video.slug}.json`);
    const body = await res.json();
    expect(body.sources).toEqual([]);
  });

  test("urls.captions is the absolute VTT URL when a transcript exists", async () => {
    const video = await createVideo();
    await upsertTranscript(video.id, "vtt", "hello world");
    const res = await videos.request(`/${video.slug}.json`);
    const body = await res.json();
    expect(body.urls.captions).toMatch(/^https?:\/\//);
    expect(body.urls.captions).toContain(`/${video.slug}/captions.vtt`);
    expect(body.transcript).toBe("hello world");
  });

  test("urls.captions is null when there is no transcript", async () => {
    const video = await createVideo();
    const res = await videos.request(`/${video.slug}.json`);
    const body = await res.json();
    expect(body.urls.captions).toBeNull();
    expect(body.transcript).toBeNull();
  });

  test("urls.storyboard and storyboardImage are absolute URLs when duration ≥ 60s", async () => {
    const video = await createVideo();
    await setMeta(video.id, { width: 1920, height: 1080, durationSeconds: 120 });
    const res = await videos.request(`/${video.slug}.json`);
    const body = await res.json();
    expect(body.urls.storyboard).toMatch(/^https?:\/\//);
    expect(body.urls.storyboard).toContain(`/${video.slug}/storyboard.vtt`);
    expect(body.urls.storyboardImage).toMatch(/^https?:\/\//);
    expect(body.urls.storyboardImage).toContain(`/${video.slug}/storyboard.jpg`);
  });

  test("urls.storyboard and storyboardImage are null for videos shorter than 60s", async () => {
    const video = await createVideo();
    await setMeta(video.id, { width: 1920, height: 1080, durationSeconds: 30 });
    const res = await videos.request(`/${video.slug}.json`);
    const body = await res.json();
    expect(body.urls.storyboard).toBeNull();
    expect(body.urls.storyboardImage).toBeNull();
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

  test("returns Markdown with heading, watch link, and URL list", async () => {
    const video = await createVideo();
    await updateVideo(video.id, { title: "Tutorial", description: "Learn things." });
    const res = await videos.request(`/${video.slug}.md`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    const md = await res.text();
    expect(md).toContain("# Tutorial");
    expect(md).toContain("Learn things.");
    expect(md).toContain("[Watch]");
    expect(md).toContain("## Links");
    expect(md).toContain("[Download MP4]");
    expect(md).toContain("[Embed]");
    expect(md).toContain("[JSON metadata]");
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
