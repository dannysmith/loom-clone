import { Hono } from "hono";
import page from "./page";

// Viewer-facing routes. Mounted at `/` last in `app.ts` so it acts as the
// `/:slug{...}/*` wildcard catch-all. Today only the `/v/:slug` legacy
// page lives here — the slug-namespaced surface (`/:slug`, `/:slug/embed`,
// `/:slug.mp4`, etc.) lands in 6.4.
const videos = new Hono();

videos.route("/", page);

export default videos;
