import type { Context } from "hono";
import { getVideosForTag, resolveTagSlug } from "../../lib/tags";
import { absoluteUrl } from "../../lib/url";
import { TagPage } from "../../views/viewer/TagPage";

// Renders the public tag page at /:slug. Mirrors the video page's resolution
// semantics: 404 for unknown/private, 301 for old slugs via tag_slug_redirects,
// and a rendered page for current public/unlisted slugs.
export async function handleTagPage(c: Context, slug: string): Promise<Response> {
  const result = await resolveTagSlug(slug);
  if (!result) return c.text("Not found", 404);
  if (result.redirected) {
    return c.redirect(`/${result.tag.slug}`, 301);
  }

  const { tag } = result;
  if (!tag.slug) return c.text("Not found", 404); // should never happen post-resolve

  const videos = await getVideosForTag(tag.id);

  if (tag.visibility !== "public") {
    c.header("X-Robots-Tag", "noindex");
  }

  const cacheScope = tag.visibility === "public" ? "public" : "private";
  c.header("Cache-Control", `${cacheScope}, max-age=60, stale-while-revalidate=300`);

  return c.html(
    <TagPage
      tag={tag}
      videos={videos}
      canonicalUrl={absoluteUrl(`/${tag.slug}`)}
      feedXmlUrl={`/${tag.slug}/feed.xml`}
      feedJsonUrl={`/${tag.slug}/feed.json`}
    />,
  );
}
