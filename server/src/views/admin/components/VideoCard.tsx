import type { Video } from "../../../db/schema";

// Shared card component for both grid and table views. The containing
// element's `data-view` attribute controls the layout via CSS.
export function VideoCard({ video }: { video: Video }) {
  const title = video.title || video.slug;
  const duration = video.durationSeconds != null ? formatDuration(video.durationSeconds) : null;
  const date = formatDate(video.createdAt);

  return (
    <article class="video-card">
      <a href={`/admin/videos/${video.id}`} class="video-card-link">
        <div class="video-card-thumb" aria-hidden="true">
          <span class="video-card-thumb-letter">{title[0]?.toUpperCase()}</span>
        </div>
        <div class="video-card-body">
          <div class="video-card-title">{title}</div>
          <div class="video-card-meta">
            {duration && <span>{duration}</span>}
            <span class={`badge badge--${video.visibility}`}>{video.visibility}</span>
            {video.status !== "complete" && (
              <span class={`badge badge--${video.status}`}>{video.status}</span>
            )}
          </div>
          <time class="video-card-date" datetime={video.createdAt}>
            {date}
          </time>
        </div>
      </a>
    </article>
  );
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}
