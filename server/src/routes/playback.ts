import { Hono } from "hono";
import { join } from "path";
import { DATA_DIR, getVideoBySlug } from "../lib/store";

const playback = new Hono();

playback.get("/v/:slug", async (c) => {
  const { slug } = c.req.param();
  const video = getVideoBySlug(slug);
  if (!video) return c.text("Not found", 404);

  // Prefer the single-file MP4 when the derivative exists; otherwise fall
  // back to the HLS playlist. Checking on each request means a healing
  // recording transparently upgrades from HLS to MP4 on the next page load
  // without any client state.
  const mp4Path = join(DATA_DIR, video.id, "derivatives", "source.mp4");
  const thumbPath = join(DATA_DIR, video.id, "derivatives", "thumbnail.jpg");
  const [hasMp4, hasThumb] = await Promise.all([
    Bun.file(mp4Path).exists(),
    Bun.file(thumbPath).exists(),
  ]);
  const src = hasMp4 ? `/data/${video.id}/derivatives/source.mp4` : `/data/${video.id}/stream.m3u8`;
  const poster = hasThumb ? `/data/${video.id}/derivatives/thumbnail.jpg` : null;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Video ${video.slug}</title>
  <link rel="stylesheet" href="https://cdn.vidstack.io/player/theme.css" />
  <link rel="stylesheet" href="https://cdn.vidstack.io/player/video.css" />
  <script type="module" src="https://cdn.vidstack.io/player"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #000; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    media-player { width: 100%; max-width: 1280px; aspect-ratio: 16/9; }
  </style>
</head>
<body>
  <media-player src="${src}"${poster ? ` poster="${poster}"` : ""} playsinline>
    <media-provider></media-provider>
    <media-video-layout></media-video-layout>
  </media-player>
</body>
</html>`;

  return c.html(html);
});

export default playback;
