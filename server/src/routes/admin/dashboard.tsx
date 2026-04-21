import { Hono } from "hono";
import { listVideosFiltered } from "../../lib/store";
import { listTags } from "../../lib/tags";
import { DashboardPage } from "../../views/admin/pages/DashboardPage";
import { VideoList, VideoListAppend } from "../../views/admin/partials/VideoList";
import type { AdminEnv } from "./helpers";
import { parseFilters } from "./helpers";

const dashboard = new Hono<AdminEnv>();

dashboard.get("/", async (c) => {
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
dashboard.get("/partials/video-list", async (c) => {
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

export default dashboard;
