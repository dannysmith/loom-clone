import type { Tag, Video, VideoEvent } from "../../../db/schema";
import type { FileEntry } from "../../../lib/files";
import { formatFileSize } from "../../../lib/files";
import { formatDate, formatDuration } from "../../../lib/format";
import { AdminLayout } from "../../layouts/AdminLayout";

type Props = {
  video: Video;
  tags: Tag[];
  events: VideoEvent[];
  files: FileEntry[];
  activeTab: "events" | "files";
};

export function VideoDetailPage({ video, tags, events, files, activeTab }: Props) {
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
          <h1>{title}</h1>
          <span class="video-slug">/{video.slug}</span>
        </div>
        <span class={`badge badge--${video.visibility}`}>{video.visibility}</span>
      </div>

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
          <MetaField label="Status">
            <span class={`badge badge--${video.status}`}>{video.status}</span>
          </MetaField>
          {duration && <MetaField label="Duration">{duration}</MetaField>}
          {video.width && video.height && (
            <MetaField label="Dimensions">
              {video.width}&times;{video.height}
            </MetaField>
          )}
          <MetaField label="Source">{video.source}</MetaField>
          <MetaField label="Created">{formatDate(video.createdAt)}</MetaField>
          {video.completedAt && (
            <MetaField label="Completed">{formatDate(video.completedAt)}</MetaField>
          )}
        </div>

        {video.description && (
          <div class="video-description">
            <h3>Description</h3>
            <p>{video.description}</p>
          </div>
        )}

        {tags.length > 0 && (
          <div class="video-tags">
            <h3>Tags</h3>
            <div class="video-tags-list">
              {tags.map((t) => (
                <span class="badge" style={`background-color: var(--tag-${t.color}); color: #fff`}>
                  {t.name}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* --- Tabs --- */}
      <div class="video-tabs">
        <a
          href={`/admin/videos/${video.id}?tab=events`}
          class={`settings-tab ${activeTab === "events" ? "active" : ""}`}
        >
          Events ({events.length})
        </a>
        <a
          href={`/admin/videos/${video.id}?tab=files`}
          class={`settings-tab ${activeTab === "files" ? "active" : ""}`}
        >
          Files ({files.filter((f) => !f.isDirectory).length})
        </a>
      </div>

      {activeTab === "events" ? (
        <EventLog events={events} />
      ) : (
        <FileBrowser files={files} />
      )}
    </AdminLayout>
  );
}

function MetaField({ label, children }: { label: string; children: unknown }) {
  return (
    <div class="meta-field">
      <dt>{label}</dt>
      <dd>{children}</dd>
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
      {files.map((f) => (
        <div class={`file-row ${f.isDirectory ? "file-row--dir" : ""}`}>
          <span class="file-icon">{f.isDirectory ? "\uD83D\uDCC1" : "\uD83D\uDCC4"}</span>
          <span class="file-path">{f.path}</span>
          {!f.isDirectory && <span class="file-size">{formatFileSize(f.size)}</span>}
        </div>
      ))}
    </div>
  );
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
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
