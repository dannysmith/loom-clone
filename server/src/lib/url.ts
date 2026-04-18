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
