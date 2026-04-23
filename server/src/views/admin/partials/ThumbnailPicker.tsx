import type { Video } from "../../../db/schema";
import type { ThumbnailCandidate } from "../../../lib/thumbnails";

type Props = {
  video: Video;
  candidates: ThumbnailCandidate[];
};

export function ThumbnailPicker({ video, candidates }: Props) {
  if (candidates.length === 0) {
    return (
      <div id="thumbnail-picker" class="thumbnail-picker">
        <h3>Thumbnail</h3>
        <p class="empty-state">
          No thumbnail candidates available. Derivatives may still be processing.
        </p>
        <UploadForm videoId={video.id} />
      </div>
    );
  }

  return (
    <div id="thumbnail-picker" class="thumbnail-picker">
      <h3>Thumbnail</h3>
      <div class="thumbnail-grid">
        {candidates.map((c) => (
          <button
            type="button"
            class={`thumbnail-candidate ${c.promoted ? "thumbnail-candidate--promoted" : ""}`}
            hx-post={`/admin/videos/${video.id}/thumbnail/promote`}
            hx-vals={JSON.stringify({ candidateId: c.id })}
            hx-target="#thumbnail-picker"
            hx-swap="outerHTML"
            title={c.promoted ? "Currently active" : `Promote ${c.id}`}
          >
            <img
              src={`/admin/videos/${video.id}/media/thumbnail-candidates/${c.filename}`}
              alt={c.id}
              loading="lazy"
            />
            {c.promoted && <span class="thumbnail-badge">Active</span>}
            <span class="thumbnail-label">{c.kind}</span>
          </button>
        ))}
      </div>
      <UploadForm videoId={video.id} />
    </div>
  );
}

function UploadForm({ videoId }: { videoId: string }) {
  return (
    <form
      class="thumbnail-upload"
      hx-post={`/admin/videos/${videoId}/thumbnail/upload`}
      hx-target="#thumbnail-picker"
      hx-swap="outerHTML"
      hx-encoding="multipart/form-data"
    >
      <label class="btn btn--sm btn--secondary">
        Upload custom thumbnail
        <input
          type="file"
          name="thumbnail"
          accept="image/jpeg,image/png"
          hidden
          onchange="this.closest('form').requestSubmit()"
        />
      </label>
    </form>
  );
}
