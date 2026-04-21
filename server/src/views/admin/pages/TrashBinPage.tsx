import type { Video } from "../../../db/schema";
import { AdminLayout } from "../../layouts/AdminLayout";

type Props = {
  videos: Video[];
  view: string;
};

export function TrashBinPage({ videos, view }: Props) {
  return (
    <AdminLayout title="Trash" activePage="trash">
      <div class="page-header">
        <h1>Trash</h1>
      </div>

      {videos.length === 0 ? (
        <p class="empty-state">Trash is empty.</p>
      ) : (
        <div id="video-list" data-view={view}>
          <div class="video-list-items">
            {videos.map((v) => (
              <TrashCard video={v} />
            ))}
          </div>
        </div>
      )}
    </AdminLayout>
  );
}

function TrashCard({ video }: { video: Video }) {
  const title = video.title || video.slug;
  const duration =
    video.durationSeconds != null
      ? `${Math.floor(video.durationSeconds / 60)}:${Math.round(video.durationSeconds % 60)
          .toString()
          .padStart(2, "0")}`
      : null;

  return (
    <article class="video-card">
      <div class="video-card-link">
        <div class="video-card-thumb" aria-hidden="true">
          <span class="video-card-thumb-letter">{title[0]?.toUpperCase()}</span>
        </div>
        <div class="video-card-body">
          <div class="video-card-title">{title}</div>
          <div class="video-card-meta">
            {duration && <span>{duration}</span>}
            <span class="badge badge--private">trashed</span>
          </div>
          <div class="video-card-actions">
            <form method="post" action={`/admin/videos/${video.id}/untrash`}>
              <button type="submit" class="btn btn--sm btn--primary">
                Restore
              </button>
            </form>
          </div>
        </div>
      </div>
    </article>
  );
}
