import type { Context } from "hono";
import { Hono } from "hono";
import { join } from "path";
import { type CacheHint, serveFileWithRange } from "../../lib/file-serve";
import { DATA_DIR, resolveSlug } from "../../lib/store";

// Allowlists constrain which on-disk files each route can serve, preventing
// traversal and keeping the public surface focused.
const RAW_FILENAME = /^(source|\d+p)\.mp4$/;
const STREAM_FILENAME = /^(stream\.m3u8|init\.mp4|seg_\d+\.m4s)$/;

async function resolveForMedia(slug: string) {
  const resolved = await resolveSlug(slug);
  return resolved?.video ?? null;
}

const media = new Hono();

media.get("/:slug/raw/:file", async (c) => {
  const { slug, file } = c.req.param();
  if (!RAW_FILENAME.test(file)) return c.text("Not found", 404);
  const video = await resolveForMedia(slug);
  if (!video) return c.text("Not found", 404);
  const path = join(DATA_DIR, video.id, "derivatives", file);
  // Derivatives are written atomically (tmp→rename) and never mutated.
  return serveFileWithRange(c, path, "video/mp4", "immutable");
});

media.get("/:slug/stream/:file", async (c) => {
  const { slug, file } = c.req.param();
  if (!STREAM_FILENAME.test(file)) return c.text("Not found", 404);
  const video = await resolveForMedia(slug);
  if (!video) return c.text("Not found", 404);
  const path = join(DATA_DIR, video.id, file);
  const contentType = file.endsWith(".m3u8")
    ? "application/vnd.apple.mpegurl"
    : file.endsWith(".m4s")
      ? "video/iso.segment"
      : "video/mp4";
  // Playlist changes during recording; segments are immutable once uploaded.
  const cache: CacheHint = file.endsWith(".m3u8") ? "short" : "immutable";
  return serveFileWithRange(c, path, contentType, cache);
});

media.get("/:slug/poster.jpg", async (c) => {
  const { slug } = c.req.param();
  const video = await resolveForMedia(slug);
  if (!video) return c.text("Not found", 404);
  const path = join(DATA_DIR, video.id, "derivatives", "thumbnail.jpg");
  return serveFileWithRange(c, path, "image/jpeg", "immutable");
});

media.get("/:slug/storyboard.jpg", async (c) => {
  const { slug } = c.req.param();
  const video = await resolveForMedia(slug);
  if (!video) return c.text("Not found", 404);
  const path = join(DATA_DIR, video.id, "derivatives", "storyboard.jpg");
  return serveFileWithRange(c, path, "image/jpeg", "immutable");
});

media.get("/:slug/storyboard.vtt", async (c) => {
  const { slug } = c.req.param();
  const video = await resolveForMedia(slug);
  if (!video) return c.text("Not found", 404);
  const path = join(DATA_DIR, video.id, "derivatives", "storyboard.vtt");
  return serveFileWithRange(c, path, "text/vtt", "immutable");
});

// /:slug.mp4 convenience redirect. Dispatched from the aggregator's /:file
// handler because Hono can't separate `:slug` from `.mp4` as param + literal.
export async function handleMp4Redirect(c: Context, slug: string): Promise<Response> {
  const video = await resolveForMedia(slug);
  if (!video) return c.text("Not found", 404);
  return c.redirect(`/${video.slug}/raw/source.mp4`, 302);
}

export default media;
