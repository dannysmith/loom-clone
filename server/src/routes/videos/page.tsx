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

// Legacy /v/:slug path. Kept intact through 6.6 where it'll become a 301
// redirect to the slug-root form. Still emits /data/* URLs today; 6.5
// updates those at the same time the /data/* handler is dropped.
const page = new Hono();

page.get("/v/:slug", async (c) => {
  const { slug } = c.req.param();
  const resolved = await resolveSlug(slug);
  if (!resolved) return c.text("Not found", 404);

  if (resolved.redirected) {
    return c.redirect(`/v/${resolved.video.slug}`, 301);
  }
  const { video } = resolved;

  const { hasMp4, hasThumb } = await derivativeFlags(video.id);
  const src = hasMp4 ? `/data/${video.id}/derivatives/source.mp4` : `/data/${video.id}/stream.m3u8`;
  const poster = hasThumb ? `/data/${video.id}/derivatives/thumbnail.jpg` : null;

  return c.html(<VideoPage slug={video.slug} src={src} poster={poster} />);
});

export default page;
