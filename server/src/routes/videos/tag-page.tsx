import type { Context } from "hono";
import { join } from "path";
import { derivativesDir } from "../../lib/derivatives";
import { staticUrl } from "../../lib/static-assets";
import type { Video } from "../../lib/store";
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

  const videos = await getVideosForTag(tag.id, tag.videoSort);

  if (tag.visibility !== "public") {
    c.header("X-Robots-Tag", "noindex");
  }

  const cacheScope = tag.visibility === "public" ? "public" : "private";
  c.header("Cache-Control", `${cacheScope}, max-age=60, stale-while-revalidate=300`);

  // Point agents at the site index, and signal that this URL also serves
  // markdown via `Accept` content negotiation.
  c.header("Link", '</llms.txt>; rel="describedby"');
  c.header("Vary", "Accept");

  return c.html(
    <TagPage
      tag={tag}
      videos={videos}
      ogImage={await tagOgImage(videos[0])}
      canonicalUrl={absoluteUrl(`/${tag.slug}`)}
      feedXmlUrl={`/${tag.slug}/feed.xml`}
      feedJsonUrl={`/${tag.slug}/feed.json`}
    />,
  );
}

// OG image for a tag page: the poster of the first video in the grid, so a
// shared tag link previews with real artwork rather than the generic site card.
// Existence-checked — social scrapers cache what they fetch, so a 404 image is
// worse than the fallback. Uses the first tile (not the newest video) so the
// preview matches what the page actually looks like under any tag sort order.
async function tagOgImage(first: Video | undefined): Promise<string> {
  if (first) {
    const poster = join(derivativesDir(first.id), "thumbnail.jpg");
    if (await Bun.file(poster).exists()) return absoluteUrl(`/${first.slug}/poster.jpg`);
  }
  return absoluteUrl(staticUrl("images/og-default.png"));
}
