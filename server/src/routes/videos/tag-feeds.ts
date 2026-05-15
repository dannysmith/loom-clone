import { Hono } from "hono";
import {
  buildJsonFeedItem,
  escapeXml,
  loadTranscriptMap,
  renderRssItem,
} from "../../lib/feed-items";
import { siteConfig } from "../../lib/site-config";
import { getVideosForTag, resolveTagSlug } from "../../lib/tags";
import { absoluteUrl, getPublicBaseUrl } from "../../lib/url";

// Per-tag RSS / JSON Feed routes. Mounted in the videos sub-router so they
// share its CORS middleware. The :slug param is dispatched as a tag (videos
// don't expose /feed.{xml,json} sub-paths).
const tagFeeds = new Hono();

async function loadTagFeed(slug: string) {
  const result = await resolveTagSlug(slug);
  if (!result) return null;
  return result;
}

tagFeeds.get("/:slug/feed.xml", async (c) => {
  const slug = c.req.param("slug");
  const result = await loadTagFeed(slug);
  if (!result) return c.text("Not found", 404);
  if (result.redirected) {
    return c.redirect(`/${result.tag.slug}/feed.xml`, 301);
  }

  const { tag } = result;
  if (!tag.slug) return c.text("Not found", 404);

  const videos = await getVideosForTag(tag.id);
  const items = videos.map(renderRssItem);
  const feedUrl = absoluteUrl(`/${tag.slug}/feed.xml`);
  const pageUrl = absoluteUrl(`/${tag.slug}`);
  const channelTitle = `${tag.name} — ${siteConfig.name}`;
  const channelDescription = tag.description ?? siteConfig.tagline;

  if (tag.visibility !== "public") c.header("X-Robots-Tag", "noindex");
  const cacheScope = tag.visibility === "public" ? "public" : "private";
  c.header("Cache-Control", `${cacheScope}, max-age=60, stale-while-revalidate=300`);

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0"',
    '     xmlns:media="http://search.yahoo.com/mrss/"',
    '     xmlns:atom="http://www.w3.org/2005/Atom">',
    "  <channel>",
    `    <title>${escapeXml(channelTitle)}</title>`,
    `    <link>${escapeXml(pageUrl)}</link>`,
    `    <description>${escapeXml(channelDescription)}</description>`,
    "    <language>en</language>",
    `    <atom:link href="${escapeXml(feedUrl)}" rel="self" type="application/rss+xml" />`,
    ...items,
    "  </channel>",
    "</rss>",
    "",
  ].join("\n");

  return c.body(xml, 200, { "content-type": "application/rss+xml; charset=utf-8" });
});

tagFeeds.get("/:slug/feed.json", async (c) => {
  const slug = c.req.param("slug");
  const result = await loadTagFeed(slug);
  if (!result) return c.text("Not found", 404);
  if (result.redirected) {
    return c.redirect(`/${result.tag.slug}/feed.json`, 301);
  }

  const { tag } = result;
  if (!tag.slug) return c.text("Not found", 404);

  const videos = await getVideosForTag(tag.id);
  const transcriptMap = await loadTranscriptMap(videos.map((v) => v.id));
  const items = videos.map((v) => buildJsonFeedItem(v, transcriptMap));

  if (tag.visibility !== "public") c.header("X-Robots-Tag", "noindex");
  const cacheScope = tag.visibility === "public" ? "public" : "private";
  c.header("Cache-Control", `${cacheScope}, max-age=60, stale-while-revalidate=300`);

  const base = getPublicBaseUrl();
  const feed = {
    info_for_llms: `This is a JSON Feed (v1.1) of all public/unlisted videos tagged "${tag.name}" at ${base}. For the full site feed, see ${absoluteUrl("/feed.json")}.`,
    version: "https://jsonfeed.org/version/1.1",
    title: `${tag.name} — ${siteConfig.name}`,
    home_page_url: absoluteUrl(`/${tag.slug}`),
    feed_url: absoluteUrl(`/${tag.slug}/feed.json`),
    description: tag.description ?? siteConfig.tagline,
    language: "en",
    authors: [{ name: siteConfig.authorName, url: siteConfig.authorUrl }],
    items,
  };

  return c.json(feed, 200, { "content-type": "application/feed+json; charset=utf-8" });
});

export default tagFeeds;
