import type { Video } from "../../../db/schema";
import { formatDate, formatDurationShort } from "../../../lib/format";
import {
  IconCopy,
  IconDownload,
  IconDuplicate,
  IconEllipsis,
  IconExternalLink,
  IconTrash,
  VisibilityBadge,
} from "./Icons";

type Props = {
  video: Video;
  mode?: "default" | "trash";
};

// Shared card component for both grid and table views. The containing
// element's `data-view` attribute controls the layout via CSS.
// In trash mode, the popover menu is replaced with a Restore button.
export function VideoCard({ video, mode = "default" }: Props) {
  const title = video.title || video.slug;
  const duration = formatDurationShort(video.durationSeconds);
  const date = formatDate(video.createdAt);
  const thumbSrc = `/admin/videos/${video.id}/media/poster.jpg`;
  const isPublicOrUnlisted = video.visibility !== "private";
  const popoverId = `menu-${video.id}`;

  return (
    <article class="video-card">
      <a href={`/admin/videos/${video.id}`} class="video-card-link">
        <div class="video-card-thumb">
          <img src={thumbSrc} alt="" loading="lazy" class="video-card-thumb-img" />
          <span class="video-card-thumb-letter" aria-hidden="true">
            {title[0]?.toUpperCase()}
          </span>
        </div>
        <div class="video-card-body">
          <div class="video-card-title">{title}</div>
          <div class="video-card-meta">
            {duration && <span>{duration}</span>}
            {mode === "trash" ? (
              <span class="badge badge--private">trashed</span>
            ) : (
              <>
                <VisibilityBadge visibility={video.visibility} />
                {video.status !== "complete" && (
                  <span class={`badge badge--${video.status}`}>{video.status}</span>
                )}
              </>
            )}
          </div>
          <time class="video-card-date" datetime={video.createdAt}>
            {date}
          </time>
        </div>
      </a>
      {mode === "trash" ? (
        <div class="video-card-menu-anchor">
          <form method="post" action={`/admin/videos/${video.id}/untrash`}>
            <button type="submit" class="btn btn--sm btn--primary">
              Restore
            </button>
          </form>
        </div>
      ) : (
        <div class="video-card-menu-anchor">
          <button
            type="button"
            class="video-card-menu-btn"
            popovertarget={popoverId}
            aria-label="Video actions"
          >
            <IconEllipsis size={14} />
          </button>
          <div id={popoverId} popover="auto" class="video-card-popover">
            {isPublicOrUnlisted && (
              <>
                <a href={`/${video.slug}`} target="_blank" rel="noopener" class="popover-item">
                  <IconExternalLink size={14} /> Open public URL
                </a>
                <button
                  type="button"
                  class="popover-item"
                  onclick={`copyToClipboard('/${video.slug}');this.closest('[popover]').hidePopover()`}
                >
                  <IconCopy size={14} /> Copy public URL
                </button>
              </>
            )}
            <a
              href={`/admin/videos/${video.id}/media/raw/source.mp4`}
              download
              class="popover-item"
            >
              <IconDownload size={14} /> Download
            </a>
            <form method="post" action={`/admin/videos/${video.id}/duplicate`}>
              <button type="submit" class="popover-item">
                <IconDuplicate size={14} /> Duplicate
              </button>
            </form>
            <form
              method="post"
              action={`/admin/videos/${video.id}/trash`}
              hx-confirm="Move this video to trash?"
            >
              <button type="submit" class="popover-item popover-item--danger">
                <IconTrash size={14} /> Trash
              </button>
            </form>
          </div>
        </div>
      )}
    </article>
  );
}
