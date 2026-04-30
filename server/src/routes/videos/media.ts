import type { Context } from "hono";
import { Hono } from "hono";
import { join } from "path";
import { type CacheHint, serveFileWithRange } from "../../lib/file-serve";
import { srtToVtt } from "../../lib/srt";
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
  const filePath = join(DATA_DIR, video.id, "derivatives", "storyboard.vtt");
  const file = Bun.file(filePath);
  if (!(await file.exists())) return c.text("Not found", 404);
  // Rewrite bare `storyboard.jpg` references to `/{slug}/storyboard.jpg` so
  // the browser resolves them correctly regardless of the page URL structure.
  const raw = await file.text();
  const rewritten = raw.replace(/^storyboard\.jpg/gm, `/${video.slug}/storyboard.jpg`);
  c.header("Cache-Control", "public, max-age=31536000, immutable");
  return c.text(rewritten, 200, { "Content-Type": "text/vtt" });
});

media.get("/:slug/captions.srt", async (c) => {
  const { slug } = c.req.param();
  const video = await resolveForMedia(slug);
  if (!video) return c.text("Not found", 404);
  const filePath = join(DATA_DIR, video.id, "derivatives", "captions.srt");
  const file = Bun.file(filePath);
  if (!(await file.exists())) return c.text("Not found", 404);
  c.header("Cache-Control", "public, max-age=3600");
  c.header("Content-Type", "application/x-subrip");
  return c.body(await file.text());
});

media.get("/:slug/captions.vtt", async (c) => {
  const { slug } = c.req.param();
  const video = await resolveForMedia(slug);
  if (!video) return c.text("Not found", 404);
  const derivDir = join(DATA_DIR, video.id, "derivatives");
  const vttFile = Bun.file(join(derivDir, "captions.vtt"));
  if (await vttFile.exists()) {
    c.header("Cache-Control", "public, max-age=3600");
    c.header("Content-Type", "text/vtt");
    return c.body(await vttFile.text());
  }
  // Fall back to converting SRT → VTT on the fly
  const srtFile = Bun.file(join(derivDir, "captions.srt"));
  if (!(await srtFile.exists())) return c.text("Not found", 404);
  c.header("Cache-Control", "public, max-age=3600");
  c.header("Content-Type", "text/vtt");
  return c.body(srtToVtt(await srtFile.text()));
});

// /:slug.mp4 convenience redirect. Dispatched from the aggregator's /:file
// handler because Hono can't separate `:slug` from `.mp4` as param + literal.
// When edits have been applied, a resolution-named file (e.g. 1080p.mp4)
// exists at the source's own resolution — serve that instead of source.mp4.
export async function handleMp4Redirect(c: Context, slug: string): Promise<Response> {
  const video = await resolveForMedia(slug);
  if (!video) return c.text("Not found", 404);

  // If an edited version exists at the source resolution, redirect to that.
  if (video.height) {
    const editedFile = `${video.height}p.mp4`;
    const editedPath = join(DATA_DIR, video.id, "derivatives", editedFile);
    if (await Bun.file(editedPath).exists()) {
      return c.redirect(`/${video.slug}/raw/${editedFile}`, 302);
    }
  }

  return c.redirect(`/${video.slug}/raw/source.mp4`, 302);
}

export default media;
