import type { Context } from "hono";
import { formatDate, formatDuration } from "../../lib/format";
import { resolveSlug } from "../../lib/store";
import { absoluteUrl, urlsForSlug } from "../../lib/url";

// Machine-readable representations of a video for programmatic/LLM
// consumption. Shapes are designed to be stable — add fields freely,
// don't remove or rename.

export async function handleJsonMetadata(c: Context, slug: string): Promise<Response> {
  const resolved = await resolveSlug(slug);
  if (!resolved) return c.json({ error: "Not found" }, 404);
  if (resolved.redirected) {
    return c.redirect(`/${resolved.video.slug}.json`, 301);
  }
  const { video } = resolved;
  const urls = urlsForSlug(video.slug);
  return c.json({
    id: video.id,
    slug: video.slug,
    status: video.status,
    visibility: video.visibility,
    title: video.title,
    description: video.description,
    durationSeconds: video.durationSeconds,
    durationFormatted: formatDuration(video.durationSeconds),
    source: video.source,
    createdAt: video.createdAt,
    updatedAt: video.updatedAt,
    completedAt: video.completedAt,
    url: absoluteUrl(urls.page),
    urls: {
      page: absoluteUrl(urls.page),
      raw: absoluteUrl(urls.raw),
      hls: absoluteUrl(urls.hls),
      poster: absoluteUrl(urls.poster),
      embed: absoluteUrl(`/${video.slug}/embed`),
      json: absoluteUrl(`/${video.slug}.json`),
      md: absoluteUrl(`/${video.slug}.md`),
      mp4: absoluteUrl(`/${video.slug}.mp4`),
    },
  });
}

export async function handleMdMetadata(c: Context, slug: string): Promise<Response> {
  const resolved = await resolveSlug(slug);
  if (!resolved) return c.text("Not found", 404);
  if (resolved.redirected) {
    return c.redirect(`/${resolved.video.slug}.md`, 301);
  }
  const { video } = resolved;
  const heading = video.title ?? video.slug;
  const duration = formatDuration(video.durationSeconds);
  const date = formatDate(video.completedAt ?? video.createdAt);
  const pageUrl = absoluteUrl(`/${video.slug}`);

  const lines: string[] = [`# ${heading}`, ""];
  if (video.description) lines.push(video.description, "");
  if (duration || date) {
    lines.push([duration, date].filter(Boolean).join(" · "), "");
  }
  lines.push(`[Watch](${pageUrl})`, "");

  // URL reference list
  lines.push("## Links", "");
  lines.push(`- [Video page](${pageUrl})`);
  lines.push(`- [Download MP4](${absoluteUrl(`/${video.slug}.mp4`)})`);
  lines.push(`- [Embed](${absoluteUrl(`/${video.slug}/embed`)})`);
  lines.push(`- [JSON metadata](${absoluteUrl(`/${video.slug}.json`)})`);
  lines.push("");

  return c.text(lines.join("\n"), 200, { "content-type": "text/markdown; charset=utf-8" });
}
