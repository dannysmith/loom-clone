import { Hono } from "hono";
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

  return c.html(<EmbedPage slug={result.video.slug} src={result.src} poster={result.poster} />);
});

export default embed;
