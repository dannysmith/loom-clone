import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { mkdir } from "fs/promises";
import { join } from "path";
import { getDb } from "../../../db/client";
import type { ProcessingStepKind } from "../../../db/schema";
import { videos as videosTable } from "../../../db/schema";
import { markStepReady } from "../../../lib/processing/steps-store";
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

// Serving is table-gated (state `ready` + file present), so writing the file
// must be paired with marking the gating step ready.
const STEP_FOR_FILE: Record<string, ProcessingStepKind> = {
  "source.mp4": "source",
  "1080p.mp4": "variant_1080",
  "720p.mp4": "variant_720",
};

async function writeDerivative(video: Video, filename: string): Promise<void> {
  const dir = join(DATA_DIR, video.id, "derivatives");
  await mkdir(dir, { recursive: true });
  await Bun.write(join(dir, filename), "stub");
  const kind = STEP_FOR_FILE[filename];
  if (kind) await markStepReady(video.id, kind);
  // MP4 serving is gated on the full mandatory set (source AND metadata).
  if (filename === "source.mp4") await markStepReady(video.id, "metadata");
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

  // A title containing "</script>" must not be able to close the JSON-LD block
  // and inject markup — see jsonLdScript() in lib/json-ld.ts.
  test("escapes markup in JSON-LD so a hostile title can't break out", async () => {
    const video = await createVideo();
    await updateVideo(video.id, { title: "</script><img src=x onerror=alert(1)>" });
    const res = await videos.request(`/${video.slug}`);
    const html = await res.text();
    expect(html).not.toContain("</script><img");
    // Escaping "<" alone is enough — "</script" can't form without it.
    expect(html).toContain("\\u003c/script>\\u003cimg");
    const match = /<script type="application\/ld\+json">(.+?)<\/script>/s.exec(html);
    const jsonLd = JSON.parse(match?.[1] ?? "{}");
    expect(jsonLd.name).toBe("</script><img src=x onerror=alert(1)>");
  });

  test("renders duration and date as machine-readable <time> elements", async () => {
    const video = await createVideo();
    await updateVideo(video.id, { title: "Timed" });
    await getDb()
      .update(videosTable)
      .set({ durationSeconds: 90, completedAt: "2026-04-17T09:30:00.000Z" })
      .where(eq(videosTable.id, video.id));

    const res = await videos.request(`/${video.slug}`);
    const html = await res.text();
    expect(html).toContain('<time class="viewer-meta-item" datetime="PT1M30S">');
    expect(html).toContain('<time class="viewer-meta-item" datetime="2026-04-17T09:30:00.000Z">');
  });

  test("emits rel=preload as=image for the poster when a thumbnail exists", async () => {
    const video = await createVideo();
    await writeDerivative(video, "thumbnail.jpg");
    const res = await videos.request(`/${video.slug}`);
    const html = await res.text();
    expect(html).toContain(
      `rel="preload" as="image" fetchpriority="high" href="/${video.slug}/poster.jpg"`,
    );
  });

  test("no poster preload before the thumbnail has been generated", async () => {
    const video = await createVideo();
    const res = await videos.request(`/${video.slug}`);
    const html = await res.text();
    expect(html).not.toContain('as="image"');
  });

  // as="video" is spec-legal but unimplemented everywhere — Chrome logs it as
  // an unsupported `as` value, so the page must not emit it.
  test("never emits a rel=preload as=video hint", async () => {
    const video = await createVideo();
    await writeDerivative(video, "source.mp4");
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

  test("exposes agent affordances: Link header, markdown alternate, directive, Vary", async () => {
    const video = await createVideo();
    const res = await videos.request(`/${video.slug}`);
    expect(res.headers.get("link")).toContain('</llms.txt>; rel="describedby"');
    expect(res.headers.get("vary")).toBe("Accept");
    const html = await res.text();
    expect(html).toContain(`rel="alternate" type="text/markdown" href="/${video.slug}.md"`);
    expect(html).toContain('class="agent-directive"');
    expect(html).toContain("/llms.txt");
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
