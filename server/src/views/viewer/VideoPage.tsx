import { raw } from "hono/html";
import { marked } from "marked";
import type { Tag } from "../../db/schema";
import { formatDate, formatDuration, formatDurationIso } from "../../lib/format";
import { siteConfig } from "../../lib/site-config";
import type { Video } from "../../lib/store";
import { absoluteUrl, activeRawFilename } from "../../lib/url";
import type { SourceDescriptor } from "../../routes/videos/resolve";
import { ViewerLayout } from "../layouts/ViewerLayout";
import { AgentDirective } from "./AgentDirective";
import { CalendarIcon, ClockIcon, SettingsIcon, TagIcon } from "./icons";
import { SiteFooter } from "./SiteFooter";

marked.setOptions({ breaks: true });

type Props = {
  video: Video;
  tags: Tag[];
  src: string | null;
  sources: SourceDescriptor[] | null;
  poster: string | null;
  captionsUrl: string | null;
  chaptersUrl: string | null;
  canonicalUrl: string;
  posterAbsolute: string | null;
  embedAbsolute: string;
  adminUrl: string | null;
};

export function VideoPage({
  video,
  tags,
  src,
  sources,
  poster,
  captionsUrl,
  chaptersUrl,
  canonicalUrl,
  posterAbsolute,
  embedAbsolute,
  adminUrl,
}: Props) {
  // contentUrl for JSON-LD points at the active raw file (source.mp4 for
  // unedited videos, the resolution file for edited ones).
  const rawFilename = activeRawFilename(video);
  const rawUrl = `/${video.slug}/raw/${rawFilename}`;
  const contentUrl = sources?.find((s) => s.src === rawUrl)?.src ?? sources?.[0]?.src ?? src;
  const defaultSourceUrl = sources?.[0]?.src ?? null;
  const pageTitle = video.title ?? siteConfig.defaultVideoTitle(video.slug);
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
    ...(contentUrl && { contentUrl: absoluteUrl(contentUrl) }),
    embedUrl: embedAbsolute,
    ...(video.width &&
      video.height && {
        width: video.width,
        height: video.height,
      }),
    author: {
      "@type": "Person",
      name: siteConfig.authorName,
      url: siteConfig.authorUrl,
    },
  };

  return (
    <ViewerLayout
      title={pageTitle}
      head={
        <>
          <link rel="preconnect" href="https://cdn.vidstack.io" />
          <link rel="modulepreload" href="https://cdn.vidstack.io/player" />
          {defaultSourceUrl && (
            <link rel="preload" as="video" fetchpriority="high" href={defaultSourceUrl} />
          )}
          <link rel="stylesheet" href="https://cdn.vidstack.io/player/theme.css" />
          <link rel="stylesheet" href="https://cdn.vidstack.io/player/video.css" />
          <script type="module" src="https://cdn.vidstack.io/player" />

          {/* Canonical + robots */}
          <link rel="canonical" href={canonicalUrl} />
          {noindex && <meta name="robots" content="noindex" />}
          {description && <meta name="description" content={description} />}
          <meta name="author" content={siteConfig.authorName} />

          {/* Open Graph */}
          <meta property="og:type" content="video.other" />
          <meta property="og:title" content={pageTitle} />
          <meta property="og:url" content={canonicalUrl} />
          {ogDescription && <meta property="og:description" content={ogDescription} />}
          {posterAbsolute && <meta property="og:image" content={posterAbsolute} />}
          <meta property="og:video" content={embedAbsolute} />
          <meta property="og:video:type" content="text/html" />
          <meta
            property="og:video:width"
            content={String(siteConfig.defaultOgEmbedDimensions.width)}
          />
          <meta
            property="og:video:height"
            content={String(siteConfig.defaultOgEmbedDimensions.height)}
          />

          {/* Twitter Card */}
          <meta name="twitter:card" content="player" />
          <meta name="twitter:title" content={pageTitle} />
          {ogDescription && <meta name="twitter:description" content={ogDescription} />}
          {posterAbsolute && <meta name="twitter:image" content={posterAbsolute} />}
          <meta name="twitter:player" content={embedAbsolute} />
          <meta
            name="twitter:player:width"
            content={String(siteConfig.defaultOgEmbedDimensions.width)}
          />
          <meta
            name="twitter:player:height"
            content={String(siteConfig.defaultOgEmbedDimensions.height)}
          />

          {/* Structured data */}
          <script type="application/ld+json">{raw(JSON.stringify(jsonLd))}</script>

          {/* Markdown alternate for agents */}
          <link rel="alternate" type="text/markdown" href={`/${video.slug}.md`} title={pageTitle} />

          {/* oEmbed discovery */}
          <link
            rel="alternate"
            type="application/json+oembed"
            href={`/oembed?url=${encodeURIComponent(canonicalUrl)}&format=json`}
            title={pageTitle}
          />

          {/* Feed discovery */}
          <link
            rel="alternate"
            type="application/rss+xml"
            href="/feed.xml"
            title={siteConfig.name}
          />
          <link
            rel="alternate"
            type="application/feed+json"
            href="/feed.json"
            title={siteConfig.name}
          />

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
      <AgentDirective mdUrl={`/${video.slug}.md`} />

      {adminUrl && (
        <a href={adminUrl} class="viewer-admin-link">
          <SettingsIcon size={14} />
          Admin
        </a>
      )}

      {/* Header: title + meta row above the player */}
      <header class="viewer-header">
        {video.title && <h1 class="viewer-title">{video.title}</h1>}
        {(duration || date || tags.length > 0) && (
          <div class="viewer-meta-row">
            {duration && (
              <span class="viewer-meta-item">
                <ClockIcon size={14} />
                {duration}
              </span>
            )}
            {duration && date && <span class="viewer-meta-separator">·</span>}
            {date && (
              <span class="viewer-meta-item">
                <CalendarIcon size={14} />
                {date}
              </span>
            )}
            {tags.length > 0 && (
              <>
                <span class="viewer-meta-separator">·</span>
                <span class="viewer-meta-tags">
                  {tags.map((t) => (
                    <a
                      class="viewer-tag-chip"
                      href={`/${t.slug}`}
                      style={`--chip-bg: var(--tag-${t.color}-bg); --chip-fg: var(--tag-${t.color}-fg)`}
                    >
                      <TagIcon size={12} />
                      {t.name}
                    </a>
                  ))}
                </span>
              </>
            )}
          </div>
        )}
      </header>

      <media-player
        src={src ?? undefined}
        poster={poster ?? undefined}
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
          {poster && <media-poster class="vds-poster" src={poster} alt={video.title ?? ""} />}
        </media-provider>
        <media-video-layout
          thumbnails={`/${video.slug}/storyboard.vtt`}
          download={absoluteUrl(rawUrl)}
        />
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

      {video.description && (
        <div class="viewer-body">
          <div class="viewer-description">{raw(marked.parse(video.description) as string)}</div>
        </div>
      )}

      <SiteFooter />
    </ViewerLayout>
  );
}
