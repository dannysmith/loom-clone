import { Hono } from "hono";
import { csrf } from "hono/csrf";
import {
  clearSession,
  createSession,
  getAdminConfig,
  requireAdmin,
  verifyCredentials,
} from "../../lib/admin-auth";
import { listVideosFiltered } from "../../lib/store";
import { LoginPage } from "../../views/admin/pages/LoginPage";
import { TrashBinPage } from "../../views/admin/pages/TrashBinPage";
import dashboard from "./dashboard";
import type { AdminEnv } from "./helpers";
import media from "./media";
import settings from "./settings";
import upload from "./upload";
import videoRoutes from "./videos";

const admin = new Hono<AdminEnv>();

// --- Public routes (no auth) ---

admin.get("/login", (c) => c.html(<LoginPage />));

admin.post("/login", async (c) => {
  const config = getAdminConfig();
  if (!config) return c.redirect("/admin");

  const body = await c.req.parseBody();
  const username = String(body.username ?? "");
  const password = String(body.password ?? "");

  if (!verifyCredentials(config, username, password)) {
    return c.html(<LoginPage error="Invalid username or password" />, 401);
  }

  await createSession(c, config);
  return c.redirect("/admin");
});

// --- Auth + CSRF on everything below ---

admin.use("*", requireAdmin());

// CSRF protection for cookie-based auth only. Bearer token requests are
// inherently CSRF-safe (the token is explicitly attached, not auto-sent
// by the browser), so we skip the Origin check for them. We check the
// actual auth method (set by requireAdmin) rather than the presence of
// the Authorization header — a request with both a valid session cookie
// and a bogus Authorization header would otherwise bypass CSRF.
const csrfCheck = csrf();
admin.use("*", (c, next) => {
  if (c.get("adminAuthMethod") === "bearer") return next();
  return csrfCheck(c, next);
});

// --- Authenticated routes ---

admin.post("/logout", (c) => {
  clearSession(c);
  return c.redirect("/admin/login");
});

admin.get("/trash", async (c) => {
  const result = await listVideosFiltered({ trashedOnly: true });
  const view = c.req.query("view") || "grid";
  return c.html(<TrashBinPage videos={result.items} view={view} />);
});

// --- Sub-routers ---

admin.route("/", dashboard);
admin.route("/videos", videoRoutes);
admin.route("/videos", media);
admin.route("/upload", upload);
admin.route("/settings", settings);

export default admin;
