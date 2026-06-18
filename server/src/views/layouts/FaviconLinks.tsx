import { staticUrl } from "../../lib/static-assets";

// Shared favicon / web-app-manifest links. Sourced from the circular avatar
// (server/public/images/favicon/, generated once with ffmpeg). Browser-tab
// icons keep the transparent background; the apple-touch and manifest icons
// composite the avatar onto a coral square (transparency renders as black on
// iOS home screens). Rendered in both RootLayout and AdminLayout heads.
//
// The manifest is served at the root path by the site route (with the correct
// content-type) and is intentionally not version-hashed; the icon <link>s are,
// via staticUrl(), so swapping the avatar busts browser/CDN caches.
export function FaviconLinks() {
  return (
    <>
      <link rel="icon" href={staticUrl("images/favicon/favicon.ico")} sizes="32x32" />
      <link
        rel="icon"
        type="image/png"
        href={staticUrl("images/favicon/favicon-32.png")}
        sizes="32x32"
      />
      <link
        rel="icon"
        type="image/png"
        href={staticUrl("images/favicon/favicon-16.png")}
        sizes="16x16"
      />
      <link rel="apple-touch-icon" href={staticUrl("images/favicon/apple-touch-icon.png")} />
      <link rel="manifest" href="/site.webmanifest" />
    </>
  );
}
