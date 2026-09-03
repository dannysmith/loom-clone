import type { Video } from "../../../db/schema";
import { RootLayout } from "../../layouts/RootLayout";
import { AdminClientAssets } from "../components/AdminClientAssets";

// Shell for the React video editor. The app reads its inputs from the data
// attributes below and never makes a separate metadata call — so every
// attribute here must be one `src/editor/main.tsx` actually reads.
export function EditorPage({ video }: { video: Video }) {
  const title = video.title || video.slug;

  return (
    <RootLayout title={`Editor · ${title}`} head={<AdminClientAssets entry="editor" />}>
      <div
        id="editor-root"
        data-video-id={video.id}
        data-video-title={title}
        data-video-duration={video.durationSeconds ?? 0}
      />
    </RootLayout>
  );
}
