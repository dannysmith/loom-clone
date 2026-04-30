import type { Video } from "../../../db/schema";
import { absoluteUrl, activeRawFilename } from "../../../lib/url";
import {
  IconCode,
  IconCopy,
  IconDownload,
  IconDuplicate,
  IconExternalLink,
  IconScissors,
  IconTrash,
} from "../components/Icons";

function buildEmbedHtml(video: Video): string {
  const embedUrl = absoluteUrl(`/${video.slug}/embed`);
  const title = video.title ? video.title.replace(/"/g, "&quot;") : `Video ${video.slug}`;
  return [
    '<div style="position: relative; padding-bottom: 56.25%; height: 0;">',
    `  <iframe src="${embedUrl}" frameborder="0" allowfullscreen allow="autoplay; fullscreen; picture-in-picture" loading="lazy" title="${title}" style="position: absolute; top: 0; left: 0; width: 100%; height: 100%;"></iframe>`,
    "</div>",
  ].join("\n");
}

export function VideoActions({ video }: { video: Video }) {
  const isPublicOrUnlisted = video.visibility !== "private";
  const publicUrl = `/${video.slug}`;
  const embedHtml = buildEmbedHtml(video);
  // Escape for safe insertion into an onclick attribute
  const escapedEmbed = embedHtml.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n");

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
          <button type="button" class="btn btn--sm" onclick={`copyText('${escapedEmbed}')`}>
            <IconCode size={14} /> Copy embed HTML
          </button>
        </>
      )}

      {video.status === "complete" && (
        <a href={`/admin/videos/${video.id}/editor`} class="btn btn--sm">
          <IconScissors size={14} /> Edit video
        </a>
      )}

      <a
        href={`/admin/videos/${video.id}/media/raw/${activeRawFilename(video)}`}
        download
        class="btn btn--sm"
      >
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
