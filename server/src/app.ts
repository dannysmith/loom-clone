import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { resolve } from "path";
import { requireApiKey } from "./lib/auth";
import admin from "./routes/admin";
import api from "./routes/api";
import site from "./routes/site";
import videos from "./routes/videos";

// Absolute path so serveStatic doesn't resolve against the current cwd.
// Tests chdir into a temp dir, which would otherwise break /static/*.
const PUBLIC_ROOT = resolve(import.meta.dir, "..", "public");

// Factory — kept side-effect-free so tests can construct a fresh app
// without touching the on-disk database. The entry point in `index.ts`
// is what runs `initDb()` at module load.
//
// Module layout (each owns its own auth profile):
//   api    — bearer auth on `/api/videos/*`, `/api/health` open
//   admin  — web/session auth at the mount (placeholder until task-x5)
//   site   — root, well-known files, `/data/*` (open, drops in 6.5)
//   videos — `/:slug{...}/*` viewer surface, mounted last as the catch-all
export function createApp(): Hono {
  const app = new Hono();

  // Bearer auth applied at the mount point so the api module stays
  // auth-agnostic (test-friendly + reusable). Only `/api/videos/*` is
  // gated — `/api/health` is deliberately open.
  app.use("/api/videos/*", requireApiKey());
  app.route("/api", api);

  // CSS, fonts, future client assets. Separate from `/data/*` (per-video
  // media, on the site module) which has its own Range-aware handler.
  app.use(
    "/static/*",
    serveStatic({ root: PUBLIC_ROOT, rewriteRequestPath: (p) => p.replace(/^\/static/, "") }),
  );

  app.route("/admin", admin);
  app.route("/", site);

  // Mounted last as documentation of intent — the `/:slug` catch-all
  // lives here and shouldn't be allowed to swallow more specific routes.
  // (Hono's trie router prefers specific routes anyway, but order makes
  // the policy explicit.)
  app.route("/", videos);

  return app;
}
