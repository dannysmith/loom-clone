import { raw } from "hono/html";
import { marked } from "marked";
import type { Tag, Video } from "../../../db/schema";
import { IconCalendar, IconShuffle, IconWand, VisibilityBadge } from "../components/Icons";

marked.setOptions({ breaks: true });

// --- Title ---

export function TitleDisplay({ video }: { video: Video }) {
  const title = video.title || video.slug;
  return (
    <div id="field-title" class="editable-field">
      <h1 class="editable-value">{title}</h1>
      <button
        type="button"
        class="btn btn--sm editable-trigger"
        hx-get={`/admin/videos/${video.id}/partials/title/edit`}
        hx-target="#field-title"
        hx-swap="outerHTML"
      >
        Edit
      </button>
    </div>
  );
}

export function TitleEdit({ video }: { video: Video }) {
  return (
    <form
      id="field-title"
      class="editable-field editable-field--editing"
      hx-patch={`/admin/videos/${video.id}/title`}
      hx-target="#field-title"
      hx-swap="outerHTML"
    >
      <input
        class="input editable-input editable-input--title"
        type="text"
        name="title"
        value={video.title ?? ""}
        placeholder="Untitled"
      />
      <button type="submit" class="btn btn--primary btn--sm">
        Save
      </button>
      <button
        type="button"
        class="btn btn--sm"
        hx-get={`/admin/videos/${video.id}/partials/title`}
        hx-target="#field-title"
        hx-swap="outerHTML"
      >
        Cancel
      </button>
    </form>
  );
}

// --- Slug ---

export function SlugDisplay({ video }: { video: Video }) {
  return (
    <div id="field-slug" class="editable-field editable-field--inline">
      <span class="video-slug">/{video.slug}</span>
      <button
        type="button"
        class="btn btn--sm editable-trigger"
        hx-get={`/admin/videos/${video.id}/partials/slug/edit`}
        hx-target="#field-slug"
        hx-swap="outerHTML"
      >
        Edit
      </button>
    </div>
  );
}

export function SlugEdit({ video, error }: { video: Video; error?: string }) {
  const recordingDate = video.createdAt.slice(0, 10);
  return (
    <form
      id="field-slug"
      class="slug-editor"
      hx-patch={`/admin/videos/${video.id}/slug`}
      hx-target="#field-slug"
      hx-swap="outerHTML"
    >
      <div class="slug-editor-row">
        <div class="editable-input-group">
          <span class="editable-prefix">/</span>
          <input
            class="input editable-input editable-input--slug"
            type="text"
            name="slug"
            value={video.slug}
            required
            hx-get={`/admin/videos/${video.id}/partials/slug/check`}
            hx-trigger="input changed delay:300ms"
            hx-target="#slug-validation"
            hx-swap="innerHTML"
            hx-include="this"
          />
        </div>
      </div>
      <div class="slug-editor-controls">
        <div class="slug-editor-tools">
          <button
            type="button"
            class="btn btn--sm btn--icon"
            title="Prepend recording date"
            data-date={recordingDate}
            onclick="slugPrependDate(this)"
          >
            <IconCalendar size={14} />
          </button>
          <button
            type="button"
            class="btn btn--sm btn--icon"
            title="Obfuscate with random characters"
            onclick="slugObfuscate(this)"
          >
            <IconShuffle size={14} />
          </button>
          {video.title && (
            <button
              type="button"
              class="btn btn--sm btn--icon"
              title="Generate from title"
              data-url={`/admin/videos/${video.id}/partials/slug/from-title`}
              onclick="slugFromTitle(this)"
            >
              <IconWand size={14} />
            </button>
          )}
        </div>
        <div class="slug-editor-actions">
          <button type="submit" class="btn btn--primary btn--sm">
            Save
          </button>
          <button
            type="button"
            class="btn btn--sm"
            hx-get={`/admin/videos/${video.id}/partials/slug`}
            hx-target="#field-slug"
            hx-swap="outerHTML"
          >
            Cancel
          </button>
        </div>
      </div>
      <div id="slug-validation">{error && <span class="editable-error">{error}</span>}</div>
    </form>
  );
}

// --- Description ---

export function DescriptionDisplay({ video }: { video: Video }) {
  return (
    <div id="field-description" class="editable-field">
      {video.description ? (
        <div class="editable-value editable-value--description">
          {raw(marked.parse(video.description) as string)}
        </div>
      ) : (
        <p class="editable-value editable-value--empty">No description</p>
      )}
      <button
        type="button"
        class="btn btn--sm editable-trigger"
        hx-get={`/admin/videos/${video.id}/partials/description/edit`}
        hx-target="#field-description"
        hx-swap="outerHTML"
      >
        Edit
      </button>
    </div>
  );
}

export function DescriptionEdit({ video }: { video: Video }) {
  return (
    <form
      id="field-description"
      class="editable-field editable-field--editing editable-field--block"
      hx-patch={`/admin/videos/${video.id}/description`}
      hx-target="#field-description"
      hx-swap="outerHTML"
    >
      <textarea
        class="input editable-textarea"
        name="description"
        rows={4}
        placeholder="Add a description"
      >
        {video.description ?? ""}
      </textarea>
      <div class="editable-actions">
        <button type="submit" class="btn btn--primary btn--sm">
          Save
        </button>
        <button
          type="button"
          class="btn btn--sm"
          hx-get={`/admin/videos/${video.id}/partials/description`}
          hx-target="#field-description"
          hx-swap="outerHTML"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

// --- Notes ---

export function NotesDisplay({ video }: { video: Video }) {
  return (
    <div id="field-notes" class="editable-field">
      {video.notes ? (
        <p class="editable-value editable-value--notes">{video.notes}</p>
      ) : (
        <p class="editable-value editable-value--empty">No notes</p>
      )}
      <button
        type="button"
        class="btn btn--sm editable-trigger"
        hx-get={`/admin/videos/${video.id}/partials/notes/edit`}
        hx-target="#field-notes"
        hx-swap="outerHTML"
      >
        Edit
      </button>
    </div>
  );
}

export function NotesEdit({ video }: { video: Video }) {
  return (
    <form
      id="field-notes"
      class="editable-field editable-field--editing editable-field--block"
      hx-patch={`/admin/videos/${video.id}/notes`}
      hx-target="#field-notes"
      hx-swap="outerHTML"
    >
      <textarea
        class="input editable-textarea"
        name="notes"
        rows={3}
        placeholder="Private notes (only visible here)"
      >
        {video.notes ?? ""}
      </textarea>
      <div class="editable-actions">
        <button type="submit" class="btn btn--primary btn--sm">
          Save
        </button>
        <button
          type="button"
          class="btn btn--sm"
          hx-get={`/admin/videos/${video.id}/partials/notes`}
          hx-target="#field-notes"
          hx-swap="outerHTML"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

// --- Visibility ---

export function VisibilityDisplay({ video }: { video: Video }) {
  return (
    <div id="field-visibility" class="editable-field editable-field--inline">
      <VisibilityBadge visibility={video.visibility} />
      <button
        type="button"
        class="btn btn--sm editable-trigger"
        hx-get={`/admin/videos/${video.id}/partials/visibility/edit`}
        hx-target="#field-visibility"
        hx-swap="outerHTML"
      >
        Edit
      </button>
    </div>
  );
}

export function VisibilityEdit({ video }: { video: Video }) {
  return (
    <form
      id="field-visibility"
      class="editable-field editable-field--editing"
      hx-patch={`/admin/videos/${video.id}/visibility`}
      hx-target="#field-visibility"
      hx-swap="outerHTML"
    >
      <select class="input editable-input" name="visibility">
        {(["public", "unlisted", "private"] as const).map((v) => (
          <option value={v} selected={video.visibility === v}>
            {v}
          </option>
        ))}
      </select>
      <button type="submit" class="btn btn--primary btn--sm">
        Save
      </button>
      <button
        type="button"
        class="btn btn--sm"
        hx-get={`/admin/videos/${video.id}/partials/visibility`}
        hx-target="#field-visibility"
        hx-swap="outerHTML"
      >
        Cancel
      </button>
    </form>
  );
}

// --- Tags ---

export function VideoTagsControl({
  video,
  videoTags,
  allTags,
}: {
  video: Video;
  videoTags: Tag[];
  allTags: Tag[];
}) {
  const assignedIds = new Set(videoTags.map((t) => t.id));
  const available = allTags.filter((t) => !assignedIds.has(t.id));

  return (
    <div id="field-tags" class="tag-picker">
      {videoTags.map((t) => (
        <span class="tag-chip" style={`background-color: var(--tag-${t.color}); color: #fff`}>
          {t.name}
          <button
            type="button"
            class="tag-chip-remove"
            hx-delete={`/admin/videos/${video.id}/tags/${t.id}`}
            hx-target="#field-tags"
            hx-swap="outerHTML"
            aria-label={`Remove ${t.name}`}
          >
            &times;
          </button>
        </span>
      ))}
      {available.length > 0 && (
        <select
          class="tag-picker-add"
          hx-post={`/admin/videos/${video.id}/tags`}
          hx-target="#field-tags"
          hx-swap="outerHTML"
          hx-trigger="change"
          name="tagId"
        >
          <option value="">Add tag...</option>
          {available.map((t) => (
            <option value={String(t.id)}>{t.name}</option>
          ))}
        </select>
      )}
    </div>
  );
}
