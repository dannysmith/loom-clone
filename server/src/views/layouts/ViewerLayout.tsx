import type { Child, PropsWithChildren } from "hono/jsx";
import { RootLayout } from "./RootLayout";

type Props = PropsWithChildren<{
  title: string;
  head?: Child;
}>;

// Public viewer shell. Centred, content-first, no chrome.
// Loads the lean public-viewer stylesheet (no admin styles).
export function ViewerLayout({ title, head, children }: Props) {
  return (
    <RootLayout title={title} head={head} bodyClass="viewer" stylesheet="styles/viewer-app.css">
      <main class="viewer-main">{children}</main>
    </RootLayout>
  );
}
