import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import videos from "./routes/videos";
import playback from "./routes/playback";
import { loadAllVideos } from "./lib/store";

const restored = await loadAllVideos();
console.log(`[store] rehydrated ${restored} video record(s) from data/`);

const app = new Hono();

// Health check — used by the desktop app to gate the Record button on
// server reachability. Cheap, no dependencies.
app.get("/api/health", (c) => c.json({ ok: true }));

// API routes
app.route("/api/videos", videos);

// Static file serving for HLS segments
// Sets correct MIME types for m3u8 and m4s
app.use(
  "/data/*",
  serveStatic({
    root: "./",
    mimes: {
      m3u8: "application/vnd.apple.mpegurl",
      m4s: "video/iso.segment",
      mp4: "video/mp4",
    },
  })
);

// Video playback pages
app.route("/", playback);

console.log("Server running at http://localhost:3000");

export default {
  port: 3000,
  fetch: app.fetch,
};
