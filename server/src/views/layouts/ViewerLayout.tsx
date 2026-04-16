import type { Child, PropsWithChildren } from "hono/jsx";
import { RootLayout } from "./RootLayout";

type Props = PropsWithChildren<{
  title: string;
  head?: Child;
}>;

// Public viewer shell. Centred, content-first, no chrome.
// Page-specific styles can come in via the `head` slot.
export function ViewerLayout({ title, head, children }: Props) {
  return (
    <RootLayout title={title} head={head} bodyClass="viewer">
      <main class="viewer-main">{children}</main>
    </RootLayout>
  );
}
