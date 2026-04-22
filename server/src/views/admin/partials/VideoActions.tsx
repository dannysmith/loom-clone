import type { Video } from "../../../db/schema";
import {
  IconCopy,
  IconDownload,
  IconDuplicate,
  IconExternalLink,
  IconTrash,
} from "../components/Icons";

export function VideoActions({ video }: { video: Video }) {
  const isPublicOrUnlisted = video.visibility !== "private";
  const publicUrl = `/${video.slug}`;

  return (
    <div class="video-actions">
      {isPublicOrUnlisted && (
        <>
          <a href={publicUrl} target="_blank" rel="noopener" class="btn btn--sm">
            <IconExternalLink size={14} /> Open public URL
          </a>
          <button type="button" class="btn btn--sm" onclick={`copyToClipboard('${publicUrl}')`}>
            <IconCopy size={14} /> Copy public URL
          </button>
        </>
      )}

      <a href={`/admin/videos/${video.id}/media/raw/source.mp4`} download class="btn btn--sm">
        <IconDownload size={14} /> Download
      </a>

      <form method="post" action={`/admin/videos/${video.id}/duplicate`}>
        <button type="submit" class="btn btn--sm">
          <IconDuplicate size={14} /> Duplicate
        </button>
      </form>

      {video.trashedAt ? (
        <form method="post" action={`/admin/videos/${video.id}/untrash`}>
          <button type="submit" class="btn btn--sm btn--primary">
            Restore from trash
          </button>
        </form>
      ) : (
        <form
          method="post"
          action={`/admin/videos/${video.id}/trash`}
          hx-confirm="Move this video to trash?"
        >
          <button type="submit" class="btn btn--sm btn--danger">
            <IconTrash size={14} /> Trash
          </button>
        </form>
      )}
    </div>
  );
}
