// Self-hosted Vidstack player entry. Replaces the old cdn.vidstack.io tags
// on the viewer, embed, and admin video pages.
//
// CSS first, then the custom-element registrations (media-player,
// media-provider, media-poster, media-video-layout, and the rest of the
// default layout).
import "vidstack/player/styles/default/theme.css";
import "vidstack/player/styles/default/layouts/video.css";
import "vidstack/player";
import "vidstack/player/ui";
import "vidstack/player/layouts/default";

import { isHLSProvider } from "vidstack";

// The HLS provider defaults to fetching hls.js from jsDelivr at an unpinned
// semver range. Point it at our own pinned copy instead — as a dynamic
// import so it stays a lazy chunk, only fetched for .m3u8 sources (the
// derivatives-not-yet-ready fallback path).
//
// `provider-change` is dispatched on the <media-player> element; a
// capture-phase listener on document sees it regardless of whether it
// bubbles, and covers every player on the page.
document.addEventListener(
  "provider-change",
  (event) => {
    const provider = (event as CustomEvent).detail;
    if (isHLSProvider(provider)) {
      provider.library = () => import("hls.js");
    }
  },
  true,
);
