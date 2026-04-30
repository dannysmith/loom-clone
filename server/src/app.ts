import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { requireApiKey } from "./lib/auth";
import { getRewrittenCss, PUBLIC_ROOT } from "./lib/static-assets";
import admin from "./routes/admin";
import api from "./routes/api";
import site from "./routes/site";
import videos from "./routes/videos";

// Factory — kept side-effect-free so tests can construct a fresh app
// without touching the on-disk database. The entry point in `index.ts`
// is what runs `initDb()` at module load.
//
// Module layout (each owns its own auth profile):
//   api    — bearer auth on `/api/videos/*`, `/api/health` open
//   admin  — session cookie or lca_ bearer token at the mount
//   site   — root, well-known files, `/data/*` (open, drops in 6.5)
//   videos — `/:slug{...}/*` viewer surface, mounted last as the catch-all
export function createApp(): Hono {
  const app = new Hono();

  // Bearer auth applied at the mount point so the api module stays
  // auth-agnostic (test-friendly + reusable). Only `/api/videos/*` is
  // gated — `/api/health` is deliberately open.
  app.use("/api/videos/*", requireApiKey());
  app.route("/api", api);

  // Serve CSS files with @import URLs rewritten to include the version
  // hash, so CDN-cached sub-files are busted along with the entry point.
  app.use("/static/styles/*", async (c, next) => {
    const rel = c.req.path.replace(/^\/static\//, "");
    const rewritten = getRewrittenCss(rel);
    if (rewritten) {
      c.header("Content-Type", "text/css; charset=utf-8");
      c.header("Cache-Control", "public, max-age=31536000, immutable");
      return c.body(rewritten);
    }
    return next();
  });

  // CSS, fonts, future client assets. Separate from `/data/*` (per-video
  // media, on the site module) which has its own Range-aware handler.
  // Versioned files get aggressive caching — the URL changes on redeploy.
  // Admin-only files (bypassed at the CDN via Edge Rule) get no-cache so
  // the browser always revalidates.
  app.use(
    "/static/*",
    serveStatic({
      root: PUBLIC_ROOT,
      rewriteRequestPath: (p) => p.replace(/^\/static/, ""),
      onFound: (path, c) => {
        if (path.endsWith("/admin.css") || path.endsWith("/admin.js")) {
          c.header("Cache-Control", "no-cache");
        } else {
          c.header("Cache-Control", "public, max-age=31536000, immutable");
        }
      },
    }),
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
