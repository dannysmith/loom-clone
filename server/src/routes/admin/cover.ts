import { Hono } from "hono";
import { raw } from "hono/html";
import { absoluteUrl, urlsForVideo } from "../../lib/url";
import { loadEntryAssets } from "../../lib/vite-manifest";
import { type AdminEnv, requireVideo } from "./helpers";

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

const cover = new Hono<AdminEnv>();

// --- Cover image generator page (serves the React shell) ---
cover.get("/:id/cover", async (c) => {
  const result = await requireVideo(c);
  if (result instanceof Response) return result;
  const video = result;

  if (video.trashedAt) {
    return c.text("Cannot edit a trashed video", 400);
  }

  const { scripts } = loadEntryAssets("cover.html");

  const title = video.title ?? "";
  const titleForTab = escapeAttr(video.title || video.slug);
  const publicUrl = absoluteUrl(urlsForVideo(video).page);
  // The active poster (current promoted thumbnail). Served by the admin
  // media route; falls through to 404 if no thumbnail.jpg exists yet, but
  // the cover generator can still operate (just with a broken image slot).
  const currentThumbnailUrl = `/admin/videos/${video.id}/media/poster.jpg`;

  return c.html(
    raw(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Cover &middot; ${titleForTab}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fira+Code:wght@300;400&family=Inter:wght@200;300;700;800;900&display=swap">
  ${scripts}
</head>
<body>
  <div id="cover-root"
    data-video-id="${video.id}"
    data-video-slug="${escapeAttr(video.slug)}"
    data-video-title="${escapeAttr(title)}"
    data-video-public-url="${escapeAttr(publicUrl)}"
    data-video-thumbnail-url="${escapeAttr(currentThumbnailUrl)}"
  ></div>
</body>
</html>`),
  );
});

export default cover;
