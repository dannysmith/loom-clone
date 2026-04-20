import { join } from "path";
import { DATA_DIR, resolveSlug, type Video } from "../../lib/store";
import { urlsForSlug, type VideoUrls } from "../../lib/url";

// Checks which derivatives exist on disk so the viewer can pick the best
// source (MP4 when ready, HLS fallback during healing) without any client
// state. Shared between the video page and embed page.
async function derivativeFlags(videoId: string): Promise<{ hasMp4: boolean; hasThumb: boolean }> {
  const mp4Path = join(DATA_DIR, videoId, "derivatives", "source.mp4");
  const thumbPath = join(DATA_DIR, videoId, "derivatives", "thumbnail.jpg");
  const [hasMp4, hasThumb] = await Promise.all([
    Bun.file(mp4Path).exists(),
    Bun.file(thumbPath).exists(),
  ]);
  return { hasMp4, hasThumb };
}

// Resolved video data ready for viewer rendering.
export type ViewerVideo = {
  video: Video;
  urls: VideoUrls;
  src: string;
  poster: string | null;
};

// Result of resolving a slug for viewer-facing routes:
//   null            — not found (404)
//   { redirect }    — old slug, redirect to canonical (301)
//   ViewerVideo     — render the page
// Use `'redirect' in result` to narrow between the redirect and video cases.
export type ViewerResolution = null | { redirect: string } | ViewerVideo;

// Resolves a slug into everything a viewer-facing route needs to render.
// Handles slug lookup, redirect detection, derivative checks, and URL
// building in one call so page and embed handlers stay focused on rendering.
export async function resolveForViewer(slug: string): Promise<ViewerResolution> {
  const resolved = await resolveSlug(slug);
  if (!resolved) return null;

  if (resolved.redirected) {
    return { redirect: resolved.video.slug };
  }

  const { video } = resolved;
  const { hasMp4, hasThumb } = await derivativeFlags(video.id);
  const urls = urlsForSlug(video.slug);

  return {
    video,
    urls,
    src: hasMp4 ? urls.raw : urls.hls,
    poster: hasThumb ? urls.poster : null,
  };
}
