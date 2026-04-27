import { Hono } from "hono";
import { siteConfig } from "../../lib/site-config";
import { resolveSlug } from "../../lib/store";
import { absoluteUrl, getPublicBaseUrl } from "../../lib/url";

// oEmbed discovery endpoint. Open, no auth. Services (Notion, WordPress,
// anything supporting oEmbed) call this to get an iframe embed code for a
// video URL. The discovery <link> tag on /:slug pages points here.
const oembed = new Hono();

oembed.get("/oembed", async (c) => {
  const url = c.req.query("url");
  if (!url) return c.json({ error: "Missing url parameter" }, 400);

  // Extract slug from the URL. Accept both path-only and absolute forms.
  const base = getPublicBaseUrl();
  let pathname: string;
  if (URL.canParse(url)) {
    pathname = new URL(url).pathname;
  } else {
    pathname = url;
  }
  const slugMatch = /^\/([a-z0-9](?:-?[a-z0-9])*)$/.exec(pathname);
  if (!slugMatch?.[1]) return c.json({ error: "Not found" }, 404);

  const resolved = await resolveSlug(slugMatch[1]);
  if (!resolved) return c.json({ error: "Not found" }, 404);
  const { video } = resolved;

  const { width: defW, height: defH } = siteConfig.defaultOgEmbedDimensions;
  const maxwidth = Math.min(Number(c.req.query("maxwidth") ?? defW), defW);
  const maxheight = Math.min(Number(c.req.query("maxheight") ?? defH), defH);
  // Maintain 16:9 aspect ratio within the constraints.
  const width = Math.min(maxwidth, Math.round(maxheight * (16 / 9)));
  const height = Math.round(width * (9 / 16));

  const embedUrl = absoluteUrl(`/${video.slug}/embed`);
  const posterUrl = absoluteUrl(`/${video.slug}/poster.jpg`);

  c.header("Cache-Control", "public, max-age=3600");
  return c.json({
    version: "1.0",
    type: "video",
    title: video.title ?? video.slug,
    author_name: siteConfig.authorName,
    provider_name: siteConfig.name,
    provider_url: base,
    html: `<iframe src="${embedUrl}" width="${width}" height="${height}" frameborder="0" allow="autoplay; fullscreen" allowfullscreen></iframe>`,
    width,
    height,
    thumbnail_url: posterUrl,
    thumbnail_width: width,
    thumbnail_height: height,
  });
});

export default oembed;
