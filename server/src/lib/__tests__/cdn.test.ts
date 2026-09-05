import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { purgeTag, purgeVideo } from "../cdn";

// These tests pin the purge PATH LISTS, which have bitten before: the
// `/${slug}/*` wildcard does not match the bare `/${slug}` page (the URL
// people actually share) nor the dotted variants, and a purge list that
// silently misses one leaves edited metadata stale at the CDN until natural
// expiry. Fire-and-forget fetch is captured via a fetch stub.

const originalFetch = globalThis.fetch;
const originalKey = process.env.BUNNY_CDN_API_KEY;

let purged: string[];

beforeEach(() => {
  purged = [];
  process.env.BUNNY_CDN_API_KEY = "test-key";
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    purged.push(decodeURIComponent(url.searchParams.get("url") ?? ""));
    return Promise.resolve(new Response("ok"));
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.BUNNY_CDN_API_KEY;
  else process.env.BUNNY_CDN_API_KEY = originalKey;
});

// purgeUrl is fire-and-forget; give the queued promises a tick to run.
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("purgeVideo", () => {
  test("purges the bare page, the wildcard, the dotted variants, and the feeds", async () => {
    purgeVideo("my-video");
    await settle();

    const paths = purged.map((u) => new URL(u).pathname);
    // The share URL itself — the wildcard below does NOT cover it.
    expect(paths).toContain("/my-video");
    expect(paths).toContain("/my-video/*");
    expect(paths).toContain("/my-video.json");
    expect(paths).toContain("/my-video.md");
    expect(paths).toContain("/my-video.mp4");
    // Global feeds, because listings embed titles/thumbnails.
    expect(paths).toContain("/feed.xml");
    expect(paths).toContain("/sitemap.xml");
  });
});

describe("purgeTag", () => {
  test("purges the bare tag page, both feeds, and the sitemap", async () => {
    purgeTag("tutorials");
    await settle();

    const paths = purged.map((u) => new URL(u).pathname);
    expect(paths).toContain("/tutorials");
    expect(paths).toContain("/tutorials/feed.xml");
    expect(paths).toContain("/tutorials/feed.json");
    expect(paths).toContain("/sitemap.xml");
  });
});

describe("without an API key", () => {
  test("purging is a silent no-op", async () => {
    delete process.env.BUNNY_CDN_API_KEY;
    purgeVideo("my-video");
    await settle();
    expect(purged).toEqual([]);
  });
});
