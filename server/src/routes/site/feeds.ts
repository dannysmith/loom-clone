import { and, desc, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { getDb } from "../../db/client";
import { type Video, videos } from "../../db/schema";
import {
  buildJsonFeedItem,
  escapeXml,
  loadTranscriptMap,
  renderRssItem,
} from "../../lib/feed-items";
import { formatDuration } from "../../lib/format";
import { siteConfig } from "../../lib/site-config";
import { absoluteUrl, getPublicBaseUrl } from "../../lib/url";

// Public feeds: RSS, JSON Feed, llms.txt. No auth.
const feeds = new Hono();

// Shared query: public, complete, non-trashed videos, newest first.
async function listPublicVideos(): Promise<Video[]> {
  return getDb()
    .select()
    .from(videos)
    .where(
      and(eq(videos.visibility, "public"), eq(videos.status, "complete"), isNull(videos.trashedAt)),
    )
    .orderBy(desc(videos.createdAt));
}

// ---------------------------------------------------------------------------
// RSS 2.0 + Media RSS
// ---------------------------------------------------------------------------

feeds.get("/rss", (c) => c.redirect("/feed.xml", 301));

feeds.get("/feed.xml", async (c) => {
  const rows = await listPublicVideos();
  const items = rows.map(renderRssItem);

  const feedUrl = absoluteUrl("/feed.xml");
  const siteUrl = absoluteUrl("/");

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0"',
    '     xmlns:media="http://search.yahoo.com/mrss/"',
    '     xmlns:atom="http://www.w3.org/2005/Atom">',
    "  <channel>",
    `    <title>${escapeXml(siteConfig.name)}</title>`,
    `    <link>${escapeXml(siteUrl)}</link>`,
    `    <description>${escapeXml(siteConfig.tagline)}</description>`,
    "    <language>en</language>",
    `    <atom:link href="${escapeXml(feedUrl)}" rel="self" type="application/rss+xml" />`,
    ...items,
    "  </channel>",
    "</rss>",
    "",
  ].join("\n");

  return c.body(xml, 200, { "content-type": "application/rss+xml; charset=utf-8" });
});

// ---------------------------------------------------------------------------
// JSON Feed 1.1
// ---------------------------------------------------------------------------

feeds.get("/feed.json", async (c) => {
  const rows = await listPublicVideos();
  const transcriptMap = await loadTranscriptMap(rows.map((v) => v.id));
  const base = getPublicBaseUrl();

  const items = rows.map((v) => buildJsonFeedItem(v, transcriptMap));

  const feed = {
    info_for_llms: `This is a JSON Feed (v1.1) of all public videos hosted at ${base}. Each item includes video metadata, URLs, and a truncated transcript excerpt. For a full machine-readable index of this site, see ${absoluteUrl("/llms.txt")}. For full metadata on any individual video, append .json to its URL (e.g. ${base}/<slug>.json).`,
    version: "https://jsonfeed.org/version/1.1",
    title: siteConfig.name,
    home_page_url: base,
    feed_url: absoluteUrl("/feed.json"),
    description: siteConfig.tagline,
    language: "en",
    authors: [{ name: siteConfig.authorName, url: siteConfig.authorUrl }],
    items,
  };

  return c.json(feed, 200, { "content-type": "application/feed+json; charset=utf-8" });
});

// ---------------------------------------------------------------------------
// llms.txt
// ---------------------------------------------------------------------------

feeds.get("/llms.txt", async (c) => {
  const rows = await listPublicVideos();
  const base = getPublicBaseUrl();

  const sections: string[] = [];

  // Header
  sections.push(`# ${siteConfig.name}\n\n> ${siteConfig.tagline}`);

  // Endpoint documentation — placed before the video list so it's always
  // visible even with `curl | head -100`.
  sections.push(
    [
      "## How to Use This Site",
      "",
      `Individual videos are available at \`${base}/<slug>\`. Each video also supports:`,
      "",
      "- `/<slug>/embed` — embeddable player (for iframes)",
      "- `/<slug>.json` — full metadata as JSON (includes transcript)",
      "- `/<slug>.md` — metadata as markdown",
      "- `/<slug>.mp4` — direct video download",
      "- `/<slug>/poster.jpg` — thumbnail image",
      "",
      `For all public videos as JSON: ${absoluteUrl("/feed.json")}`,
    ].join("\n"),
  );

  // Video list
  if (rows.length > 0) {
    const videoLines = rows.map((v) => {
      const title = v.title ?? v.slug;
      const pageUrl = absoluteUrl(`/${v.slug}`);
      const duration = formatDuration(v.durationSeconds);
      const date = v.completedAt ?? v.createdAt;
      const isoDate = date.slice(0, 10); // YYYY-MM-DD

      const parts = [duration, isoDate, v.description].filter(Boolean);
      const suffix = parts.length > 0 ? ` — ${parts.join(" · ")}` : "";
      return `- [${title}](${pageUrl})${suffix}`;
    });

    sections.push(["## Public Videos", "", ...videoLines].join("\n"));
  }

  // Links
  sections.push(
    [
      "## Links",
      "",
      `- [RSS Feed](${absoluteUrl("/feed.xml")}) — RSS 2.0 + Media RSS feed of all public videos`,
      `- [JSON Feed](${absoluteUrl("/feed.json")}) — JSON Feed 1.1 of all public videos`,
      `- [Sitemap](${absoluteUrl("/sitemap.xml")}) — XML sitemap`,
      `- [${siteConfig.authorName}](${siteConfig.authorUrl}) — Author's website`,
    ].join("\n"),
  );

  return c.text(`${sections.join("\n\n")}\n`, 200, {
    "content-type": "text/plain; charset=utf-8",
  });
});

export default feeds;
