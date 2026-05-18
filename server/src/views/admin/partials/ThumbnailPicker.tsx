import type { Video } from "../../../db/schema";
import type { ThumbnailCandidate } from "../../../lib/thumbnails";
import { IconFileImage, IconTrash, IconUpload } from "../components/Icons";

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
          <div class={`thumbnail-candidate ${c.promoted ? "thumbnail-candidate--promoted" : ""}`}>
            <button
              type="button"
              class="thumbnail-candidate__promote"
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
              <span class="thumbnail-label">{c.kind}</span>
            </button>
            {c.promoted && <span class="thumbnail-badge">Active</span>}
            {!c.promoted && candidates.length > 1 && (
              <button
                type="button"
                class="thumbnail-candidate__delete"
                hx-delete={`/admin/videos/${video.id}/thumbnail/candidates/${c.id}`}
                hx-target="#thumbnail-picker"
                hx-swap="outerHTML"
                hx-confirm="Delete this thumbnail? This cannot be undone."
                aria-label="Delete thumbnail"
                title="Delete thumbnail"
              >
                <IconTrash size={14} />
              </button>
            )}
          </div>
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
        <label class="btn btn--sm">
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
      <a href={`/admin/videos/${videoId}/cover`} class="btn btn--sm">
        <IconFileImage size={14} />
        Open cover editor
      </a>
    </div>
  );
}
