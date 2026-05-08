import type { Context } from "hono";
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
const VALID_STATUS = new Set(["recording", "healing", "complete", "processing", "failed"]);

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

/** Converts DashboardFilters back to URL query params (excluding cursor/limit). */
export function filtersToParams(f: DashboardFilters): Record<string, string> {
  const p: Record<string, string> = {};
  if (f.search) p.q = f.search;
  if (f.visibility) p.visibility = f.visibility;
  if (f.status) p.status = f.status;
  if (f.tagIds?.length) p.tag = f.tagIds.join(",");
  if (f.dateFrom) p.from = f.dateFrom;
  if (f.dateTo) p.to = f.dateTo;
  if (f.durationMin != null) p.dmin = String(f.durationMin);
  if (f.durationMax != null) p.dmax = String(f.durationMax);
  if (f.sort && f.sort !== "date-desc") p.sort = f.sort;
  return p;
}

// Loads a video by :id param, including trashed videos (admin can see
// everything). Returns the video or a 404 text response.
export async function requireVideo(c: Context<AdminEnv>): Promise<Video | Response> {
  const id = c.req.param("id") as string;
  const video = await getVideo(id, { includeTrashed: true });
  if (!video) return c.text("Video not found", 404);
  return video;
}
