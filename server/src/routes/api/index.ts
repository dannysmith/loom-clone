import { readFileSync } from "fs";
import { Hono } from "hono";
import { resolve } from "path";
import { ConflictError, resolveSlug } from "../../lib/store";
import { absoluteUrl, getPublicBaseUrl } from "../../lib/url";
import videos from "./videos";

// Read version once at import time. resolve() from this file's directory
// finds package.json two levels up (src/routes/api → server/).
const pkg = JSON.parse(
  readFileSync(resolve(import.meta.dir, "..", "..", "..", "package.json"), "utf8"),
);
const SERVER_VERSION: string = pkg.version ?? "unknown";

// Public/external JSON API. Bearer auth is applied at the mount point in
// `app.ts` for `/api/videos/*` only — `/api/health` stays open so the
// macOS app can ping reachability before it has a token.
const api = new Hono();

// Health check — used by the desktop app to gate the Record button on
// server reachability. Includes version + timestamp for debugging and
// future client/server compat checks.
api.get("/health", (c) =>
  c.json({ ok: true, version: SERVER_VERSION, time: new Date().toISOString() }),
);

// oEmbed discovery endpoint. Open, no auth. Services (Notion, WordPress,
// anything supporting oEmbed) call this to get an iframe embed code for a
// video URL. The discovery <link> tag on /:slug pages points here.
api.get("/oembed", async (c) => {
  const url = c.req.query("url");
  if (!url) return c.json({ error: "Missing url parameter" }, 400);

  // Extract slug from the URL. Accept both path-only and absolute forms.
  const base = getPublicBaseUrl();
  const pathname = url.startsWith("http") ? new URL(url).pathname : url;
  const slugMatch = /^\/([a-z0-9](?:-?[a-z0-9])*)$/.exec(pathname);
  if (!slugMatch?.[1]) return c.json({ error: "Not found" }, 404);

  const resolved = await resolveSlug(slugMatch[1]);
  if (!resolved) return c.json({ error: "Not found" }, 404);
  const { video } = resolved;

  const maxwidth = Math.min(Number(c.req.query("maxwidth") ?? 1280), 1280);
  const maxheight = Math.min(Number(c.req.query("maxheight") ?? 720), 720);
  // Maintain 16:9 aspect ratio within the constraints.
  const width = Math.min(maxwidth, Math.round(maxheight * (16 / 9)));
  const height = Math.round(width * (9 / 16));

  const embedUrl = absoluteUrl(`/${video.slug}/embed`);
  const posterUrl = absoluteUrl(`/${video.slug}/poster.jpg`);

  return c.json({
    version: "1.0",
    type: "video",
    title: video.title ?? video.slug,
    author_name: "Danny Smith",
    provider_name: "loom-clone",
    provider_url: base,
    html: `<iframe src="${embedUrl}" width="${width}" height="${height}" frameborder="0" allow="autoplay; fullscreen" allowfullscreen></iframe>`,
    width,
    height,
    thumbnail_url: posterUrl,
    thumbnail_width: width,
    thumbnail_height: height,
  });
});

api.route("/videos", videos);

// Map store-layer ConflictError (e.g. slug collisions) to 409 so the
// client gets a structured error instead of a generic 500.
api.onError((err, c) => {
  if (err instanceof ConflictError) {
    return c.json({ error: err.message, code: "CONFLICT" }, 409);
  }
  throw err;
});

export default api;
