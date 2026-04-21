import type { Context } from "hono";
import { Hono } from "hono";
import { csrf } from "hono/csrf";
import {
  clearSession,
  createSession,
  getAdminConfig,
  requireAdmin,
  verifyCredentials,
} from "../../lib/admin-auth";
import { type DashboardFilters, type DashboardSort, listVideosFiltered } from "../../lib/store";
import { listTags } from "../../lib/tags";
import { DashboardPage } from "../../views/admin/pages/DashboardPage";
import { LoginPage } from "../../views/admin/pages/LoginPage";
import { SettingsPage } from "../../views/admin/pages/SettingsPage";
import { TrashBinPage } from "../../views/admin/pages/TrashBinPage";
import { VideoDetailPage } from "../../views/admin/pages/VideoDetailPage";
import { VideoList, VideoListAppend } from "../../views/admin/partials/VideoList";

const admin = new Hono();

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
admin.use("*", csrf());

// --- Authenticated routes ---

admin.post("/logout", (c) => {
  clearSession(c);
  return c.redirect("/admin/login");
});

// --- Dashboard ---

admin.get("/", async (c) => {
  const filters = parseFilters(c);
  const view = c.req.query("view") || "grid";
  const [result, tags] = await Promise.all([listVideosFiltered(filters), listTags()]);
  return c.html(
    <DashboardPage
      videos={result.items}
      nextCursor={result.nextCursor}
      filters={filters}
      tags={tags}
      view={view}
    />,
  );
});

// HTMX partial — returns just the video list (or appended batch for pagination).
admin.get("/partials/video-list", async (c) => {
  const filters = parseFilters(c);
  const view = c.req.query("view") || "grid";
  const result = await listVideosFiltered(filters);

  // If there's a cursor, we're loading more — return just the new cards + button.
  if (filters.cursor) {
    return c.html(
      <VideoListAppend
        videos={result.items}
        nextCursor={result.nextCursor}
        filters={filters}
        view={view}
      />,
    );
  }

  return c.html(
    <VideoList
      videos={result.items}
      nextCursor={result.nextCursor}
      filters={filters}
      view={view}
    />,
  );
});

// --- Other pages ---

admin.get("/videos/:id", (c) => c.html(<VideoDetailPage id={c.req.param("id")} />));
admin.get("/settings", (c) => c.html(<SettingsPage />));
admin.get("/trash", (c) => c.html(<TrashBinPage />));

export default admin;

// --- Helpers ---

const VALID_SORTS = new Set<DashboardSort>([
  "date-desc",
  "date-asc",
  "duration-desc",
  "duration-asc",
  "title-asc",
  "title-desc",
]);

const VALID_VISIBILITY = new Set(["public", "unlisted", "private"]);
const VALID_STATUS = new Set(["recording", "healing", "complete", "failed"]);

function parseFilters(c: Context): DashboardFilters {
  const filters: DashboardFilters = {};
  const q = (key: string) => c.req.query(key);

  const search = q("q")?.trim();
  if (search) filters.search = search;

  const visibility = q("visibility");
  if (visibility && VALID_VISIBILITY.has(visibility))
    filters.visibility = visibility as DashboardFilters["visibility"];

  const status = q("status");
  if (status && VALID_STATUS.has(status)) filters.status = status as DashboardFilters["status"];

  const tagId = q("tag");
  if (tagId) {
    const n = Number(tagId);
    if (Number.isFinite(n)) filters.tagId = n;
  }

  const dateFrom = q("from");
  if (dateFrom) filters.dateFrom = dateFrom;
  const dateTo = q("to");
  if (dateTo) filters.dateTo = dateTo;

  const dmin = q("dmin");
  if (dmin) {
    const n = Number(dmin);
    if (Number.isFinite(n)) filters.durationMin = n;
  }
  const dmax = q("dmax");
  if (dmax) {
    const n = Number(dmax);
    if (Number.isFinite(n)) filters.durationMax = n;
  }

  const sort = q("sort");
  if (sort && VALID_SORTS.has(sort as DashboardSort)) filters.sort = sort as DashboardSort;

  const cursor = q("cursor");
  if (cursor) filters.cursor = cursor;

  return filters;
}
