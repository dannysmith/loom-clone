import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { resolve } from "path";
import { requireApiKey } from "./lib/auth";
import admin from "./routes/admin";
import playback from "./routes/playback";
import staticRoutes from "./routes/static";
import videos from "./routes/videos";

// Absolute path so serveStatic doesn't resolve against the current cwd.
// Tests chdir into a temp dir, which would otherwise break /static/*.
const PUBLIC_ROOT = resolve(import.meta.dir, "..", "public");

// Factory — kept side-effect-free so tests can construct a fresh app
// without touching the on-disk database. The entry point in `index.ts`
// is what runs `initDb()` at module load.
export function createApp(): Hono {
  const app = new Hono();

  // Health check — used by the desktop app to gate the Record button on
  // server reachability. Cheap, no dependencies. Deliberately unauthed:
  // the app needs to ping it before it has a token, and a 401 here would
  // confuse "server down" with "bad credentials".
  app.get("/api/health", (c) => c.json({ ok: true }));

  // All mutation routes require a valid API key. Applied at mount-point
  // rather than inside the videos router so the router stays auth-agnostic
  // (keeps it test-friendly + reusable).
  app.use("/api/videos/*", requireApiKey());
  app.route("/api/videos", videos);
  app.route("/", staticRoutes);
  // CSS, fonts, future client assets. Separate from /data/* (per-video
  // media) which has its own Range-aware handler.
  app.use(
    "/static/*",
    serveStatic({ root: PUBLIC_ROOT, rewriteRequestPath: (p) => p.replace(/^\/static/, "") }),
  );
  app.route("/admin", admin);
  app.route("/", playback);

  return app;
}
