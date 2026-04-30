import { and, desc, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { getDb } from "../../db/client";
import { videos } from "../../db/schema";
import { siteConfig } from "../../lib/site-config";
import { absoluteUrl, activeRawFilename } from "../../lib/url";

// Root + well-known files. Open, no auth.
const wellKnown = new Hono();

// 302 temporary redirect to the author's site. The HTML body is never
// rendered by browsers (they follow the Location header) but IS displayed
// by curl (without -L), wget --max-redirect=0, and AI agents — giving
// them pointers to /llms.txt and the feeds before they follow the redirect.
wellKnown.get("/", (c) => {
  const body = [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "<head>",
    '  <meta charset="utf-8">',
    `  <title>Redirecting to ${siteConfig.authorUrl.replace(/^https?:\/\//, "")}</title>`,
    `  <link rel="alternate" type="application/rss+xml" title="${siteConfig.name}" href="/feed.xml">`,
    `  <link rel="alternate" type="application/feed+json" title="${siteConfig.name}" href="/feed.json">`,
    "</head>",
    "<body>",
    `  <h1>${siteConfig.name}</h1>`,
    `  <p>Redirecting to <a href="${siteConfig.authorUrl}">${siteConfig.authorUrl.replace(/^https?:\/\//, "")}</a>.</p>`,
    "  <hr>",
    "  <p>Looking for videos? Try:</p>",
    "  <ul>",
    `    <li><a href="/llms.txt">/llms.txt</a> — machine-readable site index</li>`,
    `    <li><a href="/feed.xml">/feed.xml</a> — RSS feed</li>`,
    `    <li><a href="/feed.json">/feed.json</a> — JSON feed</li>`,
    `    <li><a href="/sitemap.xml">/sitemap.xml</a> — sitemap</li>`,
    "  </ul>",
    "</body>",
    "</html>",
  ].join("\n");

  return c.body(body, 302, {
    Location: siteConfig.authorUrl,
    "content-type": "text/html; charset=utf-8",
    Link: `</feed.xml>; rel="alternate"; type="application/rss+xml"; title="${siteConfig.name}"`,
  });
});

wellKnown.get("/robots.txt", (c) =>
  c.text("User-agent: *\nDisallow: /admin\nDisallow: /api\n", 200, {
    "content-type": "text/plain; charset=utf-8",
  }),
);

// 204 No Content is a valid response. Browsers cache it and stop asking,
// without us having to ship a binary placeholder.
wellKnown.get("/favicon.ico", (c) => c.body(null, 204));

wellKnown.get("/sitemap.xml", async (c) => {
  // Only public, complete, non-trashed videos appear in the sitemap.
  const rows = await getDb()
    .select()
    .from(videos)
    .where(
      and(eq(videos.visibility, "public"), eq(videos.status, "complete"), isNull(videos.trashedAt)),
    )
    .orderBy(desc(videos.createdAt));

  const entries = rows.map((v) => {
    const pageUrl = absoluteUrl(`/${v.slug}`);
    const posterUrl = absoluteUrl(`/${v.slug}/poster.jpg`);
    const mp4Url = absoluteUrl(`/${v.slug}/raw/${activeRawFilename(v)}`);
    const embedUrl = absoluteUrl(`/${v.slug}/embed`);
    const title = v.title ?? v.slug;
    const durationSec = v.durationSeconds ? Math.round(v.durationSeconds) : undefined;

    return [
      "  <url>",
      `    <loc>${escapeXml(pageUrl)}</loc>`,
      `    <lastmod>${v.updatedAt}</lastmod>`,
      "    <video:video>",
      `      <video:thumbnail_loc>${escapeXml(posterUrl)}</video:thumbnail_loc>`,
      `      <video:title>${escapeXml(title)}</video:title>`,
      v.description
        ? `      <video:description>${escapeXml(v.description)}</video:description>`
        : null,
      `      <video:content_loc>${escapeXml(mp4Url)}</video:content_loc>`,
      `      <video:player_loc>${escapeXml(embedUrl)}</video:player_loc>`,
      durationSec != null ? `      <video:duration>${durationSec}</video:duration>` : null,
      "    </video:video>",
      "  </url>",
    ]
      .filter(Boolean)
      .join("\n");
  });

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"',
    '        xmlns:video="http://www.google.com/schemas/sitemap-video/1.1">',
    ...entries,
    "</urlset>",
    "",
  ].join("\n");

  return c.body(xml, 200, { "content-type": "application/xml; charset=utf-8" });
});

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export default wellKnown;
