import type { Context } from "hono";
import { Hono } from "hono";
import { join } from "path";
import { agentTextCacheControl } from "../../lib/cache-control";
import {
  chaptersForViewer,
  generateChaptersVTT,
  readChapters,
  viewerDurationFromEdits,
} from "../../lib/chapters";
import { probeDuration } from "../../lib/derivatives";
import { type CacheHint, serveFileWithRange } from "../../lib/file-serve";
import { DATA_DIR, derivativesDir } from "../../lib/paths";
import { HLS_SERVABLE } from "../../lib/playlist";
import { readEditsLenient } from "../../lib/processing/edl";
import { srtToVtt } from "../../lib/srt";
import { resolveSlug, sumSegmentDuration } from "../../lib/store";
import { activeRawFilename, PUBLIC_VIDEO_FILENAME } from "../../lib/url";

// Loose-typed EDL shape — we only need the edits array. Avoids pulling an
// edit module into the media route just for a type.

// Allowlists constrain which on-disk files each route can serve, preventing
// traversal and keeping the public surface focused. `upload.mp4` is the
// original of an UPLOADED video — served only as a fallback when its
// post-processing failed to produce a servable presentation master
// (resolve.ts), and it only ever exists in that failure case (maybeDeleteUpload
// removes it once source+metadata succeed). It lives in the video dir, not
// derivatives/.
//
// `source.mp4` is deliberately NOT here: it's the pristine original, kept as the
// thing everything else is regenerated from, and serving it would hand out
// un-processed (later, un-watermarked) video. Requests for it redirect to the
// presentation master instead, so links made before the restructure still work.
const RAW_FILENAME = /^(\d+p|upload)\.mp4$/;

async function resolveForMedia(slug: string) {
  const resolved = await resolveSlug(slug);
  return resolved?.video ?? null;
}

// How long source.mp4 is, which is the timeline the EDL is expressed against.
// `durationSeconds` describes the presentation MASTER, so feeding it to the
// remap on an edited video truncates the kept segments and drops chapters near
// the end.
//
// Recordings have the segment-duration sum, which is exact and outlives the HLS
// cleanup. Uploads have no segments, so an edited one has to be probed — the
// only record of the original length is the file itself. Unedited videos skip
// the probe: with no cuts the master IS the source length.
async function sourceDurationFor(
  video: { id: string; durationSeconds: number | null },
  edited: boolean,
): Promise<number> {
  const segmentSum = await sumSegmentDuration(video.id);
  if (segmentSum > 0) return segmentSum;
  if (!edited) return video.durationSeconds ?? 0;
  const probed = await probeDuration(join(DATA_DIR, video.id, "derivatives", "source.mp4"));
  return probed ?? video.durationSeconds ?? 0;
}

const media = new Hono();

media.get("/:slug/raw/:file", async (c) => {
  const { slug, file } = c.req.param();

  // `video.mp4` is the stable public name for "the best rendition", and
  // `source.mp4` is what that name used to be. Both resolve to the presentation
  // master, so published links survive a re-encode or a change of resolution.
  //
  // Explicitly short-cached: the target moves if a video is ever rebuilt at a
  // different resolution, and without a header BunnyCDN would apply its 30-day
  // default to the redirect.
  if (file === PUBLIC_VIDEO_FILENAME || file === "source.mp4") {
    const video = await resolveForMedia(slug);
    if (!video) return c.text("Not found", 404);
    const master = activeRawFilename(video);
    // No master yet (metadata hasn't run, or failed). There is nothing to hand
    // out — the video page still serves HLS — and redirecting to source.mp4
    // would land right back here.
    if (!master) return c.text("Not found", 404);
    c.header("Cache-Control", agentTextCacheControl(video.visibility));
    return c.redirect(`/${video.slug}/raw/${master}`, 302);
  }

  if (!RAW_FILENAME.test(file)) return c.text("Not found", 404);
  const video = await resolveForMedia(slug);
  if (!video) return c.text("Not found", 404);
  // upload.mp4 sits in the video dir; the renditions under derivatives/.
  const path =
    file === "upload.mp4"
      ? join(DATA_DIR, video.id, "upload.mp4")
      : join(DATA_DIR, video.id, "derivatives", file);
  // Derivatives are written atomically (tmp→rename) and never mutated.
  return serveFileWithRange(c, path, "video/mp4", "immutable");
});

media.get("/:slug/stream/:file", async (c) => {
  const { slug, file } = c.req.param();
  if (!HLS_SERVABLE.test(file)) return c.text("Not found", 404);
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
  const edits = await readEditsLenient(derivativesDir(video.id));
  const sourceDuration = await sourceDurationFor(video, edits.length > 0);
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
// Goes straight to the concrete rendition rather than via video.mp4, so it stays
// a single hop.
export async function handleMp4Redirect(c: Context, slug: string): Promise<Response> {
  const video = await resolveForMedia(slug);
  if (!video) return c.text("Not found", 404);
  const master = activeRawFilename(video);
  if (!master) return c.text("Not found", 404);
  return c.redirect(`/${video.slug}/raw/${master}`, 302);
}

export default media;
