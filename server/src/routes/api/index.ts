import { readFileSync } from "fs";
import { Hono } from "hono";
import { resolve } from "path";
import { ConflictError } from "../../lib/store";
import videos from "./videos";

// Read version once at import time. resolve() from this file's directory
// finds package.json two levels up (src/routes/api → server/).
const pkg = JSON.parse(
  readFileSync(resolve(import.meta.dir, "..", "..", "..", "package.json"), "utf8"),
);
const SERVER_VERSION: string = pkg.version ?? "unknown";

// Public/external JSON API. Bearer auth is applied at the mount point in
// `app.ts` for `/api/videos/*` only — `/api/health` stays open so the
// macOS app can ping reachability before it has a token.
const api = new Hono();

// Health check — used by the desktop app to gate the Record button on
// server reachability. Includes version + timestamp for debugging and
// future client/server compat checks.
api.get("/health", (c) =>
  c.json({ ok: true, version: SERVER_VERSION, time: new Date().toISOString() }),
);

api.route("/videos", videos);

// Map store-layer ConflictError (e.g. slug collisions) to 409 so the
// client gets a structured error instead of a generic 500.
api.onError((err, c) => {
  if (err instanceof ConflictError) {
    return c.json({ error: err.message, code: "CONFLICT" }, 409);
  }
  throw err;
});

export default api;
