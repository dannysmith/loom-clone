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

export function urlsForSlug(slug: string): VideoUrls {
  return {
    page: `/${slug}`,
    raw: `/${slug}/raw/source.mp4`,
    hls: `/${slug}/stream/stream.m3u8`,
    poster: `/${slug}/poster.jpg`,
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
