import type { Context } from "hono";
import { VALID_STATUS } from "../../lib/status";
import { type DashboardFilters, type DashboardSort, getVideo, type Video } from "../../lib/store";

export type AdminEnv = { Variables: { adminAuthMethod: string } };

// Query param ↔ DashboardFilters mapping. Both parseFilters and
// filtersToParams use these same names, so changes to the URL schema
// only need updating in one place.

const VALID_SORTS = new Set<DashboardSort>([
  "date-desc",
  "date-asc",
  "duration-desc",
  "duration-asc",
  "title-asc",
  "title-desc",
  "size-desc",
  "size-asc",
]);

const VALID_VISIBILITY = new Set(["public", "unlisted", "private"]);

/** Parses DashboardFilters from URL query params. */
export function parseFilters(c: Context): DashboardFilters {
  const filters: DashboardFilters = {};
  const q = (key: string) => c.req.query(key);

  const search = q("q")?.trim();
  if (search) filters.search = search;

  const visibility = q("visibility");
  if (visibility && VALID_VISIBILITY.has(visibility))
    filters.visibility = visibility as DashboardFilters["visibility"];

  const status = q("status");
  if (status && VALID_STATUS.has(status)) filters.status = status as DashboardFilters["status"];

  if (q("attention") === "1") filters.needsAttention = true;

  const tag = q("tag");
  if (tag) {
    const ids = tag.split(",").map(Number).filter(Number.isFinite);
    if (ids.length) filters.tagIds = ids;
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

/**
 * Serializes DashboardFilters to URL query params (excluding cursor/limit).
 * The single source of truth for filter→query mapping — both `filtersToParams`
 * and the dashboard's view-toggle links call this, so a new filter can't be
 * added to one and forgotten in the other. Round-trips against `parseFilters`.
 */
export function serializeFilters(f: DashboardFilters): URLSearchParams {
  const p = new URLSearchParams();
  if (f.search) p.set("q", f.search);
  if (f.visibility) p.set("visibility", f.visibility);
  if (f.status) p.set("status", f.status);
  if (f.needsAttention) p.set("attention", "1");
  if (f.tagIds?.length) p.set("tag", f.tagIds.join(","));
  if (f.dateFrom) p.set("from", f.dateFrom);
  if (f.dateTo) p.set("to", f.dateTo);
  if (f.durationMin != null) p.set("dmin", String(f.durationMin));
  if (f.durationMax != null) p.set("dmax", String(f.durationMax));
  if (f.sort && f.sort !== "date-desc") p.set("sort", f.sort);
  return p;
}

/** Converts DashboardFilters back to a plain query-param record. */
export function filtersToParams(f: DashboardFilters): Record<string, string> {
  return Object.fromEntries(serializeFilters(f));
}

// Loads a video by :id param, including trashed videos (admin can see
// everything). Returns the video or a 404 text response.
export async function requireVideo(c: Context<AdminEnv>): Promise<Video | Response> {
  const id = c.req.param("id") as string;
  const video = await getVideo(id, { includeTrashed: true });
  if (!video) return c.text("Video not found", 404);
  return video;
}
