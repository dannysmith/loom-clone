import { formatDate, formatDuration } from "../../lib/format";
import type { VideoRecord } from "../../lib/store";
import { ViewerLayout } from "../layouts/ViewerLayout";

type Props = {
  video: VideoRecord;
  src: string;
  poster: string | null;
};

export function VideoPage({ video, src, poster }: Props) {
  const pageTitle = video.title ?? `Video ${video.slug}`;
  const duration = formatDuration(video.durationSeconds);
  const date = formatDate(video.completedAt ?? video.createdAt);

  return (
    <ViewerLayout
      title={pageTitle}
      head={
        <>
          <link rel="stylesheet" href="https://cdn.vidstack.io/player/theme.css" />
          <link rel="stylesheet" href="https://cdn.vidstack.io/player/video.css" />
          <link rel="stylesheet" href="/static/styles/viewer.css" />
          <script type="module" src="https://cdn.vidstack.io/player" />
        </>
      }
    >
      <media-player src={src} poster={poster ?? undefined} playsinline>
        <media-provider />
        <media-video-layout />
      </media-player>

      <div class="viewer-meta">
        {video.title && <h1 class="viewer-title">{video.title}</h1>}
        {(duration || date) && (
          <p class="viewer-details">{[duration, date].filter(Boolean).join(" · ")}</p>
        )}
        {video.description && <p class="viewer-description">{video.description}</p>}
        <p class="viewer-attribution">
          <a href="https://dannysmith.com" rel="noopener">
            dannysmith.com
          </a>
        </p>
      </div>
    </ViewerLayout>
  );
}
