import { Hono } from "hono";
import data from "./data";
import wellKnown from "./well-known";

// Open routes that aren't part of any other module: root, well-known files,
// and (for now) the Range-aware `/data/*` media handler. The `/data/*`
// surface gets dropped in 6.5 once viewer media moves under `/:slug/...`.
const site = new Hono();

site.route("/", wellKnown);
site.route("/", data);

export default site;
