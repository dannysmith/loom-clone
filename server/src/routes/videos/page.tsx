import { Hono } from "hono";
import { join } from "path";
import { DATA_DIR, resolveSlug } from "../../lib/store";
import { VideoPage } from "../../views/viewer/VideoPage";

const page = new Hono();

page.get("/v/:slug", async (c) => {
  const { slug } = c.req.param();
  const resolved = await resolveSlug(slug);
  if (!resolved) return c.text("Not found", 404);

  // Renamed slugs 301 to the current URL so viewers and embedders always
  // land on the canonical page. Search engines treat this as a permanent
  // move and collapse link equity onto the new URL.
  if (resolved.redirected) {
    return c.redirect(`/v/${resolved.video.slug}`, 301);
  }
  const { video } = resolved;

  // Prefer the single-file MP4 when the derivative exists; otherwise fall
  // back to the HLS playlist. Checking on each request means a healing
  // recording transparently upgrades from HLS to MP4 on the next page load
  // without any client state.
  const mp4Path = join(DATA_DIR, video.id, "derivatives", "source.mp4");
  const thumbPath = join(DATA_DIR, video.id, "derivatives", "thumbnail.jpg");
  const [hasMp4, hasThumb] = await Promise.all([
    Bun.file(mp4Path).exists(),
    Bun.file(thumbPath).exists(),
  ]);
  const src = hasMp4 ? `/data/${video.id}/derivatives/source.mp4` : `/data/${video.id}/stream.m3u8`;
  const poster = hasThumb ? `/data/${video.id}/derivatives/thumbnail.jpg` : null;

  return c.html(<VideoPage slug={video.slug} src={src} poster={poster} />);
});

export default page;
