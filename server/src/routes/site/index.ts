import { Hono } from "hono";
import data from "./data";

// Open routes that aren't part of any other module: root, well-known files,
// and (for now) the Range-aware `/data/*` media handler. The `/data/*`
// surface gets dropped in 6.5 once viewer media moves under `/:slug/...`.
// Root + robots/favicon/sitemap land in 6.3.
const site = new Hono();

site.route("/", data);

export default site;
