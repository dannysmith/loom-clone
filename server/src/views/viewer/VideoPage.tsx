import { raw } from "hono/html";
import { marked } from "marked";
import { formatDate, formatDuration } from "../../lib/format";
import type { Video } from "../../lib/store";
import { ViewerLayout } from "../layouts/ViewerLayout";

marked.setOptions({ breaks: true });

type Props = {
  video: Video;
  src: string;
  poster: string | null;
  canonicalUrl: string;
  posterAbsolute: string | null;
  embedAbsolute: string;
};

export function VideoPage({
  video,
  src,
  poster,
  canonicalUrl,
  posterAbsolute,
  embedAbsolute,
}: Props) {
  const pageTitle = video.title ?? `Video ${video.slug}`;
  const description = video.description ?? undefined;
  const duration = formatDuration(video.durationSeconds);
  const date = formatDate(video.completedAt ?? video.createdAt);
  const noindex = video.visibility !== "public";

  return (
    <ViewerLayout
      title={pageTitle}
      head={
        <>
          <link rel="stylesheet" href="https://cdn.vidstack.io/player/theme.css" />
          <link rel="stylesheet" href="https://cdn.vidstack.io/player/video.css" />
          <link rel="stylesheet" href="/static/styles/player.css" />
          <link rel="stylesheet" href="/static/styles/viewer.css" />
          <script type="module" src="https://cdn.vidstack.io/player" />

          {/* Canonical + robots */}
          <link rel="canonical" href={canonicalUrl} />
          {noindex && <meta name="robots" content="noindex" />}
          {description && <meta name="description" content={description} />}

          {/* Open Graph */}
          <meta property="og:type" content="video.other" />
          <meta property="og:title" content={pageTitle} />
          <meta property="og:url" content={canonicalUrl} />
          {description && <meta property="og:description" content={description} />}
          {posterAbsolute && <meta property="og:image" content={posterAbsolute} />}
          <meta property="og:video" content={embedAbsolute} />
          <meta property="og:video:type" content="text/html" />
          <meta property="og:video:width" content="1280" />
          <meta property="og:video:height" content="720" />

          {/* Twitter Card */}
          <meta name="twitter:card" content="player" />
          <meta name="twitter:title" content={pageTitle} />
          {description && <meta name="twitter:description" content={description} />}
          {posterAbsolute && <meta name="twitter:image" content={posterAbsolute} />}
          <meta name="twitter:player" content={embedAbsolute} />
          <meta name="twitter:player:width" content="1280" />
          <meta name="twitter:player:height" content="720" />

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
      <media-player src={src} poster={poster ?? undefined} playsinline>
        <media-provider />
        <media-video-layout />
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
                </svg>
                {" "}
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
