import type { Tag, Video } from "../../../db/schema";
import type { DashboardFilters, DashboardSort } from "../../../lib/store";
import { AdminLayout } from "../../layouts/AdminLayout";
import { IconGrid, IconList, IconUpload } from "../components/Icons";
import { VideoList } from "../partials/VideoList";

type Props = {
  videos: Video[];
  nextCursor: string | null;
  filters: DashboardFilters;
  tags: Tag[];
  diskSizes: Record<string, number>;
  view: string;
};

const SORT_OPTIONS: Array<{ value: DashboardSort; label: string }> = [
  { value: "date-desc", label: "Newest" },
  { value: "date-asc", label: "Oldest" },
  { value: "duration-desc", label: "Longest" },
  { value: "duration-asc", label: "Shortest" },
  { value: "title-asc", label: "Title A\u2013Z" },
  { value: "title-desc", label: "Title Z\u2013A" },
];

const VISIBILITY_OPTIONS = ["", "public", "unlisted", "private"] as const;
const STATUS_OPTIONS = ["", "recording", "healing", "complete", "failed"] as const;

export function DashboardPage({ videos, nextCursor, filters, tags, diskSizes, view }: Props) {
  const sort = filters.sort ?? "date-desc";

  return (
    <AdminLayout title="Dashboard" activePage="dashboard">
      <div class="page-header">
        <h1>Dashboard</h1>
        <a href="/admin/upload" class="btn btn--primary">
          <IconUpload size={16} />
          Upload
        </a>
      </div>

      <div class="dashboard-toolbar">
        <input
          class="input dashboard-search"
          type="search"
          name="q"
          placeholder={"Search videos\u2026"}
          value={filters.search ?? ""}
          hx-get="/admin/partials/video-list"
          hx-trigger="input changed delay:500ms, search"
          hx-target="#video-list"
          hx-swap="outerHTML"
          hx-include="[data-filter]"
          hx-replace-url="/admin"
        />

        <div class="dashboard-controls">
          <select
            class="input filter-select"
            name="visibility"
            data-filter
            hx-get="/admin/partials/video-list"
            hx-trigger="change"
            hx-target="#video-list"
            hx-swap="outerHTML"
            hx-include="[data-filter]"
            hx-replace-url="/admin"
          >
            {VISIBILITY_OPTIONS.map((v) => (
              <option value={v} selected={filters.visibility === v || (!v && !filters.visibility)}>
                {v || "All visibility"}
              </option>
            ))}
          </select>

          <select
            class="input filter-select"
            name="status"
            data-filter
            hx-get="/admin/partials/video-list"
            hx-trigger="change"
            hx-target="#video-list"
            hx-swap="outerHTML"
            hx-include="[data-filter]"
            hx-replace-url="/admin"
          >
            {STATUS_OPTIONS.map((s) => (
              <option value={s} selected={filters.status === s || (!s && !filters.status)}>
                {s || "All status"}
              </option>
            ))}
          </select>

          {tags.length > 0 && (
            <select
              class="input filter-select"
              name="tag"
              data-filter
              hx-get="/admin/partials/video-list"
              hx-trigger="change"
              hx-target="#video-list"
              hx-swap="outerHTML"
              hx-include="[data-filter]"
              hx-replace-url="/admin"
            >
              <option value="" selected={filters.tagId == null}>
                All tags
              </option>
              {tags.map((t) => (
                <option value={String(t.id)} selected={filters.tagId === t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          )}

          <select
            class="input filter-select"
            name="sort"
            data-filter
            hx-get="/admin/partials/video-list"
            hx-trigger="change"
            hx-target="#video-list"
            hx-swap="outerHTML"
            hx-include="[data-filter]"
            hx-replace-url="/admin"
          >
            {SORT_OPTIONS.map((o) => (
              <option value={o.value} selected={sort === o.value}>
                {o.label}
              </option>
            ))}
          </select>

          <div class="dashboard-view-toggle">
            <a
              href={viewToggleUrl(filters, "grid")}
              class={`view-toggle-btn ${view === "grid" ? "active" : ""}`}
              aria-label="Grid view"
            >
              <IconGrid size={16} />
            </a>
            <a
              href={viewToggleUrl(filters, "table")}
              class={`view-toggle-btn ${view === "table" ? "active" : ""}`}
              aria-label="Table view"
            >
              <IconList size={16} />
            </a>
          </div>
        </div>
      </div>

      <input type="hidden" name="view" value={view} data-filter />

      <VideoList
        videos={videos}
        nextCursor={nextCursor}
        filters={filters}
        diskSizes={diskSizes}
        view={view}
      />
    </AdminLayout>
  );
}

function viewToggleUrl(filters: DashboardFilters, view: string): string {
  const params = new URLSearchParams();
  if (filters.search) params.set("q", filters.search);
  if (filters.visibility) params.set("visibility", filters.visibility);
  if (filters.status) params.set("status", filters.status);
  if (filters.tagId != null) params.set("tag", String(filters.tagId));
  if (filters.sort && filters.sort !== "date-desc") params.set("sort", filters.sort);
  params.set("view", view);
  const qs = params.toString();
  return `/admin${qs ? `?${qs}` : ""}`;
}
