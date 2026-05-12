import { raw } from "hono/html";
import { siteConfig } from "../../lib/site-config";
import { staticUrl } from "../../lib/static-assets";
import type { SourceDescriptor } from "../../routes/videos/resolve";
import { RootLayout } from "../layouts/RootLayout";

type Props = {
  slug: string;
  src: string | null;
  sources: SourceDescriptor[] | null;
  poster: string | null;
  captionsUrl: string | null;
  chaptersUrl: string | null;
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
  sources,
  poster,
  captionsUrl,
  chaptersUrl,
  title,
  description,
  duration,
  canonicalUrl,
  posterAbsolute,
}: Props) {
  const playerTitle = [title, duration].filter(Boolean).join(" · ");
  const pageTitle = title ?? siteConfig.defaultVideoTitle(slug);
  const ogDescription =
    description && description.length > 200 ? `${description.slice(0, 197)}...` : description;
  const defaultSourceUrl = sources?.[0]?.src ?? null;
  return (
    <RootLayout
      title={pageTitle}
      bodyClass="embed"
      head={
        <>
          <link rel="preconnect" href="https://cdn.vidstack.io" />
          <link rel="modulepreload" href="https://cdn.vidstack.io/player" />
          {defaultSourceUrl && (
            <link rel="preload" as="video" fetchpriority="high" href={defaultSourceUrl} />
          )}
          <link rel="stylesheet" href="https://cdn.vidstack.io/player/theme.css" />
          <link rel="stylesheet" href="https://cdn.vidstack.io/player/video.css" />
          <link rel="stylesheet" href={staticUrl("styles/player.css")} />
          <link rel="stylesheet" href={staticUrl("styles/embed.css")} />
          <script type="module" src="https://cdn.vidstack.io/player" />

          {/* Canonical points at the main video page, not the embed */}
          <link rel="canonical" href={canonicalUrl} />
          {description && <meta name="description" content={description} />}
          <meta name="author" content={siteConfig.authorName} />

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

          {/* Analytics */}
          <script async src="https://scripts.simpleanalyticscdn.com/latest.js" />
          <noscript>
            <img
              src="https://queue.simpleanalyticscdn.com/noscript.gif"
              alt=""
              referrerpolicy="no-referrer-when-downgrade"
            />
          </noscript>
        </>
      }
    >
      <media-player
        src={src ?? undefined}
        poster={poster ?? undefined}
        title={playerTitle || undefined}
        preload="auto"
        load="eager"
        playsinline
      >
        <media-provider>
          {sources?.map((s) => (
            <source
              src={s.src}
              type={s.type}
              data-width={s.width !== undefined ? String(s.width) : undefined}
              data-height={s.height !== undefined ? String(s.height) : undefined}
            />
          ))}
          {captionsUrl && (
            <track src={captionsUrl} kind="subtitles" srclang="en" label="English" default />
          )}
          {chaptersUrl && <track src={chaptersUrl} kind="chapters" srclang="en" default />}
          {poster && <media-poster class="vds-poster" src={poster} alt={title ?? ""} />}
        </media-provider>

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

        <media-video-layout thumbnails={`/${slug}/storyboard.vtt`} />
      </media-player>

      <script type="module">
        {raw(`customElements.whenDefined('media-video-layout').then(() => {
  const l = document.querySelector('media-video-layout');
  if (l) l.playbackRates = [0.75, 1, 1.2, 1.5, 2];
});
function parseT(v) {
  if (!v) return null;
  const hms = v.match(/^(?:(\\d+)h)?(?:(\\d+)m)?(?:(\\d+)s?)?$/);
  if (hms && (hms[1] || hms[2] || hms[3])) return (+(hms[1]||0))*3600 + (+(hms[2]||0))*60 + +(hms[3]||0);
  const col = v.match(/^(?:(\\d+):)?(\\d+):(\\d+)$/);
  if (col) return (+(col[1]||0))*3600 + (+col[2])*60 + +col[3];
  const n = parseFloat(v);
  return isFinite(n) && n >= 0 ? n : null;
}
const t = parseT(new URLSearchParams(location.search).get('t'));
if (t !== null) {
  const p = document.querySelector('media-player');
  p?.addEventListener('can-play', () => { p.currentTime = t; }, { once: true });
}`)}
      </script>
    </RootLayout>
  );
}
