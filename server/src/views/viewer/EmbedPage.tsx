import { RootLayout } from "../layouts/RootLayout";

type Props = {
  slug: string;
  src: string;
  poster: string | null;
};

// Chromeless player for iframe embeds. No page chrome, no viewer.css —
// just the player filling the viewport. Phase 7 will polish the styling
// and add proper embed-specific tokens (e.g. dark background, no rounded
// corners on the player container).
export function EmbedPage({ slug, src, poster }: Props) {
  return (
    <RootLayout
      title={`Video ${slug} — embed`}
      bodyClass="embed"
      head={
        <>
          <link rel="stylesheet" href="https://cdn.vidstack.io/player/theme.css" />
          <link rel="stylesheet" href="https://cdn.vidstack.io/player/video.css" />
          <script type="module" src="https://cdn.vidstack.io/player" />
          <style>
            {`html, body.embed { margin: 0; padding: 0; height: 100%; background: #000; }
              body.embed media-player { width: 100%; height: 100%; }`}
          </style>
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
