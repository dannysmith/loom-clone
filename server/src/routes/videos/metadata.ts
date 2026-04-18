import type { Context } from "hono";
import { resolveSlug } from "../../lib/store";
import { urlsForSlug } from "../../lib/url";

// Machine-readable representations of a video. Phase 7 will expand these
// with richer metadata (tags, transcript, OG fields); today they're a
// minimal contract that lets integrations start targeting the shape.
//
// Exported as handler functions (not a Hono router) because Hono's route
// param syntax can't separate `:slug` from `.json`/`.md` as param + literal
// suffix. The aggregator in index.ts dispatches from a single `/:file`
// catch-all that checks the extension.

export async function handleJsonMetadata(c: Context, slug: string): Promise<Response> {
  const resolved = await resolveSlug(slug);
  if (!resolved) return c.json({ error: "Not found" }, 404);
  if (resolved.redirected) {
    return c.redirect(`/${resolved.video.slug}.json`, 301);
  }
  const { video } = resolved;
  return c.json({
    id: video.id,
    slug: video.slug,
    title: video.title,
    description: video.description,
    durationSeconds: video.durationSeconds,
    urls: urlsForSlug(video.slug),
  });
}

export async function handleMdMetadata(c: Context, slug: string): Promise<Response> {
  const resolved = await resolveSlug(slug);
  if (!resolved) return c.text("Not found", 404);
  if (resolved.redirected) {
    return c.redirect(`/${resolved.video.slug}.md`, 301);
  }
  const { video } = resolved;
  const heading = video.title ?? video.slug;
  const urls = urlsForSlug(video.slug);
  const body = video.description ? `${video.description}\n\n` : "";
  const md = `# ${heading}\n\n${body}[Watch](${urls.page})\n`;
  return c.text(md, 200, { "content-type": "text/markdown; charset=utf-8" });
}
