import { ViewerLayout } from "../layouts/ViewerLayout";

type Props = {
  slug: string;
  src: string;
  poster: string | null;
};

// Single video page. Vidstack styles + script come in via the head slot
// because they're only needed on this page; admin won't pull them down.
export function VideoPage({ slug, src, poster }: Props) {
  return (
    <ViewerLayout
      title={`Video ${slug}`}
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
    </ViewerLayout>
  );
}
