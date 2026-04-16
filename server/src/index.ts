import { Hono } from "hono";
import { loadAllVideos } from "./lib/store";
import playback from "./routes/playback";
import staticRoutes from "./routes/static";
import videos from "./routes/videos";

// Factory — kept side-effect-free so tests can construct a fresh app
// without hitting the real filesystem during `loadAllVideos()`.
export function createApp(): Hono {
  const app = new Hono();

  // Health check — used by the desktop app to gate the Record button on
  // server reachability. Cheap, no dependencies.
  app.get("/api/health", (c) => c.json({ ok: true }));

  app.route("/api/videos", videos);
  app.route("/", staticRoutes);
  app.route("/", playback);

  return app;
}

const restored = await loadAllVideos();
console.log(`[store] rehydrated ${restored} video record(s) from data/`);

const app = createApp();

console.log("Server running at http://localhost:3000");

export default {
  port: 3000,
  fetch: app.fetch,
};
