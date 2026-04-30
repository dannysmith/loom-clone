import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { getDb } from "../../db/client";
import { type Video, videos, videoTranscripts } from "../../db/schema";
import { formatDuration } from "../../lib/format";
import { siteConfig } from "../../lib/site-config";
import { absoluteUrl, activeRawFilename, getPublicBaseUrl } from "../../lib/url";

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

  const items = rows.map((v) => {
    const pageUrl = absoluteUrl(`/${v.slug}`);
    const mp4Url = absoluteUrl(`/${v.slug}/raw/${activeRawFilename(v)}`);
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

// ---------------------------------------------------------------------------
// JSON Feed 1.1
// ---------------------------------------------------------------------------

const TRANSCRIPT_WORD_LIMIT = 200;

feeds.get("/feed.json", async (c) => {
  const rows = await listPublicVideos();

  // Batch-fetch transcripts for all public videos in one query.
  const videoIds = rows.map((v) => v.id);
  const transcriptMap = new Map<string, string>();
  if (videoIds.length > 0) {
    const transcripts = await getDb()
      .select({
        videoId: videoTranscripts.videoId,
        plainText: videoTranscripts.plainText,
      })
      .from(videoTranscripts)
      .where(inArray(videoTranscripts.videoId, videoIds));
    for (const t of transcripts) {
      transcriptMap.set(t.videoId, t.plainText);
    }
  }

  const base = getPublicBaseUrl();

  const items = rows.map((v) => {
    const pageUrl = absoluteUrl(`/${v.slug}`);
    const title = v.title ?? v.slug;
    const durationSec = v.durationSeconds ? Math.round(v.durationSeconds) : undefined;
    const transcript = transcriptMap.get(v.id);
    const transcriptExcerpt = transcript ? truncateWords(transcript, TRANSCRIPT_WORD_LIMIT) : null;

    return {
      id: pageUrl,
      url: pageUrl,
      title,
      ...(v.description && { content_text: v.description }),
      image: absoluteUrl(`/${v.slug}/poster.jpg`),
      date_published: v.completedAt ?? v.createdAt,
      ...(durationSec != null && { _duration_seconds: durationSec }),
      ...(transcriptExcerpt && { _transcript_excerpt: transcriptExcerpt }),
      attachments: [
        {
          url: absoluteUrl(`/${v.slug}/raw/${activeRawFilename(v)}`),
          mime_type: "video/mp4",
          ...(durationSec != null && { duration_in_seconds: durationSec }),
        },
      ],
      _urls: {
        page: pageUrl,
        embed: absoluteUrl(`/${v.slug}/embed`),
        json: absoluteUrl(`/${v.slug}.json`),
        md: absoluteUrl(`/${v.slug}.md`),
        raw: absoluteUrl(`/${v.slug}/raw/${activeRawFilename(v)}`),
        poster: absoluteUrl(`/${v.slug}/poster.jpg`),
      },
    };
  });

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
      "- `/<slug>.mp4` — redirect to MP4 download",
      "- `/<slug>/raw/source.mp4` — direct source file",
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function truncateWords(text: string, limit: number): string {
  const words = text.split(/\s+/);
  if (words.length <= limit) return text;
  return `${words.slice(0, limit).join(" ")}…`;
}

export default feeds;
