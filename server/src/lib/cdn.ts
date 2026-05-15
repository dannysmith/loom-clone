// CDN cache purging for BunnyCDN. Fire-and-forget — purge failures are logged
// but never block the caller. When BUNNY_CDN_API_KEY is unset (dev, tests),
// all purge calls silently no-op.

import { getPublicBaseUrl } from "./url";

const GLOBAL_FEED_PATHS = ["/sitemap.xml", "/feed.xml", "/feed.json", "/llms.txt"];

async function purgeUrl(url: string): Promise<void> {
  const apiKey = Bun.env.BUNNY_CDN_API_KEY;
  if (!apiKey) return;
  try {
    const res = await fetch(`https://api.bunny.net/purge?url=${encodeURIComponent(url)}`, {
      method: "POST",
      headers: { AccessKey: apiKey, "Content-Length": "0" },
    });
    if (!res.ok) {
      console.warn(`[cdn] purge failed for ${url}: ${res.status}`);
    }
  } catch (err) {
    console.warn(`[cdn] purge error for ${url}:`, err);
  }
}

// Purge all cached content for a video (wildcard) + global feeds.
export function purgeVideo(slug: string): void {
  const base = getPublicBaseUrl();
  purgeUrl(`${base}/${slug}/*`);
  purgeGlobalFeeds();
}

// Purge global feeds/sitemap (video added, removed, or visibility changed).
export function purgeGlobalFeeds(): void {
  const base = getPublicBaseUrl();
  for (const path of GLOBAL_FEED_PATHS) {
    purgeUrl(`${base}${path}`);
  }
}

// Purge both old and new slug paths after a rename.
export function purgeSlugRename(oldSlug: string, newSlug: string): void {
  const base = getPublicBaseUrl();
  purgeUrl(`${base}/${oldSlug}/*`);
  purgeUrl(`${base}/${newSlug}/*`);
  purgeGlobalFeeds();
}

// Purge the tag page + its feeds. Used when a tag's content/visibility/slug
// changes, or when a video is added/removed from a tag. Also purges the
// sitemap since tag pages appear there.
export function purgeTag(slug: string): void {
  const base = getPublicBaseUrl();
  // Explicit URLs rather than a wildcard: tag pages live at the bare `/:slug`
  // path (which a `/${slug}/*` wildcard wouldn't match) plus the two feed
  // sub-paths. Sitemap is purged because public tags appear in it.
  purgeUrl(`${base}/${slug}`);
  purgeUrl(`${base}/${slug}/feed.xml`);
  purgeUrl(`${base}/${slug}/feed.json`);
  purgeUrl(`${base}/sitemap.xml`);
}
