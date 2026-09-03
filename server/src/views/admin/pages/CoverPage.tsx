import type { Video } from "../../../db/schema";
import { siteConfig } from "../../../lib/site-config";
import { staticUrl } from "../../../lib/static-assets";
import { absoluteUrl, urlsForVideo } from "../../../lib/url";
import { RootLayout } from "../../layouts/RootLayout";
import { AdminClientAssets } from "../components/AdminClientAssets";

// Shell for the React cover-image generator. Two groups of data attributes:
// the video's own fields, and the author identity the cover renders — which
// `site-config.ts` owns, so the tool never hardcodes a name or avatar.
export function CoverPage({ video }: { video: Video }) {
  const tabTitle = video.title || video.slug;
  // The active poster (current promoted thumbnail). Served by the admin media
  // route; 404s if no thumbnail.jpg exists yet, but the cover generator still
  // operates — just with an empty image slot.
  const currentThumbnailUrl = `/admin/videos/${video.id}/media/poster.jpg`;

  return (
    <RootLayout title={`Cover · ${tabTitle}`} head={<AdminClientAssets entry="cover" />}>
      <div
        id="cover-root"
        data-video-id={video.id}
        data-video-slug={video.slug}
        data-video-title={video.title ?? ""}
        data-video-public-url={absoluteUrl(urlsForVideo(video).page)}
        data-video-thumbnail-url={currentThumbnailUrl}
        data-author-name={siteConfig.authorName}
        data-author-handle={siteConfig.authorHandle}
        data-author-avatar={staticUrl(siteConfig.authorAvatar.replace(/^\/static\//, ""))}
      />
    </RootLayout>
  );
}
