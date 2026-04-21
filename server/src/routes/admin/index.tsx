import { Hono } from "hono";
import { csrf } from "hono/csrf";
import {
  clearSession,
  createSession,
  getAdminConfig,
  requireAdmin,
  verifyCredentials,
} from "../../lib/admin-auth";
import { DashboardPage } from "../../views/admin/pages/DashboardPage";
import { LoginPage } from "../../views/admin/pages/LoginPage";
import { SettingsPage } from "../../views/admin/pages/SettingsPage";
import { TrashBinPage } from "../../views/admin/pages/TrashBinPage";
import { VideoDetailPage } from "../../views/admin/pages/VideoDetailPage";

const admin = new Hono();

// --- Public routes (no auth) ---

admin.get("/login", (c) => c.html(<LoginPage />));

admin.post("/login", async (c) => {
  const config = getAdminConfig();
  if (!config) {
    // Dev mode: no password configured, redirect straight in.
    return c.redirect("/admin");
  }

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
admin.use("*", csrf());

// --- Authenticated routes ---

admin.post("/logout", (c) => {
  clearSession(c);
  return c.redirect("/admin/login");
});

admin.get("/", (c) => c.html(<DashboardPage />));
admin.get("/videos/:id", (c) => c.html(<VideoDetailPage id={c.req.param("id")} />));
admin.get("/settings", (c) => c.html(<SettingsPage />));
admin.get("/trash", (c) => c.html(<TrashBinPage />));

export default admin;
