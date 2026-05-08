import { Hono } from "hono";
import type { Video } from "../../db/schema";
import { getVideosDirSizes } from "../../lib/files";
import { type DashboardFilters, listVideosFiltered } from "../../lib/store";
import { listTags } from "../../lib/tags";
import { DashboardPage } from "../../views/admin/pages/DashboardPage";
import { VideoList, VideoListAppend } from "../../views/admin/partials/VideoList";
import type { AdminEnv } from "./helpers";
import { parseFilters } from "./helpers";

const dashboard = new Hono<AdminEnv>();

// For size sort, listVideosFiltered returns ALL matching rows (can't sort by
// size in SQL). This helper does the in-memory sort and pagination.
function sizeSortAndPaginate(
  videos: Video[],
  diskSizes: Record<string, number>,
  sort: DashboardFilters["sort"],
  limit: number,
): { items: Video[]; nextCursor: string | null } {
  const sorted = [...videos].sort((a, b) => {
    const sA = diskSizes[a.id] ?? 0;
    const sB = diskSizes[b.id] ?? 0;
    return sort === "size-asc" ? sA - sB : sB - sA;
  });
  const items = sorted.slice(0, limit);
  const lastItem = items[items.length - 1];
  const nextCursor = sorted.length > limit && lastItem ? lastItem.id : null;
  return { items, nextCursor };
}

dashboard.get("/", async (c) => {
  const filters = parseFilters(c);
  const view = c.req.query("view") || "grid";
  const sort = filters.sort ?? "date-desc";
  const isSizeSort = sort === "size-desc" || sort === "size-asc";

  const [result, tags] = await Promise.all([listVideosFiltered(filters), listTags()]);
  const diskSizes = await getVideosDirSizes(result.items.map((v) => v.id));

  const { items, nextCursor } = isSizeSort
    ? sizeSortAndPaginate(result.items, diskSizes, sort, 20)
    : result;

  return c.html(
    <DashboardPage
      videos={items}
      nextCursor={nextCursor}
      filters={filters}
      tags={tags}
      diskSizes={diskSizes}
      view={view}
    />,
  );
});

// HTMX partial — returns just the video list (or appended batch for pagination).
dashboard.get("/partials/video-list", async (c) => {
  const filters = parseFilters(c);
  const view = c.req.query("view") || "grid";
  const sort = filters.sort ?? "date-desc";
  const isSizeSort = sort === "size-desc" || sort === "size-asc";

  const result = await listVideosFiltered(filters);
  const diskSizes = await getVideosDirSizes(result.items.map((v) => v.id));

  const { items, nextCursor } = isSizeSort
    ? sizeSortAndPaginate(result.items, diskSizes, sort, 20)
    : result;

  // If there's a cursor, we're loading more — return just the new cards + button.
  if (filters.cursor && !isSizeSort) {
    return c.html(
      <VideoListAppend
        videos={items}
        nextCursor={nextCursor}
        filters={filters}
        diskSizes={diskSizes}
        view={view}
      />,
    );
  }

  return c.html(
    <VideoList
      videos={items}
      nextCursor={nextCursor}
      filters={filters}
      diskSizes={diskSizes}
      view={view}
    />,
  );
});

export default dashboard;
