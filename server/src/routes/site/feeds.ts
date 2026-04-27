import { and, desc, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { getDb } from "../../db/client";
import { videos } from "../../db/schema";
import { formatDuration } from "../../lib/format";
import { siteConfig } from "../../lib/site-config";
import { absoluteUrl } from "../../lib/url";

// Public feeds: RSS 2.0 + Media RSS, with /rss redirect. No auth.
const feeds = new Hono();

// Redirect /rss → /feed.xml (permanent — the canonical path won't change).
feeds.get("/rss", (c) => c.redirect("/feed.xml", 301));

feeds.get("/feed.xml", async (c) => {
  const rows = await getDb()
    .select()
    .from(videos)
    .where(
      and(eq(videos.visibility, "public"), eq(videos.status, "complete"), isNull(videos.trashedAt)),
    )
    .orderBy(desc(videos.createdAt));

  const items = rows.map((v) => {
    const pageUrl = absoluteUrl(`/${v.slug}`);
    const mp4Url = absoluteUrl(`/${v.slug}/raw/source.mp4`);
    const posterUrl = absoluteUrl(`/${v.slug}/poster.jpg`);
    const title = v.title ?? v.slug;
    const durationSec = v.durationSeconds ? Math.round(v.durationSeconds) : undefined;
    const pubDate = new Date(v.completedAt ?? v.createdAt).toUTCString();
    const duration = formatDuration(v.durationSeconds);
    const descParts = [duration, v.description].filter(Boolean);
    const descText = descParts.length > 0 ? descParts.join(" — ") : undefined;

    return [
      "    <item>",
      `      <title>${escapeXml(title)}</title>`,
      `      <link>${escapeXml(pageUrl)}</link>`,
      `      <guid isPermaLink="true">${escapeXml(pageUrl)}</guid>`,
      `      <pubDate>${pubDate}</pubDate>`,
      descText ? `      <description>${escapeXml(descText)}</description>` : null,
      v.fileBytes != null
        ? `      <enclosure url="${escapeXml(mp4Url)}" length="${v.fileBytes}" type="video/mp4" />`
        : `      <enclosure url="${escapeXml(mp4Url)}" length="0" type="video/mp4" />`,
      `      <media:content url="${escapeXml(mp4Url)}" type="video/mp4" medium="video"${durationSec != null ? ` duration="${durationSec}"` : ""}${v.width ? ` width="${v.width}"` : ""}${v.height ? ` height="${v.height}"` : ""} />`,
      `      <media:thumbnail url="${escapeXml(posterUrl)}" />`,
      `      <media:title>${escapeXml(title)}</media:title>`,
      descText ? `      <media:description>${escapeXml(descText)}</media:description>` : null,
      "    </item>",
    ]
      .filter(Boolean)
      .join("\n");
  });

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

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export default feeds;
