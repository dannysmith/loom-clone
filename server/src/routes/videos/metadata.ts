import type { Context } from "hono";
import { join } from "path";
import { agentTextCacheControl } from "../../lib/cache-control";
import { VARIANTS } from "../../lib/derivatives";
import { formatDate, formatDuration } from "../../lib/format";
import { DATA_DIR } from "../../lib/paths";
import { getTranscript, resolveSlug, type Video } from "../../lib/store";
import { absoluteUrl, activeRawFilename, urlsForVideo } from "../../lib/url";

// Machine-readable representations of a video for programmatic/LLM
// consumption. Shapes are designed to be stable — add fields freely,
// don't remove or rename.

// Downscale heights we ever generate, highest-first — read from the canonical
// VARIANTS list rather than restated, so a new rendition can't be added in one
// place and forgotten here.
const DOWNSCALE_HEIGHTS = VARIANTS.map((v) => v.height);

type SourceEntry = {
  height: number;
  width: number;
  type: string;
  url: string;
};

// Builds the public `sources` array: the presentation master at the source's own
// resolution, plus any downscale variants that exist on disk and are smaller.
// Ordered highest-resolution first. These are concrete per-rendition URLs — the
// redirecting video.mp4 is what `urls.raw` carries.
async function listSources(video: Video): Promise<SourceEntry[]> {
  const { width, height, slug, aspectRatio } = video;
  if (!width || !height) return [];
  const dir = join(DATA_DIR, video.id, "derivatives");
  const aspect = aspectRatio ?? width / height;
  // Guarded by the `!width || !height` check above, so a master name exists.
  const activeFile = activeRawFilename(video) ?? `${height}p.mp4`;

  const downscaleHeights = DOWNSCALE_HEIGHTS.filter((h) => h < height);
  const [activeExists, ...downscaleExists] = await Promise.all([
    Bun.file(join(dir, activeFile)).exists(),
    ...downscaleHeights.map((h) => Bun.file(join(dir, `${h}p.mp4`)).exists()),
  ]);

  const sources: SourceEntry[] = [];
  if (activeExists) {
    sources.push({
      height,
      width,
      type: "video/mp4",
      url: absoluteUrl(`/${slug}/raw/${activeFile}`),
    });
  }
  for (const [i, h] of downscaleHeights.entries()) {
    if (!downscaleExists[i]) continue;
    sources.push({
      height: h,
      width: Math.round((h * aspect) / 2) * 2,
      type: "video/mp4",
      url: absoluteUrl(`/${slug}/raw/${h}p.mp4`),
    });
  }
  return sources;
}

export async function handleJsonMetadata(c: Context, slug: string): Promise<Response> {
  const resolved = await resolveSlug(slug);
  if (!resolved) return c.json({ error: "Not found", code: "VIDEO_NOT_FOUND" }, 404);
  if (resolved.redirected) {
    return c.redirect(`/${resolved.video.slug}.json`, 301);
  }
  const { video } = resolved;
  const urls = urlsForVideo(video);
  const transcript = await getTranscript(video.id);
  const sources = await listSources(video);
  const hasStoryboard = (video.durationSeconds ?? 0) >= 60;
  c.header("Cache-Control", agentTextCacheControl(video.visibility));
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
    width: video.width,
    height: video.height,
    aspectRatio: video.aspectRatio,
    sources,
    transcript: transcript?.plainText ?? null,
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
      captions: transcript ? absoluteUrl(`/${video.slug}/captions.vtt`) : null,
      storyboard: hasStoryboard ? absoluteUrl(`/${video.slug}/storyboard.vtt`) : null,
      storyboardImage: hasStoryboard ? absoluteUrl(`/${video.slug}/storyboard.jpg`) : null,
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

  // Sections joined by blank lines. A leading blockquote points agents at the
  // site index (see agentdocsspec.com — llms-txt-directive-md). Optional
  // sections (description, meta, transcript) are only included when present,
  // so the output stays clean.
  const sections: string[] = [
    "> For a machine-readable index of all videos on this site, see [llms.txt](/llms.txt).",
    `# ${heading}`,
  ];
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
    "Cache-Control": agentTextCacheControl(video.visibility),
  });
}
