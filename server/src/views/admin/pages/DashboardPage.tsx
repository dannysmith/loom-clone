import type { Tag, Video } from "../../../db/schema";
import type { DashboardFilters } from "../../../lib/store";
import { AdminLayout } from "../../layouts/AdminLayout";
import {
  IconArrowDown,
  IconArrowUp,
  IconEyeOff,
  IconGlobe,
  IconGrid,
  IconLink,
  IconList,
  IconUpload,
} from "../components/Icons";
import { VideoList } from "../partials/VideoList";

type Props = {
  videos: Video[];
  nextCursor: string | null;
  filters: DashboardFilters;
  tags: Tag[];
  diskSizes: Record<string, number>;
  view: string;
};

const SORT_FIELDS = [
  { value: "date", label: "Date" },
  { value: "duration", label: "Duration" },
  { value: "title", label: "Title" },
  { value: "size", label: "Size" },
] as const;

const VISIBILITY_OPTIONS = [
  { value: "", label: "All" },
  { value: "public", label: "Public", icon: "globe" },
  { value: "unlisted", label: "Unlisted", icon: "link" },
  { value: "private", label: "Private", icon: "eye-off" },
] as const;

const STATUS_OPTIONS = [
  { value: "", label: "All" },
  { value: "recording", label: "Recording" },
  { value: "healing", label: "Healing" },
  { value: "complete", label: "Complete" },
  { value: "processing", label: "Processing" },
  { value: "failed", label: "Failed" },
] as const;

// HTMX attributes shared by all filter/sort controls
const HX = {
  "hx-get": "/admin/partials/video-list",
  "hx-target": "#video-list",
  "hx-swap": "outerHTML",
  "hx-include": "[data-filter]",
  "hx-replace-url": "/admin",
} as const;

function visibilityIcon(v: string, size: number) {
  switch (v) {
    case "public":
      return <IconGlobe size={size} />;
    case "unlisted":
      return <IconLink size={size} />;
    case "private":
      return <IconEyeOff size={size} />;
    default:
      return null;
  }
}

export function DashboardPage({ videos, nextCursor, filters, tags, diskSizes, view }: Props) {
  const sort = filters.sort ?? "date-desc";
  const [sortField, sortDir] = sort.split("-") as [string, string];

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
        {/* Row 1: Search + Sort + View toggle */}
        <div class="dashboard-toolbar-row">
          <input
            class="input dashboard-search"
            type="search"
            name="q"
            placeholder={"Search videos\u2026"}
            value={filters.search ?? ""}
            hx-trigger="input changed delay:500ms, search"
            {...HX}
          />

          <div class="dashboard-sort-group">
            <select id="sort-field" class="input" data-sort-field onchange="updateSort()">
              {SORT_FIELDS.map((f) => (
                <option value={f.value} selected={sortField === f.value}>
                  {f.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              class="sort-dir-btn"
              data-sort-dir={sortDir}
              onclick="toggleSortDir()"
              aria-label={sortDir === "asc" ? "Ascending" : "Descending"}
              title={sortDir === "asc" ? "Ascending" : "Descending"}
            >
              {sortDir === "asc" ? <IconArrowUp size={16} /> : <IconArrowDown size={16} />}
            </button>
            <input
              type="hidden"
              id="sort-value"
              name="sort"
              value={sort}
              data-filter
              hx-trigger="change"
              {...HX}
            />
          </div>

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

        {/* Row 2: Filter pills */}
        <div class="dashboard-filters">
          {/* Visibility */}
          <div class="filter-group">
            <span class="filter-group-label">Visibility</span>
            {VISIBILITY_OPTIONS.map((v) => (
              <label class={`filter-pill ${v.value ? `filter-pill--${v.value}` : ""}`}>
                <input
                  type="radio"
                  name="visibility"
                  value={v.value}
                  checked={filters.visibility === v.value || (!v.value && !filters.visibility)}
                  data-filter
                  hx-trigger="change"
                  {...HX}
                />
                <span class="filter-pill-label">
                  {visibilityIcon(v.value, 12)}
                  {v.label}
                </span>
              </label>
            ))}
          </div>

          {/* Status */}
          <div class="filter-group">
            <span class="filter-group-label">Status</span>
            {STATUS_OPTIONS.map((s) => (
              <label class={`filter-pill ${s.value ? `filter-pill--${s.value}` : ""}`}>
                <input
                  type="radio"
                  name="status"
                  value={s.value}
                  checked={filters.status === s.value || (!s.value && !filters.status)}
                  data-filter
                  hx-trigger="change"
                  {...HX}
                />
                <span class="filter-pill-label">{s.label}</span>
              </label>
            ))}
          </div>

          {/* Tags (multi-select) */}
          {tags.length > 0 && (
            <div class="filter-group">
              <span class="filter-group-label">Tags</span>
              {tags.map((t) => (
                <label class="filter-tag-pill">
                  <input
                    type="checkbox"
                    data-tag-id={String(t.id)}
                    checked={filters.tagIds?.includes(t.id) ?? false}
                    onchange="updateTagFilter()"
                  />
                  <span class="tag-chip" style={`--chip-color: var(--tag-${t.color})`}>
                    {t.name}
                  </span>
                </label>
              ))}
              <input
                type="hidden"
                id="tag-filter-value"
                name="tag"
                value={filters.tagIds?.join(",") ?? ""}
                data-filter
                hx-trigger="change"
                {...HX}
              />
            </div>
          )}
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

      <script
        dangerouslySetInnerHTML={{
          __html: `
function updateSort() {
  var field = document.querySelector('[data-sort-field]').value;
  var dir = document.querySelector('[data-sort-dir]').dataset.sortDir;
  var hidden = document.getElementById('sort-value');
  hidden.value = field + '-' + dir;
  htmx.trigger(hidden, 'change');
}
function toggleSortDir() {
  var btn = document.querySelector('[data-sort-dir]');
  var dir = btn.dataset.sortDir === 'asc' ? 'desc' : 'asc';
  btn.dataset.sortDir = dir;
  btn.innerHTML = dir === 'asc'
    ? '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 7-7 7 7"/><path d="M12 19V5"/></svg>'
    : '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="m19 12-7 7-7-7"/></svg>';
  btn.title = dir === 'asc' ? 'Ascending' : 'Descending';
  updateSort();
}
function updateTagFilter() {
  var checks = document.querySelectorAll('.filter-tag-pill input[type=checkbox]');
  var ids = [];
  checks.forEach(function(c) { if (c.checked) ids.push(c.dataset.tagId); });
  var hidden = document.getElementById('tag-filter-value');
  if (hidden) {
    hidden.value = ids.join(',');
    htmx.trigger(hidden, 'change');
  }
}
`,
        }}
      />
    </AdminLayout>
  );
}

function viewToggleUrl(filters: DashboardFilters, view: string): string {
  const params = new URLSearchParams();
  if (filters.search) params.set("q", filters.search);
  if (filters.visibility) params.set("visibility", filters.visibility);
  if (filters.status) params.set("status", filters.status);
  if (filters.tagIds?.length) params.set("tag", filters.tagIds.join(","));
  if (filters.sort && filters.sort !== "date-desc") params.set("sort", filters.sort);
  params.set("view", view);
  const qs = params.toString();
  return `/admin${qs ? `?${qs}` : ""}`;
}
