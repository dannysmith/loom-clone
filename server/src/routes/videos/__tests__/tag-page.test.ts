import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "fs/promises";
import { join } from "path";
import { DATA_DIR } from "../../../lib/paths";
import { completeVideo, createVideo, updateVideo } from "../../../lib/store";
import { addTagToVideo, createTag, updateTag } from "../../../lib/tags";
import { absoluteUrl } from "../../../lib/url";
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

// Gives a video a poster on disk — `ready` alone doesn't imply one.
async function writePoster(videoId: string) {
  await mkdir(join(DATA_DIR, videoId, "derivatives"), { recursive: true });
  await Bun.write(join(DATA_DIR, videoId, "derivatives", "thumbnail.jpg"), "stub");
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

  test("falls back to the generic OG image when there's no usable poster", async () => {
    const tag = await makePublicTag("og-tag", "OG Tag");
    // A video in the grid, but its thumbnail step hasn't produced a poster yet.
    const v = await makePublishedVideo("public");
    await addTagToVideo(v.id, tag.id);
    const res = await videos.request("/og-tag");
    const html = await res.text();
    expect(html).toContain('property="og:image" content="');
    expect(html).toContain("/static/images/og-default.png");
    expect(html).toContain('name="twitter:card" content="summary_large_image"');
    expect(html).toContain('name="twitter:image"');
    // And the JSON-LD omits thumbnailUrl rather than publishing a 404.
    expect(html).not.toContain("thumbnailUrl");
  });

  test("uses the first video's poster as the OG image when it exists", async () => {
    const tag = await makePublicTag("postered", "Postered");
    const v = await makePublishedVideo("public");
    await addTagToVideo(v.id, tag.id);
    await writePoster(v.id);

    const res = await videos.request("/postered");
    const html = await res.text();
    expect(html).toContain(`property="og:image" content="${absoluteUrl(`/${v.slug}/poster.jpg`)}"`);
    expect(html).not.toContain("og-default.png");
  });

  // A title containing "</script>" must not be able to close the JSON-LD block
  // and inject markup — see jsonLdScript() in lib/json-ld.ts.
  test("escapes markup in JSON-LD so a hostile title can't break out", async () => {
    const tag = await makePublicTag("escaped", "Escaped");
    const v = await makePublishedVideo("public");
    await updateVideo(v.id, { title: "</script><img src=x onerror=alert(1)>" });
    await addTagToVideo(v.id, tag.id);

    const res = await videos.request("/escaped");
    const html = await res.text();
    expect(html).not.toContain("</script><img");
    // Escaping "<" alone is enough — "</script" can't form without it.
    expect(html).toContain("\\u003c/script>\\u003cimg");
    // Still valid JSON, and the title survives intact once parsed.
    const match = /<script type="application\/ld\+json">(.+?)<\/script>/s.exec(html);
    const jsonLd = JSON.parse(match?.[1] ?? "{}");
    expect(jsonLd.mainEntity.itemListElement[0].item.name).toBe(
      "</script><img src=x onerror=alert(1)>",
    );
  });

  test("emits CollectionPage JSON-LD listing the tagged videos", async () => {
    const tag = await makePublicTag("structured", "Structured");
    const v = await makePublishedVideo("public");
    await updateVideo(v.id, { title: "Indexed Video" });
    await addTagToVideo(v.id, tag.id);
    await writePoster(v.id);

    const res = await videos.request("/structured");
    const html = await res.text();
    const match = /<script type="application\/ld\+json">(.+?)<\/script>/s.exec(html);
    expect(match).not.toBeNull();
    const jsonLd = JSON.parse(match?.[1] ?? "{}");
    expect(jsonLd["@type"]).toBe("CollectionPage");
    expect(jsonLd.name).toBe("Structured");
    expect(jsonLd.mainEntity.numberOfItems).toBe(1);
    const [first] = jsonLd.mainEntity.itemListElement;
    expect(first.position).toBe(1);
    expect(first.item["@type"]).toBe("VideoObject");
    expect(first.item.name).toBe("Indexed Video");
    expect(first.item.url).toBe(absoluteUrl(`/${v.slug}`));
    expect(first.item.thumbnailUrl).toBe(absoluteUrl(`/${v.slug}/poster.jpg`));
  });

  test("exposes agent affordances: Link header, markdown alternate, directive, Vary", async () => {
    await makePublicTag("agenty");
    const res = await videos.request("/agenty");
    expect(res.headers.get("link")).toContain('</llms.txt>; rel="describedby"');
    expect(res.headers.get("vary")).toBe("Accept");
    const html = await res.text();
    expect(html).toContain('rel="alternate" type="text/markdown" href="/agenty.md"');
    expect(html).toContain('class="agent-directive"');
    expect(html).toContain("/llms.txt");
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

describe("GET /:slug.md — tag markdown", () => {
  test("returns markdown for a public tag with its videos", async () => {
    const tag = await makePublicTag("md-tag", "Markdown Tag");
    const v = await makePublishedVideo("public");
    await updateVideo(v.id, { title: "Listed Vid" });
    await addTagToVideo(v.id, tag.id);

    const res = await videos.request("/md-tag.md");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=300, stale-while-revalidate=3600",
    );
    const md = await res.text();
    expect(md).toStartWith("> ");
    expect(md).toContain("[llms.txt](/llms.txt)");
    expect(md).toContain("# Markdown Tag");
    expect(md).toContain("## Videos");
    expect(md).toContain("[Listed Vid]");
  });

  test("404 when neither a video nor a tag matches", async () => {
    const res = await videos.request("/nope.md");
    expect(res.status).toBe(404);
  });

  test("301-redirects an old tag slug to the canonical .md URL", async () => {
    const tag = await createTag("demo");
    await updateTag(tag.id, { visibility: "public", slug: "md-old" });
    await updateTag(tag.id, { slug: "md-new" });

    const res = await videos.request("/md-old.md", { redirect: "manual" });
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/md-new.md");
  });

  test("content negotiation: Accept: text/markdown on a tag slug returns markdown", async () => {
    await makePublicTag("neg-tag", "Negotiated Tag");
    const res = await videos.request("/neg-tag", {
      headers: { Accept: "text/markdown" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const md = await res.text();
    expect(md).toContain("# Negotiated Tag");
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
