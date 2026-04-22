import { RootLayout } from "../layouts/RootLayout";

type Props = {
  slug: string;
  src: string;
  poster: string | null;
  title?: string;
  description?: string;
  duration?: string;
  canonicalUrl: string;
  posterAbsolute: string | null;
};

// Chromeless player for iframe embeds. Custom overlay shows title, duration,
// and play button before first play; hides once playback starts.
// Vidstack's data-started attribute on <media-player> drives visibility via CSS.
export function EmbedPage({
  slug,
  src,
  poster,
  title,
  description,
  duration,
  canonicalUrl,
  posterAbsolute,
}: Props) {
  const playerTitle = [title, duration].filter(Boolean).join(" · ");
  const pageTitle = title ?? `Video ${slug}`;
  const ogDescription =
    description && description.length > 200 ? `${description.slice(0, 197)}...` : description;
  return (
    <RootLayout
      title={pageTitle}
      bodyClass="embed"
      head={
        <>
          <link rel="preconnect" href="https://cdn.vidstack.io" />
          <link rel="stylesheet" href="https://cdn.vidstack.io/player/theme.css" />
          <link rel="stylesheet" href="https://cdn.vidstack.io/player/video.css" />
          <link rel="stylesheet" href="/static/styles/player.css" />
          <link rel="stylesheet" href="/static/styles/embed.css" />
          <script type="module" src="https://cdn.vidstack.io/player" />

          {/* Canonical points at the main video page, not the embed */}
          <link rel="canonical" href={canonicalUrl} />
          {description && <meta name="description" content={description} />}
          <meta name="author" content="Danny Smith" />

          {/* OG tags — so an accidentally-pasted embed URL still gets a rich preview */}
          <meta property="og:type" content="video.other" />
          <meta property="og:title" content={pageTitle} />
          <meta property="og:url" content={canonicalUrl} />
          {ogDescription && <meta property="og:description" content={ogDescription} />}
          {posterAbsolute && <meta property="og:image" content={posterAbsolute} />}

          {/* Twitter Card */}
          <meta name="twitter:card" content="summary_large_image" />
          <meta name="twitter:title" content={pageTitle} />
          {ogDescription && <meta name="twitter:description" content={ogDescription} />}
          {posterAbsolute && <meta name="twitter:image" content={posterAbsolute} />}
        </>
      }
    >
      <media-player
        src={src}
        poster={poster ?? undefined}
        title={playerTitle || undefined}
        playsinline
      >
        <media-provider />

        {(title || duration) && (
          <div class="embed-overlay">
            <button
              type="button"
              class="embed-play-btn"
              onclick="this.closest('media-player').play()"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="28"
                height="28"
                viewBox="0 0 24 24"
                fill="currentColor"
                stroke="none"
                aria-hidden="true"
              >
                <polygon points="6 3 20 12 6 21 6 3" />
              </svg>
            </button>
            <div class="embed-info">
              {title && <div class="embed-title">{title}</div>}
              {duration && (
                <div class="embed-duration">
                  <svg
                    class="viewer-icon"
                    xmlns="http://www.w3.org/2000/svg"
                    width="12"
                    height="12"
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
                  {duration}
                </div>
              )}
            </div>
          </div>
        )}

        <media-video-layout />
      </media-player>
    </RootLayout>
  );
}
