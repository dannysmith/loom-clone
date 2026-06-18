import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { join } from "path";
import { getDb } from "../../db/client";
import { tags, videos } from "../../db/schema";
import { agentTextCacheControl } from "../../lib/cache-control";
import { siteConfig } from "../../lib/site-config";
import { PUBLIC_ROOT } from "../../lib/static-assets";
import { absoluteUrl, activeRawFilename } from "../../lib/url";
import { buildLlmsTxt } from "./feeds";

// Root + well-known files. Open, no auth.
const wellKnown = new Hono();

// 302 temporary redirect to the author's site. The HTML body is never
// rendered by browsers (they follow the Location header) but IS displayed
// by curl (without -L), wget --max-redirect=0, and AI agents — giving
// them pointers to /llms.txt and the feeds before they follow the redirect.
wellKnown.get("/", async (c) => {
  // The root is just a redirect hub. For agents asking for markdown, the most
  // useful "site as markdown" is the llms.txt index, so serve that directly
  // instead of the 302 + HTML. The CDN edge rule bypasses cache on this
  // Accept header; `no-store` + `Vary` keep shared caches from mixing it with
  // the HTML response.
  if ((c.req.header("accept") ?? "").includes("text/markdown")) {
    return c.text(await buildLlmsTxt(), 200, {
      "content-type": "text/markdown; charset=utf-8",
      "Cache-Control": "private, no-store",
      Vary: "Accept",
    });
  }

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
    Vary: "Accept",
  });
});

// Served from the static file at public/robots.txt so it's editable without
// touching code. PUBLIC_ROOT is resolved absolutely, so this works regardless
// of the process cwd (including under test chdirs).
wellKnown.get("/robots.txt", async (c) => {
  const body = await Bun.file(join(PUBLIC_ROOT, "robots.txt")).text();
  return c.text(body, 200, {
    "content-type": "text/plain; charset=utf-8",
    "Cache-Control": agentTextCacheControl(),
  });
});

// 204 No Content is a valid response. Browsers cache it and stop asking,
// without us having to ship a binary placeholder.
wellKnown.get("/favicon.ico", (c) => c.body(null, 204));

wellKnown.get("/sitemap.xml", async (c) => {
  // Only public, complete, non-trashed videos appear in the sitemap. Public
  // tags with a slug also get a `<url>` entry (no video:video child).
  const [rows, tagRows] = await Promise.all([
    getDb()
      .select()
      .from(videos)
      .where(
        and(eq(videos.visibility, "public"), eq(videos.status, "ready"), isNull(videos.trashedAt)),
      )
      .orderBy(desc(videos.createdAt)),
    getDb()
      .select()
      .from(tags)
      .where(and(eq(tags.visibility, "public"), isNotNull(tags.slug)))
      .orderBy(desc(tags.createdAt)),
  ]);

  const tagEntries = tagRows
    .filter((t) => t.slug)
    .map((t) =>
      [
        "  <url>",
        `    <loc>${escapeXml(absoluteUrl(`/${t.slug}`))}</loc>`,
        `    <lastmod>${t.createdAt}</lastmod>`,
        "  </url>",
      ].join("\n"),
    );

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
    ...tagEntries,
    "</urlset>",
    "",
  ].join("\n");

  return c.body(xml, 200, {
    "content-type": "application/xml; charset=utf-8",
    "Cache-Control": agentTextCacheControl(),
  });
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
