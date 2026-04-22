import type { Tag, Video, VideoEvent } from "../../../db/schema";
import type { FileEntry } from "../../../lib/files";
import { formatFileSize } from "../../../lib/files";
import { formatDate, formatDateTime, formatDuration } from "../../../lib/format";
import { AdminLayout } from "../../layouts/AdminLayout";
import { IconClock } from "../components/Icons";
import { VideoActions } from "../partials/VideoActions";
import {
  DescriptionDisplay,
  SlugDisplay,
  TitleDisplay,
  VideoTagsControl,
  VisibilityDisplay,
} from "../partials/VideoFields";

type Props = {
  video: Video;
  videoTags: Tag[];
  allTags: Tag[];
  events: VideoEvent[];
  files: FileEntry[];
  activeTab: "events" | "files";
};

export function VideoDetailPage({ video, videoTags, allTags, events, files, activeTab }: Props) {
  const title = video.title || video.slug;
  const duration = formatDuration(video.durationSeconds);
  const hasMp4 = files.some((f) => f.path === "derivatives/source.mp4");
  const playerSrc = hasMp4
    ? `/admin/videos/${video.id}/media/raw/source.mp4`
    : `/admin/videos/${video.id}/media/stream/stream.m3u8`;
  const posterSrc = `/admin/videos/${video.id}/media/poster.jpg`;

  return (
    <AdminLayout
      title={title}
      head={
        <>
          <link rel="stylesheet" href="https://cdn.vidstack.io/player/theme.css" />
          <link rel="stylesheet" href="https://cdn.vidstack.io/player/video.css" />
          <script type="module" src="https://cdn.vidstack.io/player" />
        </>
      }
    >
      {/* --- Header --- */}
      <div class="video-header">
        <div class="video-header-title">
          <TitleDisplay video={video} />
          <SlugDisplay video={video} />
          <VisibilityDisplay video={video} />
        </div>
      </div>

      {/* --- Actions --- */}
      <VideoActions video={video} />

      {/* --- Player --- */}
      <div class="video-player-container">
        <media-player src={playerSrc} poster={posterSrc} playsinline>
          <media-provider />
          <media-video-layout />
        </media-player>
      </div>

      {/* --- Metadata --- */}
      <div class="video-meta">
        <div class="video-meta-grid">
          <span class={`badge badge--${video.status}`}>{video.status}</span>
          {duration && (
            <span class="duration-pill">
              <IconClock size={14} />
              {duration}
            </span>
          )}
          {video.width && video.height && (
            <span class="meta-pill">
              {video.width}&times;{video.height}
            </span>
          )}
          {video.source === "uploaded" && <span class="meta-pill">uploaded</span>}
          <span class="meta-pill">{formatDate(video.createdAt)}</span>
          <span
            class="meta-pill meta-pill--id"
            title="Click to copy ID"
            onclick={`copyText('${video.id}');this.title='Copied!'`}
          >
            {video.id}
          </span>
        </div>

        <div class="video-description">
          <h3>Description</h3>
          <DescriptionDisplay video={video} />
        </div>

        <div class="video-tags-section">
          <h3>Tags</h3>
          <VideoTagsControl video={video} videoTags={videoTags} allTags={allTags} />
        </div>
      </div>

      {/* --- Tabs --- */}
      <VideoTabsSection video={video} events={events} files={files} activeTab={activeTab} />
    </AdminLayout>
  );
}

export function VideoTabsSection({
  video,
  events,
  files,
  activeTab,
}: {
  video: Video;
  events: VideoEvent[];
  files: FileEntry[];
  activeTab: "events" | "files";
}) {
  return (
    <div
      id="video-tabs-section"
      hx-get={`/admin/videos/${video.id}/partials/tabs?tab=${activeTab}`}
      hx-trigger="video-updated from:body"
      hx-swap="outerHTML"
    >
      <div class="video-tabs">
        <a
          href={`/admin/videos/${video.id}?tab=events`}
          hx-get={`/admin/videos/${video.id}/partials/tabs?tab=events`}
          hx-target="#video-tabs-section"
          hx-swap="outerHTML"
          hx-push-url="false"
          class={`settings-tab ${activeTab === "events" ? "active" : ""}`}
        >
          Events ({events.length})
        </a>
        <a
          href={`/admin/videos/${video.id}?tab=files`}
          hx-get={`/admin/videos/${video.id}/partials/tabs?tab=files`}
          hx-target="#video-tabs-section"
          hx-swap="outerHTML"
          hx-push-url="false"
          class={`settings-tab ${activeTab === "files" ? "active" : ""}`}
        >
          Files ({files.filter((f) => !f.isDirectory).length})
        </a>
      </div>
      {activeTab === "events" ? <EventLog events={events} /> : <FileBrowser files={files} />}
    </div>
  );
}

function EventLog({ events }: { events: VideoEvent[] }) {
  if (events.length === 0) {
    return <p class="empty-state">No events recorded.</p>;
  }
  return (
    <div class="event-log">
      {events.map((e) => {
        const data = e.data ? tryParseJson(e.data) : null;
        return (
          <div class="event-row">
            <time class="event-time">{formatDateTime(e.createdAt)}</time>
            <span class="event-type">{e.type}</span>
            {data && <span class="event-data">{formatEventData(data)}</span>}
          </div>
        );
      })}
    </div>
  );
}

function FileBrowser({ files }: { files: FileEntry[] }) {
  if (files.length === 0) {
    return <p class="empty-state">No files found.</p>;
  }
  return (
    <div class="file-browser">
      {files.map((f) => {
        const parts = f.path.split("/");
        const depth = f.isDirectory ? 0 : parts.length - 1;
        const displayName = parts[parts.length - 1] ?? f.path;
        return (
          <div
            class={`file-row ${f.isDirectory ? "file-row--dir" : ""}`}
            style={
              depth > 0
                ? `padding-inline-start: calc(var(--space-3) + ${depth} * var(--space-5))`
                : undefined
            }
          >
            <span class="file-icon">{f.isDirectory ? "\uD83D\uDCC1" : "\uD83D\uDCC4"}</span>
            <span class="file-path">{displayName}</span>
            {!f.isDirectory && <span class="file-size">{formatFileSize(f.size)}</span>}
          </div>
        );
      })}
    </div>
  );
}

function tryParseJson(s: string): Record<string, unknown> | null {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function formatEventData(data: Record<string, unknown>): string {
  return Object.entries(data)
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ");
}
