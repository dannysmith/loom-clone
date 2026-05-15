import { raw } from "hono/html";
import { marked } from "marked";
import type { Tag, Video } from "../../db/schema";
import { formatDate, formatDurationShort } from "../../lib/format";
import { siteConfig } from "../../lib/site-config";
import { staticUrl } from "../../lib/static-assets";
import { absoluteUrl } from "../../lib/url";
import { ViewerLayout } from "../layouts/ViewerLayout";

marked.setOptions({ breaks: true });

type Props = {
  tag: Tag;
  videos: Video[];
  canonicalUrl: string;
  feedXmlUrl: string;
  feedJsonUrl: string;
};

export function TagPage({ tag, videos, canonicalUrl, feedXmlUrl, feedJsonUrl }: Props) {
  const pageTitle = `${tag.name} · ${siteConfig.name}`;
  const description = tag.description ?? undefined;
  const ogDescription =
    description && description.length > 200 ? `${description.slice(0, 197)}...` : description;
  const noindex = tag.visibility !== "public";

  return (
    <ViewerLayout
      title={pageTitle}
      head={
        <>
          <link rel="stylesheet" href={staticUrl("styles/viewer.css")} />

          <link rel="canonical" href={canonicalUrl} />
          {noindex && <meta name="robots" content="noindex" />}
          {description && <meta name="description" content={description} />}
          <meta name="author" content={siteConfig.authorName} />

          <meta property="og:type" content="website" />
          <meta property="og:title" content={tag.name} />
          <meta property="og:url" content={canonicalUrl} />
          {ogDescription && <meta property="og:description" content={ogDescription} />}

          <meta name="twitter:card" content="summary" />
          <meta name="twitter:title" content={tag.name} />
          {ogDescription && <meta name="twitter:description" content={ogDescription} />}

          {/* Feed discovery — both the tag's own feeds and the site feeds. */}
          <link
            rel="alternate"
            type="application/rss+xml"
            href={feedXmlUrl}
            title={`${tag.name} — ${siteConfig.name}`}
          />
          <link
            rel="alternate"
            type="application/feed+json"
            href={feedJsonUrl}
            title={`${tag.name} — ${siteConfig.name}`}
          />
          <link
            rel="alternate"
            type="application/rss+xml"
            href="/feed.xml"
            title={siteConfig.name}
          />

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
      <header class="tag-header">
        <h1 class="tag-title">
          <span
            class="tag-swatch"
            style={`background-color: var(--tag-${tag.color})`}
            aria-hidden="true"
          />
          {tag.name}
        </h1>
        {tag.description && (
          <div class="tag-description">{raw(marked.parse(tag.description) as string)}</div>
        )}
      </header>

      {videos.length === 0 ? (
        <p class="tag-empty">No videos tagged with this yet.</p>
      ) : (
        <ul class="tag-video-grid">
          {videos.map((v) => (
            <VideoTile video={v} />
          ))}
        </ul>
      )}

      <p class="viewer-attribution">
        <a href={siteConfig.authorUrl} rel="noopener noreferrer" target="_blank">
          {siteConfig.authorUrl.replace(/^https?:\/\//, "")}
        </a>
      </p>
    </ViewerLayout>
  );
}

function VideoTile({ video }: { video: Video }) {
  const title = video.title ?? siteConfig.defaultVideoTitle(video.slug);
  const duration = formatDurationShort(video.durationSeconds);
  const date = formatDate(video.completedAt ?? video.createdAt);
  const href = `/${video.slug}`;
  const poster = `/${video.slug}/poster.jpg`;

  return (
    <li class="tag-video-tile">
      <a href={href} class="tag-video-link">
        <div class="tag-video-thumb">
          <img src={poster} alt="" loading="lazy" />
          {duration && <span class="tag-video-duration">{duration}</span>}
        </div>
        <div class="tag-video-body">
          <span class="tag-video-title">{title}</span>
          {date && (
            <time class="tag-video-date" datetime={video.completedAt ?? video.createdAt}>
              {date}
            </time>
          )}
        </div>
      </a>
    </li>
  );
}

// Build the absolute canonical URL for a tag page given its current slug.
export function tagCanonicalUrl(slug: string): string {
  return absoluteUrl(`/${slug}`);
}
