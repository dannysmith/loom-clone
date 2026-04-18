import { RootLayout } from "../layouts/RootLayout";

type Props = {
  slug: string;
  src: string;
  poster: string | null;
};

// Chromeless player for iframe embeds. No page chrome — just the player
// filling the viewport. Styling in embed.css.
export function EmbedPage({ slug, src, poster }: Props) {
  return (
    <RootLayout
      title={`Video ${slug} — embed`}
      bodyClass="embed"
      head={
        <>
          <link rel="stylesheet" href="https://cdn.vidstack.io/player/theme.css" />
          <link rel="stylesheet" href="https://cdn.vidstack.io/player/video.css" />
          <link rel="stylesheet" href="/static/styles/embed.css" />
          <script type="module" src="https://cdn.vidstack.io/player" />
        </>
      }
    >
      <media-player src={src} poster={poster ?? undefined} playsinline>
        <media-provider />
        <media-video-layout />
      </media-player>
    </RootLayout>
  );
}
