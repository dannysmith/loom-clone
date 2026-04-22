import { RootLayout } from "../layouts/RootLayout";

type Props = {
  slug: string;
  src: string;
  poster: string | null;
  title?: string;
  duration?: string;
};

// Chromeless player for iframe embeds. Custom overlay shows title, duration,
// and play button before first play; hides once playback starts.
// Vidstack's data-started attribute on <media-player> drives visibility via CSS.
export function EmbedPage({ slug, src, poster, title, duration }: Props) {
  const playerTitle = [title, duration].filter(Boolean).join(" · ");
  return (
    <RootLayout
      title={`Video ${slug} — embed`}
      bodyClass="embed"
      head={
        <>
          <link rel="stylesheet" href="https://cdn.vidstack.io/player/theme.css" />
          <link rel="stylesheet" href="https://cdn.vidstack.io/player/video.css" />
          <link rel="stylesheet" href="/static/styles/player.css" />
          <link rel="stylesheet" href="/static/styles/embed.css" />
          <script type="module" src="https://cdn.vidstack.io/player" />
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
