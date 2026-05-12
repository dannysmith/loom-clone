import type { Context } from "hono";
import { Hono } from "hono";
import { join } from "path";
import {
  chaptersForViewer,
  generateChaptersVTT,
  readChapters,
  viewerDurationFromEdits,
} from "../../lib/chapters";
import { type CacheHint, serveFileWithRange } from "../../lib/file-serve";
import { srtToVtt } from "../../lib/srt";
import { DATA_DIR, resolveSlug } from "../../lib/store";
import { activeRawFilename } from "../../lib/url";

// Loose-typed EDL shape — we only need the edits array. Avoids pulling the
// edit-pipeline module into the media route just for a type.
type EditsFileLike = { edits?: unknown };

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

media.get("/:slug/chapters.vtt", async (c) => {
  const { slug } = c.req.param();
  const video = await resolveForMedia(slug);
  if (!video) return c.text("Not found", 404);
  const data = await readChapters(video.id);
  if (!data || data.chapters.length === 0) return c.text("Not found", 404);

  // Remap recording-timeline timestamps through the EDL (if any) so the
  // VTT reflects the viewer-facing timeline. Chapters that fall inside
  // cuts are dropped from the rendered VTT but stay in chapters.json.
  const sourceDuration = video.durationSeconds ?? 0;
  let edits: unknown[] = [];
  const editsFile = Bun.file(join(DATA_DIR, video.id, "derivatives", "edits.json"));
  if (await editsFile.exists()) {
    try {
      const parsed = (await editsFile.json()) as EditsFileLike;
      if (Array.isArray(parsed.edits)) edits = parsed.edits;
    } catch {
      // Malformed edits.json — fall back to no edits.
    }
  }
  // Belt-and-braces: even past the JSON parse, malformed edit entries
  // (wrong types, missing fields) could surface as arithmetic errors
  // inside chaptersForViewer. Treat that the same as "no edits".
  let mapped: typeof data.chapters;
  let viewerDuration: number;
  try {
    const typedEdits = edits as Parameters<typeof chaptersForViewer>[1];
    mapped = chaptersForViewer(data.chapters, typedEdits, sourceDuration);
    viewerDuration = viewerDurationFromEdits(typedEdits, sourceDuration);
  } catch {
    mapped = chaptersForViewer(data.chapters, [], sourceDuration);
    viewerDuration = sourceDuration;
  }
  if (mapped.length === 0) return c.text("Not found", 404);
  const vtt = generateChaptersVTT(mapped, viewerDuration);
  c.header("Cache-Control", "public, max-age=3600");
  c.header("Content-Type", "text/vtt");
  return c.body(vtt);
});

// /:slug.mp4 convenience redirect. Dispatched from the aggregator's /:file
// handler because Hono can't separate `:slug` from `.mp4` as param + literal.
// Uses activeRawFilename to resolve to the correct file (edited or original).
export async function handleMp4Redirect(c: Context, slug: string): Promise<Response> {
  const video = await resolveForMedia(slug);
  if (!video) return c.text("Not found", 404);
  return c.redirect(`/${video.slug}/raw/${activeRawFilename(video)}`, 302);
}

export default media;
