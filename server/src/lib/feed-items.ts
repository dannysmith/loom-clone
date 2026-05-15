// Per-item builders for the RSS and JSON Feed renderers. Extracted so both
// the site-wide feed (`/feed.xml`, `/feed.json`) and per-tag feeds
// (`/<tag-slug>/feed.xml`, `/<tag-slug>/feed.json`) can share the item shape.

import { inArray } from "drizzle-orm";
import { getDb } from "../db/client";
import { type Video, videoTranscripts } from "../db/schema";
import { formatDuration } from "./format";
import { absoluteUrl, activeRawFilename } from "./url";

export const TRANSCRIPT_WORD_LIMIT = 200;

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function truncateWords(text: string, limit: number): string {
  const words = text.split(/\s+/);
  if (words.length <= limit) return text;
  return `${words.slice(0, limit).join(" ")}…`;
}

// Renders the inner XML for a single <item> in an RSS 2.0 + Media RSS feed.
export function renderRssItem(v: Video): string {
  const pageUrl = absoluteUrl(`/${v.slug}`);
  const mp4Url = absoluteUrl(`/${v.slug}/raw/${activeRawFilename(v)}`);
  const posterUrl = absoluteUrl(`/${v.slug}/poster.jpg`);
  const title = v.title ?? v.slug;
  const durationSec = v.durationSeconds != null ? Math.round(v.durationSeconds) : undefined;
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
}

// Batch-loads transcripts for a list of video IDs in one query. Returns an
// id → plainText map for use in JSON Feed item construction.
export async function loadTranscriptMap(videoIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (videoIds.length === 0) return map;
  const rows = await getDb()
    .select({ videoId: videoTranscripts.videoId, plainText: videoTranscripts.plainText })
    .from(videoTranscripts)
    .where(inArray(videoTranscripts.videoId, videoIds));
  for (const r of rows) map.set(r.videoId, r.plainText);
  return map;
}

// Builds the item object for one video in a JSON Feed (1.1).
export function buildJsonFeedItem(v: Video, transcriptMap: Map<string, string>) {
  const pageUrl = absoluteUrl(`/${v.slug}`);
  const title = v.title ?? v.slug;
  const durationSec = v.durationSeconds != null ? Math.round(v.durationSeconds) : undefined;
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
}
