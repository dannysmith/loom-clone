import { Hono } from "hono";
import { join } from "path";
import { DATA_DIR, resolveSlug } from "../../lib/store";
import { urlsForSlug } from "../../lib/url";
import { EmbedPage } from "../../views/viewer/EmbedPage";

const embed = new Hono();

// Chromeless player for iframe use. Same MP4-vs-HLS selection as the main
// page. Old-slug 301 points at the embed URL for the current slug so
// iframe embeds don't break after a rename.
embed.get("/:slug/embed", async (c) => {
  const { slug } = c.req.param();
  const resolved = await resolveSlug(slug);
  if (!resolved) return c.text("Not found", 404);

  if (resolved.redirected) {
    return c.redirect(`/${resolved.video.slug}/embed`, 301);
  }
  const { video } = resolved;

  const mp4Path = join(DATA_DIR, video.id, "derivatives", "source.mp4");
  const thumbPath = join(DATA_DIR, video.id, "derivatives", "thumbnail.jpg");
  const [hasMp4, hasThumb] = await Promise.all([
    Bun.file(mp4Path).exists(),
    Bun.file(thumbPath).exists(),
  ]);
  const urls = urlsForSlug(video.slug);
  const src = hasMp4 ? urls.raw : urls.hls;
  const poster = hasThumb ? urls.poster : null;

  return c.html(<EmbedPage slug={video.slug} src={src} poster={poster} />);
});

export default embed;
