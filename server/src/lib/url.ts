// Public URLs for a video, all keyed off its current slug. Centralised here
// so route handlers, JSON exports, and view templates never construct paths
// by hand — preventing drift if the URL shape ever changes.
//
// Slugs are validated at write time (see store.validateSlugFormat) so we
// trust the input here.
export type VideoUrls = {
  page: string;
  raw: string;
  hls: string;
  poster: string;
};

// The stable public name for "the MP4 of this video". It redirects to whatever
// the best rendition currently is, so a caller asking for the video doesn't have
// to know its height — and a link keeps working when a video is re-edited,
// re-encoded, or (later) watermarked. Asking for a smaller rendition stays
// explicit: /{slug}/raw/720p.mp4.
export const PUBLIC_VIDEO_FILENAME = "video.mp4";

export function publicVideoPath(slug: string): string {
  return `/${slug}/raw/${PUBLIC_VIDEO_FILENAME}`;
}

// The filename of the presentation master — the file viewers are served, named
// for the source's height (e.g. 1440p.mp4), whether or not the video has been
// edited. It carries the audio chain and any committed cut. source.mp4 is the
// pristine original and is never served publicly.
//
// NULL when the video has no cached height, which means no master can exist yet:
// metadata hasn't run, or it failed. Callers must handle that rather than
// substituting source.mp4 — this used to fall back to it, and the redirect
// handler then sent /raw/source.mp4 to itself in an infinite loop.
export function activeRawFilename(video: {
  lastEditedAt: string | null;
  height: number | null;
}): string | null {
  return video.height ? `${video.height}p.mp4` : null;
}

// Build viewer-facing URLs for a video. `raw` is the redirecting `video.mp4`
// entry point rather than a concrete rendition, so everything we publish (feeds,
// JSON, Markdown, oEmbed, llms.txt) names a URL that stays valid across
// re-encodes. The player is the exception — it gets concrete per-rendition URLs
// so playback never pays for a redirect (see resolve.ts).
export function urlsForVideo(video: {
  slug: string;
  lastEditedAt: string | null;
  height: number | null;
}): VideoUrls {
  return {
    page: `/${video.slug}`,
    raw: publicVideoPath(video.slug),
    hls: `/${video.slug}/stream/stream.m3u8`,
    poster: `/${video.slug}/poster.jpg`,
  };
}

// Returns the public base URL for constructing absolute URLs (clipboard,
// API responses). Reads `PUBLIC_URL` from the environment; falls back to
// `http://${HOST}:${PORT}` for local dev. Read at call time so `.env`
// changes take effect without restart.
export function getPublicBaseUrl(): string {
  if (Bun.env.PUBLIC_URL) return Bun.env.PUBLIC_URL.replace(/\/+$/, "");
  const host = Bun.env.HOST ?? "127.0.0.1";
  const port = Bun.env.PORT ?? "3000";
  return `http://${host}:${port}`;
}

// Absolute URL for a path (e.g. "/my-slug" → "https://loom.example.com/my-slug").
export function absoluteUrl(path: string): string {
  return `${getPublicBaseUrl()}${path}`;
}
