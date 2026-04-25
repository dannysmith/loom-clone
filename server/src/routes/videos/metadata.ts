import type { Context } from "hono";
import { formatDate, formatDuration } from "../../lib/format";
import { getTranscript, resolveSlug } from "../../lib/store";
import { absoluteUrl, urlsForSlug } from "../../lib/url";

// Machine-readable representations of a video for programmatic/LLM
// consumption. Shapes are designed to be stable — add fields freely,
// don't remove or rename.

export async function handleJsonMetadata(c: Context, slug: string): Promise<Response> {
  const resolved = await resolveSlug(slug);
  if (!resolved) return c.json({ error: "Not found", code: "VIDEO_NOT_FOUND" }, 404);
  if (resolved.redirected) {
    return c.redirect(`/${resolved.video.slug}.json`, 301);
  }
  const { video } = resolved;
  const urls = urlsForSlug(video.slug);
  const transcript = await getTranscript(video.id);
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
    transcript: transcript?.plainText ?? null,
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
  const meta = [duration, date].filter(Boolean).join(" · ");
  const pageUrl = absoluteUrl(`/${video.slug}`);
  const mp4Url = absoluteUrl(`/${video.slug}.mp4`);
  const embedUrl = absoluteUrl(`/${video.slug}/embed`);
  const jsonUrl = absoluteUrl(`/${video.slug}.json`);

  // Sections joined by blank lines. Optional sections (description, meta,
  // transcript) are only included when present, so the output stays clean.
  const sections: string[] = [`# ${heading}`];
  if (video.description) sections.push(video.description);
  if (meta) sections.push(meta);
  sections.push(`[Watch](${pageUrl})`);
  sections.push(
    [
      "## Links",
      "",
      `- [Video page](${pageUrl})`,
      `- [Download MP4](${mp4Url})`,
      `- [Embed](${embedUrl})`,
      `- [JSON metadata](${jsonUrl})`,
    ].join("\n"),
  );

  const transcript = await getTranscript(video.id);
  if (transcript) {
    sections.push(`## Transcript\n\n${transcript.plainText}`);
  }

  return c.text(`${sections.join("\n\n")}\n`, 200, {
    "content-type": "text/markdown; charset=utf-8",
  });
}
