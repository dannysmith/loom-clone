import { Hono } from "hono";
import { apiError, ErrorCode } from "../../lib/errors";
import { siteConfig } from "../../lib/site-config";
import { resolveSlug } from "../../lib/store";
import { absoluteUrl, getPublicBaseUrl } from "../../lib/url";

// oEmbed discovery endpoint. Open, no auth. Services (Notion, WordPress,
// anything supporting oEmbed) call this to get an iframe embed code for a
// video URL. The discovery <link> tag on /:slug pages points here.
const oembed = new Hono();

oembed.get("/oembed", async (c) => {
  const url = c.req.query("url");
  if (!url) return apiError(c, 400, "Missing url parameter", ErrorCode.VALIDATION_ERROR);

  // Extract slug from the URL. Accept both path-only and absolute forms.
  const base = getPublicBaseUrl();
  let pathname: string;
  if (URL.canParse(url)) {
    pathname = new URL(url).pathname;
  } else {
    pathname = url;
  }
  const slugMatch = /^\/([a-z0-9](?:-?[a-z0-9])*)$/.exec(pathname);
  if (!slugMatch?.[1]) return apiError(c, 404, "Not found", ErrorCode.VIDEO_NOT_FOUND);

  const resolved = await resolveSlug(slugMatch[1]);
  if (!resolved) return apiError(c, 404, "Not found", ErrorCode.VIDEO_NOT_FOUND);
  const { video } = resolved;

  // Non-numeric or non-positive maxwidth/maxheight fall back to the defaults
  // rather than propagating NaN into the response.
  const parseDim = (value: string | undefined, fallback: number): number => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  const { width: defW, height: defH } = siteConfig.defaultOgEmbedDimensions;
  const maxwidth = Math.min(parseDim(c.req.query("maxwidth"), defW), defW);
  const maxheight = Math.min(parseDim(c.req.query("maxheight"), defH), defH);
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
