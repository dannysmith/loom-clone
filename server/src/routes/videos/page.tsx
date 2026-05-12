import type { Context } from "hono";
import { hasAdminHint } from "../../lib/admin-auth";
import { absoluteUrl } from "../../lib/url";
import { VideoPage } from "../../views/viewer/VideoPage";
import { resolveForViewer } from "./resolve";

// Video page handler. Called by the aggregator's /:file dispatch — not
// registered as a Hono route directly, because Hono can't disambiguate
// /:slug from /:slug.json at the route level.
export async function handleSlugPage(c: Context, slug: string): Promise<Response> {
  const result = await resolveForViewer(slug);
  if (!result) return c.text("Not found", 404);
  if ("redirect" in result) return c.redirect(`/${result.redirect}`, 301);

  const { video, src, sources, poster, captionsUrl, chaptersUrl, urls } = result;
  const canonicalUrl = absoluteUrl(urls.page);
  const posterAbsolute = poster ? absoluteUrl(urls.poster) : null;
  const embedAbsolute = absoluteUrl(`/${video.slug}/embed`);
  const adminUrl = hasAdminHint(c) ? `/admin/videos/${video.id}` : null;

  if (video.visibility !== "public") {
    c.header("X-Robots-Tag", "noindex");
  }

  // Short cache + stale-while-revalidate so repeat visits and any future
  // intermediate caches skip a render. `private` for non-public videos so
  // shared caches (CDN) never store them.
  const cacheScope = video.visibility === "public" ? "public" : "private";
  c.header("Cache-Control", `${cacheScope}, max-age=60, stale-while-revalidate=300`);

  return c.html(
    <VideoPage
      video={video}
      src={src}
      sources={sources}
      poster={poster}
      captionsUrl={captionsUrl}
      chaptersUrl={chaptersUrl}
      canonicalUrl={canonicalUrl}
      posterAbsolute={posterAbsolute}
      embedAbsolute={embedAbsolute}
      adminUrl={adminUrl}
    />,
  );
}
