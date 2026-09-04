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

// The filename of the "active" raw MP4 for a video — the file viewers should
// see. Always the presentation master, named for the source's height (e.g.
// 1440p.mp4), whether or not the video has been edited: it's the file carrying
// the audio chain and any committed cut. source.mp4 is the pristine original and
// is never served publicly.
//
// Falls back to source.mp4 only when the height isn't cached yet — a video that
// hasn't reached the metadata step, where nothing is servable anyway (the
// serving gate keys on the `presentation` step, so this fallback never becomes a
// URL a viewer follows).
export function activeRawFilename(video: {
  lastEditedAt: string | null;
  height: number | null;
}): string {
  return video.height ? `${video.height}p.mp4` : "source.mp4";
}

// Build viewer-facing URLs for a video. Uses activeRawFilename to point
// `raw` at the correct file (edited or original).
export function urlsForVideo(video: {
  slug: string;
  lastEditedAt: string | null;
  height: number | null;
}): VideoUrls {
  const filename = activeRawFilename(video);
  return {
    page: `/${video.slug}`,
    raw: `/${video.slug}/raw/${filename}`,
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
