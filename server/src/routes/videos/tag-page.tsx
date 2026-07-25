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
  const videosWithPosters = await postersOnDisk(videos);
  // The OG image is the first tile's poster (not the newest video's) so a shared
  // link previews as the page actually looks under any tag sort order.
  const [firstVideo] = videos;

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
      videosWithPosters={videosWithPosters}
      ogImage={
        firstVideo && videosWithPosters.has(firstVideo.id)
          ? absoluteUrl(`/${firstVideo.slug}/poster.jpg`)
          : absoluteUrl(staticUrl("images/og-default.png"))
      }
      canonicalUrl={absoluteUrl(`/${tag.slug}`)}
      feedXmlUrl={`/${tag.slug}/feed.xml`}
      feedJsonUrl={`/${tag.slug}/feed.json`}
    />,
  );
}

// Which of these videos actually have a poster on disk. `ready` doesn't imply
// one — the thumbnail step is `expected`, not `required` — so both the OG image
// and the JSON-LD thumbnails are gated on a real file rather than assumed. A
// social scraper caches what it fetches, and a 404 in a VideoObject is a
// structured-data error, so publishing a hopeful URL is worse than omitting it.
async function postersOnDisk(videos: Video[]): Promise<Set<string>> {
  const present = await Promise.all(
    videos.map((v) => Bun.file(join(derivativesDir(v.id), "thumbnail.jpg")).exists()),
  );
  return new Set(videos.filter((_, i) => present[i]).map((v) => v.id));
}
