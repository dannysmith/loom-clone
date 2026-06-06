import { join } from "path";
import { chaptersExist } from "../../lib/chapters";
import { VARIANTS } from "../../lib/derivatives";
import { getStepStates } from "../../lib/processing/steps-store";
import { DATA_DIR, resolveSlug, type Video } from "../../lib/store";
import { activeRawFilename, urlsForVideo, type VideoUrls } from "../../lib/url";

// VARIANTS (from lib/derivatives) is highest-first, which is the order the
// player sees them in <source> children — biasing its initial pick.

// Decides whether to serve MP4 or fall back to live HLS — and which variants
// to offer. Gated on the video_processing_steps table (state `ready`) AND the
// file still being present on disk, NOT bare file presence: a byte-complete but
// semantically-broken or hand-deleted MP4 is never served, so the viewer falls
// back to HLS automatically. The primary check follows the ACTIVE raw file
// (source.mp4 for unedited videos, {height}p.mp4 for edited ones) but keys
// readiness off the validated `source` step that produced it.
async function derivativeFlags(video: Video): Promise<{
  hasSource: boolean;
  variantHeights: number[];
  hasThumb: boolean;
  hasCaptions: boolean;
}> {
  const dir = join(DATA_DIR, video.id, "derivatives");
  const steps = await getStepStates(video.id);

  // Gate MP4 serving on the full mandatory set — the same bar reconcile uses to
  // reach `ready` — plus the active raw file on disk. Checking metadata too (not
  // just source) means a processing_failed video whose metadata step failed
  // serves HLS, instead of an MP4 with no dimensions.
  const mandatoryReady =
    steps.get("source")?.state === "ready" && steps.get("metadata")?.state === "ready";

  // This runs on every viewer request, so fan the independent file-existence
  // checks out in parallel rather than awaiting each in turn. Variant presence
  // is only checked for variants whose step row is already `ready`.
  const readyVariants = VARIANTS.filter((v) => steps.get(v.kind)?.state === "ready");
  const [activePresent, variantPresence, hasThumb, hasCaptionsSrt, hasCaptionsVtt] =
    await Promise.all([
      Bun.file(join(dir, activeRawFilename(video))).exists(),
      Promise.all(readyVariants.map((v) => Bun.file(join(dir, `${v.height}p.mp4`)).exists())),
      Bun.file(join(dir, "thumbnail.jpg")).exists(),
      Bun.file(join(dir, "captions.srt")).exists(),
      Bun.file(join(dir, "captions.vtt")).exists(),
    ]);

  const hasSource = mandatoryReady && activePresent;
  const variantHeights = readyVariants.filter((_, i) => variantPresence[i]).map((v) => v.height);

  return { hasSource, variantHeights, hasThumb, hasCaptions: hasCaptionsSrt || hasCaptionsVtt };
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
  chaptersUrl: string | null;
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
  const [{ hasSource, variantHeights, hasThumb, hasCaptions }, hasChapters] = await Promise.all([
    derivativeFlags(video),
    chaptersExist(video.id),
  ]);
  const urls = urlsForVideo(video);

  let src: string | null = null;
  let sources: SourceDescriptor[] | null = null;

  if (hasSource) {
    // Use DB aspect when available, else fall back to width/height, else
    // skip dimensions entirely (no Quality menu, but the player still
    // works).
    const aspect =
      video.aspectRatio ?? (video.width && video.height ? video.width / video.height : null);

    // urls.raw points to the correct "primary" file — source.mp4 for
    // unedited videos, or the resolution-named file (e.g. 1080p.mp4) for
    // edited videos. See activeRawFilename() in lib/url.ts.
    const sourceEntry: SourceDescriptor = { src: urls.raw, type: "video/mp4" };
    if (video.width && video.height) {
      sourceEntry.width = video.width;
      sourceEntry.height = video.height;
    }

    // Downscaled variants (only those that are a different resolution from
    // the source entry — for edited videos, the source-resolution file is
    // already the sourceEntry via urls.raw).
    const variantEntries: SourceDescriptor[] = variantHeights
      .filter((h) => h !== video.height)
      .map((height) => {
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
    // compatible <source> as the default, so when a 1080p variant exists
    // (i.e. source > 1080p) we promote it to first. Otherwise the source
    // entry leads — it is already ≤1080p in that case. Vidstack's Quality
    // menu sorts by data-width/height internally, so the visible menu
    // order is unchanged regardless of DOM order.
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
    captionsUrl: hasCaptions ? `/${video.slug}/captions.vtt` : null,
    chaptersUrl: hasChapters ? `/${video.slug}/chapters.vtt` : null,
  };
}
