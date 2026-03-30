import { Hono } from "hono";
import { getVideoBySlug } from "../lib/store";

const playback = new Hono();

playback.get("/v/:slug", (c) => {
  const { slug } = c.req.param();
  const video = getVideoBySlug(slug);
  if (!video) return c.text("Not found", 404);

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
  <media-player src="/data/${video.id}/stream.m3u8" playsinline>
    <media-provider></media-provider>
    <media-video-layout></media-video-layout>
  </media-player>
</body>
</html>`;

  return c.html(html);
});

export default playback;
