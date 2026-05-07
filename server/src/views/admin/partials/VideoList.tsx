import type { Video } from "../../../db/schema";
import type { DashboardFilters } from "../../../lib/store";
import { filtersToParams } from "../../../routes/admin/helpers";
import { VideoCard } from "../components/VideoCard";

type Props = {
  videos: Video[];
  nextCursor: string | null;
  filters: DashboardFilters;
  diskSizes: Record<string, number>;
  view: string;
};

// Fragment partial returned by HTMX for search/filter/sort/pagination.
// Also used inline by DashboardPage for the initial render.
export function VideoList({ videos, nextCursor, filters, diskSizes, view }: Props) {
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
          <VideoCard video={v} diskSize={diskSizes[v.id]} />
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
export function VideoListAppend({ videos, nextCursor, filters, diskSizes, view }: Props) {
  return (
    <>
      {videos.map((v) => (
        <VideoCard video={v} diskSize={diskSizes[v.id]} />
      ))}
      {nextCursor && <LoadMoreButton nextCursor={nextCursor} filters={filters} view={view} />}
    </>
  );
}

function buildQueryString(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}
