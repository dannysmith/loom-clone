import type { Context } from "hono";
import { Hono } from "hono";
import { join } from "path";
import { DATA_DIR, resolveSlug } from "../../lib/store";
import { urlsForSlug } from "../../lib/url";
import { VideoPage } from "../../views/viewer/VideoPage";

// Checks on-disk state so a healing recording transparently upgrades from
// HLS to MP4 on the next page load without any client state.
async function derivativeFlags(videoId: string): Promise<{ hasMp4: boolean; hasThumb: boolean }> {
  const mp4Path = join(DATA_DIR, videoId, "derivatives", "source.mp4");
  const thumbPath = join(DATA_DIR, videoId, "derivatives", "thumbnail.jpg");
  const [hasMp4, hasThumb] = await Promise.all([
    Bun.file(mp4Path).exists(),
    Bun.file(thumbPath).exists(),
  ]);
  return { hasMp4, hasThumb };
}

// New slug-namespaced page handler. Called by the aggregator's /:file
// dispatch — not registered as a Hono route directly, because Hono
// can't disambiguate /:slug from /:slug.json at the route level.
export async function handleSlugPage(c: Context, slug: string): Promise<Response> {
  const resolved = await resolveSlug(slug);
  if (!resolved) return c.text("Not found", 404);

  if (resolved.redirected) {
    return c.redirect(`/${resolved.video.slug}`, 301);
  }
  const { video } = resolved;

  const { hasMp4, hasThumb } = await derivativeFlags(video.id);
  const urls = urlsForSlug(video.slug);
  const src = hasMp4 ? urls.raw : urls.hls;
  const poster = hasThumb ? urls.poster : null;

  return c.html(<VideoPage slug={video.slug} src={src} poster={poster} />);
}

// Permanent redirect from the legacy /v/:slug path. Cached shared URLs,
// bookmarks, and older macOS app versions that still reference /v/... will
// 301 to the canonical /:slug form. Do not remove this route.
const page = new Hono();

page.get("/v/:slug", (c) => c.redirect(`/${c.req.param("slug")}`, 301));
page.get("/v/:slug/*", (c) => {
  const slug = c.req.param("slug");
  const rest = c.req.path.replace(`/v/${slug}`, `/${slug}`);
  return c.redirect(rest, 301);
});

export default page;
