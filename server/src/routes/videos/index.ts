import { Hono } from "hono";
import embed from "./embed";
import media, { handleMp4Redirect } from "./media";
import { handleJsonMetadata, handleMdMetadata } from "./metadata";
import page, { handleSlugPage } from "./page";

// Viewer-facing routes. Mounted at `/` last in `app.ts` so it acts as the
// slug catch-all. Sub-routers handle multi-segment paths (/:slug/embed,
// /:slug/raw/:file, etc.); the single-segment /:file catch-all dispatches
// based on extension for .json, .md, .mp4 — Hono can't separate a param
// from a literal dot-suffix, so we parse it ourselves.
const videos = new Hono();

// Multi-segment routes (more specific, matched first by the trie router)
videos.route("/", page); // /v/:slug (legacy)
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
