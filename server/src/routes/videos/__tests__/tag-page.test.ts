import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { completeVideo, createVideo, updateVideo } from "../../../lib/store";
import { addTagToVideo, createTag, updateTag } from "../../../lib/tags";
import { setupTestEnv, type TestEnv, teardownTestEnv } from "../../../test-utils";
import videos from "../index";

let env: TestEnv;

beforeEach(async () => {
  env = await setupTestEnv();
});

afterEach(async () => {
  await teardownTestEnv(env);
});

async function makePublicTag(slug: string, name = "demo") {
  const tag = await createTag(name);
  return updateTag(tag.id, { visibility: "public", slug });
}

async function makePublishedVideo(visibility: "public" | "unlisted" | "private" = "public") {
  const v = await createVideo();
  await updateVideo(v.id, { visibility });
  await completeVideo(v.id);
  return v;
}

describe("GET /:slug — tag fallback after no video matches", () => {
  test("404 when neither video nor tag matches", async () => {
    const res = await videos.request("/no-such-slug");
    expect(res.status).toBe(404);
  });

  test("renders the tag page when the slug belongs to a public tag", async () => {
    const tag = await makePublicTag("tutorials", "Tutorials");
    const v = await makePublishedVideo("public");
    await updateVideo(v.id, { title: "Hello World" });
    await addTagToVideo(v.id, tag.id);

    const res = await videos.request("/tutorials");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Tutorials");
    expect(html).toContain("Hello World");
    expect(html).toContain(`href="/${v.slug}"`);
  });

  test("private tag is not reachable (404)", async () => {
    const tag = await createTag("internal");
    // Cannot flip to private with no slug; private is the default already.
    expect(tag.visibility).toBe("private");
    const res = await videos.request("/internal");
    expect(res.status).toBe(404);
  });

  test("unlisted tag renders with noindex", async () => {
    const tag = await createTag("hidden");
    await updateTag(tag.id, { visibility: "unlisted", slug: "hidden" });
    const res = await videos.request("/hidden");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    const html = await res.text();
    expect(html).toContain('name="robots" content="noindex"');
  });

  test("public tag has no noindex", async () => {
    await makePublicTag("public-tag");
    const res = await videos.request("/public-tag");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-robots-tag")).toBeNull();
  });

  test("excludes private videos from the grid", async () => {
    const tag = await makePublicTag("mix");
    const pub = await makePublishedVideo("public");
    const priv = await makePublishedVideo("private");
    await updateVideo(pub.id, { title: "ShouldShow" });
    await updateVideo(priv.id, { title: "ShouldHide" });
    await addTagToVideo(pub.id, tag.id);
    await addTagToVideo(priv.id, tag.id);

    const res = await videos.request("/mix");
    const html = await res.text();
    expect(html).toContain("ShouldShow");
    expect(html).not.toContain("ShouldHide");
  });

  test("includes unlisted videos in the grid", async () => {
    const tag = await makePublicTag("incl-unlisted");
    const unl = await makePublishedVideo("unlisted");
    await updateVideo(unl.id, { title: "UnlistedShown" });
    await addTagToVideo(unl.id, tag.id);

    const res = await videos.request("/incl-unlisted");
    const html = await res.text();
    expect(html).toContain("UnlistedShown");
  });

  test("301-redirects an old tag slug to the new slug", async () => {
    const tag = await createTag("demo");
    await updateTag(tag.id, { visibility: "public", slug: "old" });
    await updateTag(tag.id, { slug: "new" });

    const res = await videos.request("/old", { redirect: "manual" });
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/new");
  });

  test("Cache-Control: public for public tag, private for unlisted", async () => {
    await makePublicTag("public-cache");
    const r1 = await videos.request("/public-cache");
    expect(r1.headers.get("cache-control")).toBe("public, max-age=60, stale-while-revalidate=300");

    const t = await createTag("unlisted-cache");
    await updateTag(t.id, { visibility: "unlisted", slug: "u-cache" });
    const r2 = await videos.request("/u-cache");
    expect(r2.headers.get("cache-control")).toBe("private, max-age=60, stale-while-revalidate=300");
  });
});

describe("GET /:slug/feed.xml — per-tag RSS feed", () => {
  test("returns RSS XML for a public tag", async () => {
    const tag = await makePublicTag("rss-tag", "Demo Tag");
    const v = await makePublishedVideo("public");
    await updateVideo(v.id, { title: "Item One" });
    await addTagToVideo(v.id, tag.id);

    const res = await videos.request("/rss-tag/feed.xml");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/rss+xml");
    const xml = await res.text();
    expect(xml).toContain("<rss");
    expect(xml).toContain("Demo Tag");
    expect(xml).toContain("Item One");
  });

  test("404 for unknown tag slug", async () => {
    const res = await videos.request("/no-such-tag/feed.xml");
    expect(res.status).toBe(404);
  });

  test("301 redirect for old tag slug", async () => {
    const tag = await createTag("demo");
    await updateTag(tag.id, { visibility: "public", slug: "old-feed" });
    await updateTag(tag.id, { slug: "new-feed" });

    const res = await videos.request("/old-feed/feed.xml", { redirect: "manual" });
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/new-feed/feed.xml");
  });
});

describe("GET /:slug/feed.json — per-tag JSON feed", () => {
  test("returns JSON Feed 1.1 for a public tag", async () => {
    const tag = await makePublicTag("json-tag", "JSON Tag");
    const v = await makePublishedVideo("public");
    await updateVideo(v.id, { title: "Item One" });
    await addTagToVideo(v.id, tag.id);

    const res = await videos.request("/json-tag/feed.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/feed+json");
    const body = (await res.json()) as {
      version: string;
      title: string;
      items: Array<{ title: string }>;
    };
    expect(body.version).toBe("https://jsonfeed.org/version/1.1");
    expect(body.title).toContain("JSON Tag");
    expect(body.items.map((i) => i.title)).toContain("Item One");
  });

  test("includes unlisted videos but never private", async () => {
    const tag = await makePublicTag("scope-tag");
    const pub = await makePublishedVideo("public");
    const unl = await makePublishedVideo("unlisted");
    const priv = await makePublishedVideo("private");
    await updateVideo(pub.id, { title: "PubItem" });
    await updateVideo(unl.id, { title: "UnlItem" });
    await updateVideo(priv.id, { title: "PrivItem" });
    await addTagToVideo(pub.id, tag.id);
    await addTagToVideo(unl.id, tag.id);
    await addTagToVideo(priv.id, tag.id);

    const body = (await (await videos.request("/scope-tag/feed.json")).json()) as {
      items: Array<{ title: string }>;
    };
    const titles = body.items.map((i) => i.title);
    expect(titles).toContain("PubItem");
    expect(titles).toContain("UnlItem");
    expect(titles).not.toContain("PrivItem");
  });
});
