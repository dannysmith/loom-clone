import { readFileSync } from "fs";
import { Hono } from "hono";
import { resolve } from "path";
import { ConflictError, ValidationError } from "../../lib/store";
import videos from "./videos";

// Read version once at import time. resolve() from this file's directory
// finds package.json two levels up (src/routes/api → server/).
const pkg = JSON.parse(
  readFileSync(resolve(import.meta.dir, "..", "..", "..", "package.json"), "utf8"),
);
const SERVER_VERSION: string = pkg.version ?? "unknown";

// JSON API for the macOS app and programmatic clients. Bearer auth is
// applied at the mount point in `app.ts` for `/api/videos/*` only —
// `/api/health` is deliberately open.
const api = new Hono();

// Health check — used by the desktop app to gate the Record button on
// server reachability. Includes version + timestamp for debugging and
// future client/server compat checks.
api.get("/health", (c) =>
  c.json({ ok: true, version: SERVER_VERSION, time: new Date().toISOString() }),
);

api.route("/videos", videos);

// Map store-layer errors to appropriate HTTP status codes so the client
// gets structured errors instead of generic 500s.
api.onError((err, c) => {
  if (err instanceof ValidationError) {
    return c.json({ error: err.message, code: "VALIDATION_ERROR" }, 400);
  }
  if (err instanceof ConflictError) {
    return c.json({ error: err.message, code: "CONFLICT" }, 409);
  }
  throw err;
});

export default api;
