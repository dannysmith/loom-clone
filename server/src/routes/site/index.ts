import { Hono } from "hono";
import oembed from "./oembed";
import wellKnown from "./well-known";

// Open routes: root landing, well-known files (robots.txt, favicon, sitemap),
// and oEmbed discovery. The /data/* media handler was removed in 6.5 — all
// viewer media is now served under /:slug/... by the videos module.
const site = new Hono();

site.route("/", wellKnown);
site.route("/", oembed);

export default site;
