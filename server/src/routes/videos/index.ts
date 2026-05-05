import { Hono } from "hono";
import { cors } from "hono/cors";
import embed from "./embed";
import media, { handleMp4Redirect } from "./media";
import { handleJsonMetadata, handleMdMetadata } from "./metadata";
import { handleSlugPage } from "./page";

// Viewer-facing routes. Mounted at `/` last in `app.ts` so it acts as the
// slug catch-all. Sub-routers handle multi-segment paths (/:slug/embed,
// /:slug/raw/:file, etc.); the single-segment /:file catch-all dispatches
// based on extension for .json, .md, .mp4 — Hono can't separate a param
// from a literal dot-suffix, so we parse it ourselves.
const videos = new Hono();

// Wildcard CORS for everything routed through the videos module — the
// public viewer surface (JSON metadata, captions, storyboard VTT, raw MP4,
// HLS, etc.). Scoped here rather than at the app level so it only fires
// for requests Hono actually dispatches to this sub-router; /api/* and
// /admin/* never reach here.
videos.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "HEAD", "OPTIONS"],
  }),
);

// Permanent redirect from the legacy /v/:slug path. Cached shared URLs,
// bookmarks, and older macOS app versions that still reference /v/... will
// 301 to the canonical /:slug form. Do not remove these routes.
videos.get("/v/:slug", (c) => c.redirect(`/${c.req.param("slug")}`, 301));
videos.get("/v/:slug/*", (c) => {
  const slug = c.req.param("slug");
  const rest = c.req.path.replace(`/v/${slug}`, `/${slug}`);
  return c.redirect(rest, 301);
});

// Multi-segment routes (more specific, matched first by the trie router)
videos.route("/", embed); // /:slug/embed
videos.route("/", media); // /:slug/raw/:file, /:slug/stream/:file, /:slug/poster.jpg

// Single-segment catch-all: /:slug, /:slug.json, /:slug.md, /:slug.mp4
videos.get("/:file", async (c) => {
  const file = c.req.param("file");
  if (file.endsWith(".json")) return handleJsonMetadata(c, file.slice(0, -5));
  if (file.endsWith(".md")) return handleMdMetadata(c, file.slice(0, -3));
  if (file.endsWith(".mp4")) return handleMp4Redirect(c, file.slice(0, -4));
  return handleSlugPage(c, file);
});

export default videos;
