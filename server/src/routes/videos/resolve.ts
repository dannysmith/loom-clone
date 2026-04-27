import { join } from "path";
import { DATA_DIR, resolveSlug, type Video } from "../../lib/store";
import { urlsForSlug, type VideoUrls } from "../../lib/url";

// Variant heights we ever generate, in highest-first order. Matches the
// VARIANTS list in lib/derivatives.ts. Order here is the order the player
// sees them in <source> children, which biases its initial pick.
const VARIANT_HEIGHTS = [1080, 720] as const;

// Checks which derivative files exist on disk. The MP4 set drives whether
// we serve the multi-source quality menu or fall back to live HLS.
async function derivativeFlags(videoId: string): Promise<{
  hasSource: boolean;
  variantHeights: number[];
  hasThumb: boolean;
  hasCaptions: boolean;
}> {
  const dir = join(DATA_DIR, videoId, "derivatives");
  const sourcePath = join(dir, "source.mp4");
  const thumbPath = join(dir, "thumbnail.jpg");
  const captionsPath = join(dir, "captions.srt");
  const variantPaths = VARIANT_HEIGHTS.map((h) => join(dir, `${h}p.mp4`));
  const [hasSource, hasThumb, hasCaptions, ...variantExists] = await Promise.all([
    Bun.file(sourcePath).exists(),
    Bun.file(thumbPath).exists(),
    Bun.file(captionsPath).exists(),
    ...variantPaths.map((p) => Bun.file(p).exists()),
  ]);
  const variantHeights = VARIANT_HEIGHTS.filter((_, i) => variantExists[i]);
  return { hasSource, variantHeights, hasThumb, hasCaptions };
}

// One entry in the player's `<source>` list. `width`/`height` populate
// Vidstack's `player.qualities` via `data-width`/`data-height` so the
// default settings menu surfaces a Quality submenu.
export type SourceDescriptor = {
  src: string;
  type: string;
  width?: number;
  height?: number;
};

// Mirrors `ffmpeg scale=-2:H` — output width is height × aspect rounded to
// the nearest even number.
function computeVariantWidth(targetHeight: number, aspectRatio: number): number {
  return Math.round((targetHeight * aspectRatio) / 2) * 2;
}

// Resolved video data ready for viewer rendering. Either `src` (HLS
// fallback while derivatives haven't landed) or `sources` (one or more
// MP4 variants) is set, never both.
export type ViewerVideo = {
  video: Video;
  urls: VideoUrls;
  src: string | null;
  sources: SourceDescriptor[] | null;
  poster: string | null;
  captionsUrl: string | null;
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
  const { hasSource, variantHeights, hasThumb, hasCaptions } = await derivativeFlags(video.id);
  const urls = urlsForSlug(video.slug);

  let src: string | null = null;
  let sources: SourceDescriptor[] | null = null;

  if (hasSource) {
    // Use DB aspect when available, else fall back to width/height, else
    // skip dimensions entirely (no Quality menu, but the player still
    // works).
    const aspect =
      video.aspectRatio ?? (video.width && video.height ? video.width / video.height : null);

    const sourceEntry: SourceDescriptor = { src: urls.raw, type: "video/mp4" };
    if (video.width && video.height) {
      sourceEntry.width = video.width;
      sourceEntry.height = video.height;
    }

    const variantEntries: SourceDescriptor[] = variantHeights.map((height) => {
      const entry: SourceDescriptor = {
        src: `/${video.slug}/raw/${height}p.mp4`,
        type: "video/mp4",
      };
      if (aspect) {
        entry.width = computeVariantWidth(height, aspect);
        entry.height = height;
      }
      return entry;
    });

    // Default playback should be at most 1080p. Browsers pick the first
    // compatible <source> as the default, so when a 1080p.mp4 derivative
    // exists (i.e. source > 1080p) we promote it to first. Otherwise
    // source.mp4 leads — it is already ≤1080p in that case. Vidstack's
    // Quality menu sorts by data-width/height internally, so the visible
    // menu order is unchanged regardless of DOM order.
    const variant1080 = variantEntries.find((e) => e.height === 1080);
    if (variant1080) {
      const others = variantEntries.filter((e) => e !== variant1080);
      sources = [variant1080, sourceEntry, ...others];
    } else {
      sources = [sourceEntry, ...variantEntries];
    }
  } else {
    src = urls.hls;
  }

  return {
    video,
    urls,
    src,
    sources,
    poster: hasThumb ? urls.poster : null,
    captionsUrl: hasCaptions ? `/${video.slug}/captions.srt` : null,
  };
}
