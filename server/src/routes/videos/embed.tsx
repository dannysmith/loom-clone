import { Hono } from "hono";
import { formatDuration } from "../../lib/format";
import { absoluteUrl } from "../../lib/url";
import { EmbedPage } from "../../views/viewer/EmbedPage";
import { resolveForViewer } from "./resolve";

const embed = new Hono();

// Chromeless player for iframe use. Same MP4-vs-HLS selection as the main
// page. Old-slug 301 points at the embed URL for the current slug so
// iframe embeds don't break after a rename.
embed.get("/:slug/embed", async (c) => {
  const { slug } = c.req.param();
  const result = await resolveForViewer(slug);
  if (!result) return c.text("Not found", 404);
  if ("redirect" in result) return c.redirect(`/${result.redirect}/embed`, 301);

  const { video, poster, captionsUrl, urls } = result;
  const canonicalUrl = absoluteUrl(urls.page);
  const posterAbsolute = poster ? absoluteUrl(urls.poster) : null;

  // Short cache + stale-while-revalidate. `private` for non-public videos
  // so shared caches (CDN) never store them.
  const cacheScope = video.visibility === "public" ? "public" : "private";
  c.header("Cache-Control", `${cacheScope}, max-age=60, stale-while-revalidate=300`);

  return c.html(
    <EmbedPage
      slug={video.slug}
      src={result.src}
      sources={result.sources}
      poster={result.poster}
      captionsUrl={captionsUrl}
      title={video.title ?? undefined}
      description={video.description ?? undefined}
      duration={formatDuration(video.durationSeconds) ?? undefined}
      canonicalUrl={canonicalUrl}
      posterAbsolute={posterAbsolute}
    />,
  );
});

export default embed;
