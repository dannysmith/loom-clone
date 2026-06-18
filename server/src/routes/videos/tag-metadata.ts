import type { Context } from "hono";
import { agentTextCacheControl } from "../../lib/cache-control";
import { formatDate, formatDuration } from "../../lib/format";
import { getVideosForTag, resolveTagSlug } from "../../lib/tags";
import { absoluteUrl } from "../../lib/url";

// Markdown representation of a tag page — the agent-friendly mirror of the
// HTML tag page at /:slug. Reached via /:slug.md (tag fallback) and via
// `Accept: text/markdown` content negotiation on /:slug. Shape mirrors the
// per-video .md in metadata.ts.
export async function handleTagMdMetadata(c: Context, slug: string): Promise<Response> {
  const result = await resolveTagSlug(slug);
  if (!result) return c.text("Not found", 404);
  if (result.redirected) {
    return c.redirect(`/${result.tag.slug}.md`, 301);
  }

  const { tag } = result;
  if (!tag.slug) return c.text("Not found", 404);

  const videos = await getVideosForTag(tag.id, tag.videoSort);
  const pageUrl = absoluteUrl(`/${tag.slug}`);

  const sections: string[] = [
    "> For a machine-readable index of all videos on this site, see [llms.txt](/llms.txt).",
    `# ${tag.name}`,
  ];
  if (tag.description) sections.push(tag.description);
  sections.push(`${videos.length} ${videos.length === 1 ? "video" : "videos"}`);
  sections.push(`[View page](${pageUrl})`);

  if (videos.length > 0) {
    const videoLines = videos.map((v) => {
      const title = v.title ?? v.slug;
      const url = absoluteUrl(`/${v.slug}`);
      const parts = [formatDuration(v.durationSeconds), formatDate(v.completedAt ?? v.createdAt)]
        .filter(Boolean)
        .join(" · ");
      const suffix = parts ? ` — ${parts}` : "";
      return `- [${title}](${url})${suffix}`;
    });
    sections.push(["## Videos", "", ...videoLines].join("\n"));
  }

  sections.push(
    [
      "## Links",
      "",
      `- [RSS Feed](${absoluteUrl(`/${tag.slug}/feed.xml`)})`,
      `- [JSON Feed](${absoluteUrl(`/${tag.slug}/feed.json`)})`,
      `- [Site index](${absoluteUrl("/llms.txt")})`,
    ].join("\n"),
  );

  if (tag.visibility !== "public") c.header("X-Robots-Tag", "noindex");
  return c.text(`${sections.join("\n\n")}\n`, 200, {
    "content-type": "text/markdown; charset=utf-8",
    "Cache-Control": agentTextCacheControl(tag.visibility),
  });
}
