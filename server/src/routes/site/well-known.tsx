import { and, desc, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { getDb } from "../../db/client";
import { videos } from "../../db/schema";
import { absoluteUrl } from "../../lib/url";
import { RootLayout } from "../../views/layouts/RootLayout";

// Root + well-known files. Open, no auth.
const wellKnown = new Hono();

wellKnown.get("/", (c) =>
  c.html(
    <RootLayout title="loom-clone">
      <main style="padding: 2rem; font-family: system-ui;">
        <h1>loom-clone</h1>
        <p>Personal video host.</p>
      </main>
    </RootLayout>,
  ),
);

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
    const mp4Url = absoluteUrl(`/${v.slug}/raw/source.mp4`);
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
    .replace(/"/g, "&quot;");
}

export default wellKnown;
