import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "fs/promises";
import { join } from "path";
import { createVideo, DATA_DIR, updateSlug, updateVideo, type Video } from "../../../lib/store";
import { setupTestEnv, type TestEnv, teardownTestEnv } from "../../../test-utils";
import videos from "../index";

let env: TestEnv;

beforeEach(async () => {
  env = await setupTestEnv();
});

afterEach(async () => {
  await teardownTestEnv(env);
});

async function writeDerivative(video: Video, filename: string): Promise<void> {
  const dir = join(DATA_DIR, video.id, "derivatives");
  await mkdir(dir, { recursive: true });
  await Bun.write(join(dir, filename), "stub");
}

describe("GET /v/:slug (back-compat redirect)", () => {
  test("301 redirects to /:slug", async () => {
    const video = await createVideo();
    const res = await videos.request(`/v/${video.slug}`, { redirect: "manual" });
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe(`/${video.slug}`);
  });

  test("redirects unknown slugs too — resolution happens at the target", async () => {
    const res = await videos.request("/v/nonexist", { redirect: "manual" });
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/nonexist");
  });

  test("redirects sub-paths: /v/:slug/embed → /:slug/embed", async () => {
    const video = await createVideo();
    const res = await videos.request(`/v/${video.slug}/embed`, { redirect: "manual" });
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

  test("media-player has preload=auto and load=eager (forward-buffering hints)", async () => {
    const video = await createVideo();
    const res = await videos.request(`/${video.slug}`);
    const html = await res.text();
    expect(html).toContain('preload="auto"');
    expect(html).toContain('load="eager"');
  });

  test("head includes modulepreload for the Vidstack JS module", async () => {
    const video = await createVideo();
    const res = await videos.request(`/${video.slug}`);
    const html = await res.text();
    expect(html).toContain('rel="modulepreload" href="https://cdn.vidstack.io/player"');
  });

  test("emits rel=preload as=video for the default <source> when MP4 derivative exists", async () => {
    const video = await createVideo();
    await writeDerivative(video, "source.mp4");
    const res = await videos.request(`/${video.slug}`);
    const html = await res.text();
    expect(html).toContain(
      `rel="preload" as="video" fetchpriority="high" href="/${video.slug}/raw/source.mp4"`,
    );
  });

  test("no rel=preload as=video during HLS healing window (no MP4 derivative yet)", async () => {
    const video = await createVideo();
    const res = await videos.request(`/${video.slug}`);
    const html = await res.text();
    expect(html).not.toContain('as="video"');
  });

  test("Cache-Control: public for public videos, private for non-public", async () => {
    const unlisted = await createVideo();
    const r1 = await videos.request(`/${unlisted.slug}`);
    expect(r1.headers.get("cache-control")).toBe("private, max-age=60, stale-while-revalidate=300");

    const pub = await createVideo();
    await updateVideo(pub.id, { visibility: "public" });
    const r2 = await videos.request(`/${pub.slug}`);
    expect(r2.headers.get("cache-control")).toBe("public, max-age=60, stale-while-revalidate=300");
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

  test("includes OG tags and canonical link", async () => {
    const video = await createVideo();
    await updateVideo(video.id, { title: "Demo" });
    const res = await videos.request(`/${video.slug}`);
    const html = await res.text();
    expect(html).toContain('property="og:title"');
    expect(html).toContain('property="og:type" content="video.other"');
    expect(html).toContain('property="og:video"');
    expect(html).toContain('rel="canonical"');
    expect(html).toContain('name="twitter:card" content="player"');
    expect(html).toContain('rel="alternate" type="application/json+oembed"');
  });

  test("unlisted video gets noindex meta and header", async () => {
    const video = await createVideo();
    // Default visibility is "unlisted"
    const res = await videos.request(`/${video.slug}`);
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    const html = await res.text();
    expect(html).toContain('name="robots" content="noindex"');
  });

  test("public video has no noindex", async () => {
    const video = await createVideo();
    await updateVideo(video.id, { visibility: "public" });
    const res = await videos.request(`/${video.slug}`);
    expect(res.headers.get("x-robots-tag")).toBeNull();
    const html = await res.text();
    expect(html).not.toContain("noindex");
  });
});
