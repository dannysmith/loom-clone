import type { Video } from "../../../db/schema";
import type { ThumbnailCandidate } from "../../../lib/thumbnails";
import { IconFileImage, IconUpload } from "../components/Icons";

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
        <ThumbnailActions videoId={video.id} />
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
      <ThumbnailActions videoId={video.id} />
    </div>
  );
}

function ThumbnailActions({ videoId }: { videoId: string }) {
  return (
    <div class="thumbnail-actions">
      <form
        class="thumbnail-upload"
        hx-post={`/admin/videos/${videoId}/thumbnail/upload`}
        hx-target="#thumbnail-picker"
        hx-swap="outerHTML"
        hx-encoding="multipart/form-data"
      >
        <label class="btn btn--sm btn--secondary">
          <IconUpload size={14} />
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
      <a href={`/admin/videos/${videoId}/cover`} class="btn btn--sm btn--secondary">
        <IconFileImage size={14} />
        Open cover editor
      </a>
    </div>
  );
}
