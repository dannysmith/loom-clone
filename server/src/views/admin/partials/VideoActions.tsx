import type { Video } from "../../../db/schema";

export function VideoActions({ video }: { video: Video }) {
  const isPublicOrUnlisted = video.visibility !== "private";
  const publicUrl = `/${video.slug}`;

  return (
    <div class="video-actions">
      {isPublicOrUnlisted && (
        <>
          <a href={publicUrl} target="_blank" rel="noopener" class="btn btn--sm">
            Open public URL
          </a>
          <button type="button" class="btn btn--sm" onclick={`copyToClipboard('${publicUrl}')`}>
            Copy public URL
          </button>
        </>
      )}

      <a href={`/admin/videos/${video.id}/media/raw/source.mp4`} download class="btn btn--sm">
        Download
      </a>

      <form method="post" action={`/admin/videos/${video.id}/duplicate`} style="display:inline">
        <button type="submit" class="btn btn--sm">
          Duplicate
        </button>
      </form>

      {video.trashedAt ? (
        <form method="post" action={`/admin/videos/${video.id}/untrash`} style="display:inline">
          <button type="submit" class="btn btn--sm btn--primary">
            Restore from trash
          </button>
        </form>
      ) : (
        <form
          method="post"
          action={`/admin/videos/${video.id}/trash`}
          style="display:inline"
          onsubmit="return confirm('Move this video to trash?')"
        >
          <button type="submit" class="btn btn--sm btn--danger">
            Trash
          </button>
        </form>
      )}
    </div>
  );
}
