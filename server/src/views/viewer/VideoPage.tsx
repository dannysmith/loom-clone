import { raw } from "hono/html";
import { marked } from "marked";
import { formatDate, formatDuration, formatDurationIso } from "../../lib/format";
import type { Video } from "../../lib/store";
import { absoluteUrl } from "../../lib/url";
import { ViewerLayout } from "../layouts/ViewerLayout";

marked.setOptions({ breaks: true });

type Props = {
  video: Video;
  src: string;
  poster: string | null;
  canonicalUrl: string;
  posterAbsolute: string | null;
  embedAbsolute: string;
  adminUrl: string | null;
};

export function VideoPage({
  video,
  src,
  poster,
  canonicalUrl,
  posterAbsolute,
  embedAbsolute,
  adminUrl,
}: Props) {
  const pageTitle = video.title ?? `Video ${video.slug}`;
  const description = video.description ?? undefined;
  const ogDescription =
    description && description.length > 200 ? `${description.slice(0, 197)}...` : description;
  const duration = formatDuration(video.durationSeconds);
  const isoDuration = formatDurationIso(video.durationSeconds);
  const date = formatDate(video.completedAt ?? video.createdAt);
  const uploadDate = video.completedAt ?? video.createdAt;
  const noindex = video.visibility !== "public";

  // JSON-LD VideoObject structured data
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "VideoObject",
    name: pageTitle,
    ...(description && { description }),
    ...(posterAbsolute && { thumbnailUrl: posterAbsolute }),
    uploadDate,
    ...(isoDuration && { duration: isoDuration }),
    contentUrl: absoluteUrl(src),
    embedUrl: embedAbsolute,
    ...(video.width &&
      video.height && {
        width: video.width,
        height: video.height,
      }),
    author: {
      "@type": "Person",
      name: "Danny Smith",
      url: "https://danny.is",
    },
  };

  return (
    <ViewerLayout
      title={pageTitle}
      head={
        <>
          <link rel="preconnect" href="https://cdn.vidstack.io" />
          <link rel="stylesheet" href="https://cdn.vidstack.io/player/theme.css" />
          <link rel="stylesheet" href="https://cdn.vidstack.io/player/video.css" />
          <link rel="stylesheet" href="/static/styles/player.css" />
          <link rel="stylesheet" href="/static/styles/viewer.css" />
          <script type="module" src="https://cdn.vidstack.io/player" />

          {/* Canonical + robots */}
          <link rel="canonical" href={canonicalUrl} />
          {noindex && <meta name="robots" content="noindex" />}
          {description && <meta name="description" content={description} />}
          <meta name="author" content="Danny Smith" />

          {/* Open Graph */}
          <meta property="og:type" content="video.other" />
          <meta property="og:title" content={pageTitle} />
          <meta property="og:url" content={canonicalUrl} />
          {ogDescription && <meta property="og:description" content={ogDescription} />}
          {posterAbsolute && <meta property="og:image" content={posterAbsolute} />}
          <meta property="og:video" content={embedAbsolute} />
          <meta property="og:video:type" content="text/html" />
          <meta property="og:video:width" content="1280" />
          <meta property="og:video:height" content="720" />

          {/* Twitter Card */}
          <meta name="twitter:card" content="player" />
          <meta name="twitter:title" content={pageTitle} />
          {ogDescription && <meta name="twitter:description" content={ogDescription} />}
          {posterAbsolute && <meta name="twitter:image" content={posterAbsolute} />}
          <meta name="twitter:player" content={embedAbsolute} />
          <meta name="twitter:player:width" content="1280" />
          <meta name="twitter:player:height" content="720" />

          {/* Structured data */}
          <script type="application/ld+json">{raw(JSON.stringify(jsonLd))}</script>

          {/* oEmbed discovery */}
          <link
            rel="alternate"
            type="application/json+oembed"
            href={`/oembed?url=${encodeURIComponent(canonicalUrl)}&format=json`}
            title={pageTitle}
          />
        </>
      }
    >
      {adminUrl && (
        <a href={adminUrl} class="viewer-admin-link">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
          Admin
        </a>
      )}

      <media-player src={src} poster={poster ?? undefined} playsinline>
        <media-provider />
        <media-video-layout thumbnails={`/${video.slug}/storyboard.vtt`} />
      </media-player>

      <div class="viewer-meta">
        {video.title && <h1 class="viewer-title">{video.title}</h1>}
        {(duration || date) && (
          <p class="viewer-details">
            {duration && (
              <>
                <svg
                  class="viewer-icon"
                  xmlns="http://www.w3.org/2000/svg"
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <circle cx="12" cy="12" r="10" />
                  <polyline points="12 6 12 12 16 14" />
                </svg>{" "}
                {duration}
              </>
            )}
            {duration && date && " · "}
            {date}
          </p>
        )}
        {video.description && (
          <div class="viewer-description">{raw(marked.parse(video.description) as string)}</div>
        )}
        <p class="viewer-attribution">
          <a href="https://danny.is" rel="noopener noreferrer" target="_blank">
            danny.is
          </a>
        </p>
      </div>
    </ViewerLayout>
  );
}
