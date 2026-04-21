import type { Video } from "../../../db/schema";
import type { DashboardFilters } from "../../../lib/store";
import { VideoCard } from "../components/VideoCard";

type Props = {
  videos: Video[];
  nextCursor: string | null;
  filters: DashboardFilters;
  view: string;
};

// Fragment partial returned by HTMX for search/filter/sort/pagination.
// Also used inline by DashboardPage for the initial render.
export function VideoList({ videos, nextCursor, filters, view }: Props) {
  if (videos.length === 0 && !filters.cursor) {
    return (
      <div id="video-list" class="video-list-empty" data-view={view}>
        <p class="empty-state">No videos match your filters.</p>
      </div>
    );
  }

  return (
    <div id="video-list" data-view={view}>
      <div class="video-list-items">
        {videos.map((v) => (
          <VideoCard video={v} />
        ))}
        {nextCursor && <LoadMoreButton nextCursor={nextCursor} filters={filters} view={view} />}
      </div>
    </div>
  );
}

// Self-replacing "Load More" button. When clicked, HTMX fetches the next
// page and swaps this button's outerHTML with the new batch of cards +
// a new Load More button (if there are more).
function LoadMoreButton({
  nextCursor,
  filters,
  view,
}: {
  nextCursor: string;
  filters: DashboardFilters;
  view: string;
}) {
  const params = buildQueryString({ ...filtersToParams(filters), cursor: nextCursor, view });
  return (
    <div id="load-more">
      <button
        type="button"
        class="btn load-more-btn"
        hx-get={`/admin/partials/video-list?${params}`}
        hx-target="#load-more"
        hx-swap="outerHTML"
      >
        Load more
      </button>
    </div>
  );
}

// Appended batch — when "Load More" is clicked, the server returns just the
// new cards + a new Load More button, meant to replace the old button.
export function VideoListAppend({ videos, nextCursor, filters, view }: Props) {
  return (
    <>
      {videos.map((v) => (
        <VideoCard video={v} />
      ))}
      {nextCursor && <LoadMoreButton nextCursor={nextCursor} filters={filters} view={view} />}
    </>
  );
}

// Converts DashboardFilters to URL query params (excluding cursor/limit).
function filtersToParams(f: DashboardFilters): Record<string, string> {
  const p: Record<string, string> = {};
  if (f.search) p.q = f.search;
  if (f.visibility) p.visibility = f.visibility;
  if (f.status) p.status = f.status;
  if (f.tagId != null) p.tag = String(f.tagId);
  if (f.dateFrom) p.from = f.dateFrom;
  if (f.dateTo) p.to = f.dateTo;
  if (f.durationMin != null) p.dmin = String(f.durationMin);
  if (f.durationMax != null) p.dmax = String(f.durationMax);
  if (f.sort && f.sort !== "date-desc") p.sort = f.sort;
  return p;
}

function buildQueryString(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}
