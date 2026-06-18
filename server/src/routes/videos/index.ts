import { Hono } from "hono";
import { cors } from "hono/cors";
import embed from "./embed";
import media, { handleMp4Redirect } from "./media";
import { handleJsonMetadata, handleMdMetadata } from "./metadata";
import { handleSlugPage } from "./page";
import tagFeeds from "./tag-feeds";
import { handleTagMdMetadata } from "./tag-metadata";
import { handleTagPage } from "./tag-page";

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
videos.route("/", tagFeeds); // /:slug/feed.xml, /:slug/feed.json (tags)

// Single-segment catch-all: /:slug (video or tag), /:slug.json, /:slug.md,
// /:slug.mp4. .json/.mp4 are video-only; .md falls back from video to tag.
// The bare slug renders the HTML page (video, then tag) unless the client
// negotiates markdown via `Accept: text/markdown`.
videos.get("/:file", async (c) => {
  const file = c.req.param("file");
  if (file.endsWith(".json")) return handleJsonMetadata(c, file.slice(0, -5));
  if (file.endsWith(".md")) {
    const slug = file.slice(0, -3);
    const md = await handleMdMetadata(c, slug);
    if (md.status !== 404) return md;
    return handleTagMdMetadata(c, slug);
  }
  if (file.endsWith(".mp4")) return handleMp4Redirect(c, file.slice(0, -4));

  // Content negotiation: agents that send `Accept: text/markdown` (Claude
  // Code, Cursor, OpenCode) get the markdown representation of the bare-slug
  // page — video first, then tag. Marked no-store + Vary so a shared cache
  // never serves this markdown to a browser asking for the HTML page.
  if ((c.req.header("accept") ?? "").includes("text/markdown")) {
    const md = await handleMdMetadata(c, file);
    if (md.status !== 404) return negotiatedMarkdown(md);
    const tagMd = await handleTagMdMetadata(c, file);
    if (tagMd.status !== 404) return negotiatedMarkdown(tagMd);
  }

  const pageResponse = await handleSlugPage(c, file);
  if (pageResponse.status !== 404) return pageResponse;
  return handleTagPage(c, file);
});

// Markdown served by content negotiation lives at the same URL as the HTML
// page. BunnyCDN keys cache by URL and ignores `Vary`, so we mark these
// responses uncacheable at shared caches to avoid poisoning the HTML page's
// edge cache. (The `.md` URL variant stays cacheable via its own handler.)
function negotiatedMarkdown(res: Response): Response {
  res.headers.set("Cache-Control", "private, no-store");
  res.headers.set("Vary", "Accept");
  return res;
}

export default videos;
