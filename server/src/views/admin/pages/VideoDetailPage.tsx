import type { Tag, Video, VideoEvent, VideoTranscript } from "../../../db/schema";
import type { FileEntry } from "../../../lib/files";
import { formatFileSize } from "../../../lib/files";
import { formatDate, formatDateTime, formatDuration } from "../../../lib/format";
import type { ThumbnailCandidate } from "../../../lib/thumbnails";
import { AdminLayout } from "../../layouts/AdminLayout";
import {
  FileTypeIcon,
  IconAlertTriangle,
  IconCalendar,
  IconCamera,
  IconClock,
  IconHardDrive,
  IconMic,
  IconRuler,
  IconUploadCloud,
} from "../components/Icons";
import { ThumbnailPicker } from "../partials/ThumbnailPicker";
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
  thumbnailCandidates: ThumbnailCandidate[];
  transcript: VideoTranscript | undefined;
  activeTab: "events" | "files" | "transcript";
};

export function VideoDetailPage({
  video,
  videoTags,
  allTags,
  events,
  files,
  thumbnailCandidates,
  transcript,
  activeTab,
}: Props) {
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
          <link
            rel="stylesheet"
            href="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.11.1/build/styles/github.min.css"
            media="(prefers-color-scheme: light)"
          />
          <link
            rel="stylesheet"
            href="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.11.1/build/styles/github-dark.min.css"
            media="(prefers-color-scheme: dark)"
          />
          <script src="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.11.1/build/highlight.min.js" />
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
          {video.lastEditedAt && (
            <a
              href={`/admin/videos/${video.id}/editor`}
              class="badge badge--edited"
              title={`Edited ${formatDateTime(video.lastEditedAt)}`}
            >
              edited
            </a>
          )}
          {duration && (
            <span class="meta-pill">
              <IconClock size={14} />
              {duration}
            </span>
          )}
          <span class="meta-pill">
            <IconCalendar size={14} />
            {formatDate(video.createdAt)}
          </span>
          {video.width && video.height && (
            <span class="meta-pill">
              <IconRuler size={14} />
              {video.width}&times;{video.height}
            </span>
          )}
          {video.fileBytes != null && (
            <span class="meta-pill">
              <IconHardDrive size={14} />
              {formatFileSize(video.fileBytes)}
            </span>
          )}
          {video.source === "uploaded" && (
            <span class="meta-pill">
              <IconUploadCloud size={14} />
              uploaded
            </span>
          )}
          {video.cameraName && (
            <span class="meta-pill" title="Camera">
              <IconCamera size={14} />
              {video.cameraName}
            </span>
          )}
          {video.microphoneName && (
            <span class="meta-pill" title="Microphone">
              <IconMic size={14} />
              {video.microphoneName}
            </span>
          )}
          {video.recordingHealth && (
            <span class="meta-pill meta-pill--warning" title="Recording health">
              <IconAlertTriangle size={14} />
              {video.recordingHealth.replace("_", " ")}
            </span>
          )}
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

      {/* --- Thumbnail picker --- */}
      <ThumbnailPicker video={video} candidates={thumbnailCandidates} />

      {/* --- Tabs --- */}
      <VideoTabsSection
        video={video}
        events={events}
        files={files}
        transcript={transcript}
        activeTab={activeTab}
      />

      <dialog id="file-preview-dialog" class="file-preview-dialog">
        <div id="file-preview-content" />
      </dialog>
    </AdminLayout>
  );
}

export function VideoTabsSection({
  video,
  events,
  files,
  transcript,
  activeTab,
}: {
  video: Video;
  events: VideoEvent[];
  files: FileEntry[];
  transcript: VideoTranscript | undefined;
  activeTab: "events" | "files" | "transcript";
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
        <a
          href={`/admin/videos/${video.id}?tab=transcript`}
          hx-get={`/admin/videos/${video.id}/partials/tabs?tab=transcript`}
          hx-target="#video-tabs-section"
          hx-swap="outerHTML"
          hx-push-url="false"
          class={`settings-tab ${activeTab === "transcript" ? "active" : ""}`}
        >
          Transcript{transcript ? ` (${transcript.wordCount} words)` : ""}
        </a>
      </div>
      {activeTab === "events" ? (
        <EventLog events={events} />
      ) : activeTab === "transcript" ? (
        <TranscriptView transcript={transcript} />
      ) : (
        <FileBrowser files={files} videoId={video.id} />
      )}
    </div>
  );
}

function TranscriptView({ transcript }: { transcript: VideoTranscript | undefined }) {
  if (!transcript) {
    return (
      <p class="empty-state">
        No transcript available. Transcription runs automatically after recording.
      </p>
    );
  }
  return (
    <div class="transcript-view">
      <div class="transcript-meta">
        <span class="meta-pill">{transcript.wordCount} words</span>
        <span class="meta-pill">{transcript.format.toUpperCase()}</span>
        <span class="meta-pill">{formatDateTime(transcript.createdAt)}</span>
      </div>
      <div class="transcript-text">{transcript.plainText}</div>
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

const TEXT_EXTENSIONS = new Set([
  ".json",
  ".m3u8",
  ".txt",
  ".log",
  ".xml",
  ".html",
  ".css",
  ".js",
  ".ts",
  ".md",
]);

function isTextFile(path: string): boolean {
  const dot = path.lastIndexOf(".");
  return dot !== -1 && TEXT_EXTENSIONS.has(path.substring(dot));
}

function FileBrowser({ files, videoId }: { files: FileEntry[]; videoId: string }) {
  if (files.length === 0) {
    return <p class="empty-state">No files found.</p>;
  }
  return (
    <div class="file-browser">
      {files.map((f) => {
        const parts = f.path.split("/");
        const depth = f.isDirectory ? 0 : parts.length - 1;
        const displayName = parts[parts.length - 1] ?? f.path;
        const previewable = !f.isDirectory && isTextFile(f.path);
        return (
          <div
            class={`file-row ${f.isDirectory ? "file-row--dir" : ""} ${previewable ? "file-row--previewable" : ""}`}
            style={
              depth > 0
                ? `padding-inline-start: calc(var(--space-3) + ${depth} * var(--space-5))`
                : undefined
            }
            {...(previewable
              ? {
                  "hx-get": `/admin/videos/${videoId}/partials/file-preview?path=${encodeURIComponent(f.path)}`,
                  "hx-target": "#file-preview-content",
                  "hx-swap": "innerHTML",
                }
              : {})}
          >
            <span class="file-icon">
              <FileTypeIcon path={f.path} isDirectory={f.isDirectory} />
            </span>
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
