import { Hono } from "hono";
import videos from "./videos";

// Public/external JSON API. Bearer auth is applied at the mount point in
// `app.ts` for `/api/videos/*` only — `/api/health` stays open so the
// macOS app can ping reachability before it has a token.
const api = new Hono();

// Health check — used by the desktop app to gate the Record button on
// server reachability. Cheap, no dependencies. A 401 here would confuse
// "server down" with "bad credentials".
api.get("/health", (c) => c.json({ ok: true }));

api.route("/videos", videos);

export default api;
