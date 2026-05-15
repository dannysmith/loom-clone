import { TAG_COLORS, type Tag, type TagColor } from "../../../db/schema";
import { absoluteUrl } from "../../../lib/url";

export function TagsPane({ tags }: { tags: Tag[] }) {
  return (
    <div id="tags-pane">
      <div class="tags-create">
        <form
          hx-post="/admin/settings/tags"
          hx-target="#tags-pane"
          hx-swap="outerHTML"
          class="tags-create-form"
        >
          <input class="input" type="text" name="name" placeholder="New tag name" required />
          <select class="input" name="color">
            {TAG_COLORS.map((c) => (
              <option value={c}>{c}</option>
            ))}
          </select>
          <button type="submit" class="btn btn--primary">
            Add tag
          </button>
        </form>
      </div>

      {tags.length === 0 ? (
        <p class="empty-state">No tags yet.</p>
      ) : (
        <div class="tags-list">
          {tags.map((tag) => (
            <TagRow tag={tag} />
          ))}
        </div>
      )}
    </div>
  );
}

export function TagRow({ tag }: { tag: Tag }) {
  const publicUrl = tag.slug && tag.visibility !== "private" ? absoluteUrl(`/${tag.slug}`) : null;

  return (
    <div class="tag-row" id={`tag-${tag.id}`}>
      <span class="tag-swatch" style={`background-color: var(--tag-${tag.color})`} />
      <div class="tag-row-summary">
        <span class="tag-name">{tag.name}</span>
        <span class={`badge badge--${tag.visibility}`}>{tag.visibility}</span>
        {publicUrl && (
          <a
            href={publicUrl}
            class="tag-row-public-url"
            target="_blank"
            rel="noopener noreferrer"
            title="Open public tag page"
          >
            /{tag.slug}
          </a>
        )}
      </div>
      <button
        type="button"
        class="btn btn--sm"
        hx-get={`/admin/settings/tags/${tag.id}/edit`}
        hx-target={`#tag-${tag.id}`}
        hx-swap="outerHTML"
      >
        Edit
      </button>
      <button
        type="button"
        class="btn btn--sm btn--danger"
        hx-delete={`/admin/settings/tags/${tag.id}`}
        hx-target="#tags-pane"
        hx-swap="outerHTML"
        hx-confirm={`Delete tag "${tag.name}"? This will remove it from all videos.`}
      >
        Delete
      </button>
    </div>
  );
}

export function TagEditRow({ tag, error }: { tag: Tag; error?: string }) {
  return (
    <form
      class="tag-row tag-row--editing tag-row--form"
      id={`tag-${tag.id}`}
      hx-patch={`/admin/settings/tags/${tag.id}`}
      hx-target={`#tag-${tag.id}`}
      hx-swap="outerHTML"
    >
      {error && <div class="tag-edit-error">{error}</div>}

      <label class="tag-edit-field">
        <span class="tag-edit-label">Name</span>
        <input class="input" type="text" name="name" value={tag.name} required />
      </label>

      <div class="tag-edit-field">
        <span class="tag-edit-label">Colour</span>
        <ColorPicker current={tag.color as TagColor} />
      </div>

      <label class="tag-edit-field">
        <span class="tag-edit-label">Visibility</span>
        <select class="input" name="visibility">
          {(["private", "unlisted", "public"] as const).map((v) => (
            <option value={v} selected={v === tag.visibility}>
              {v}
            </option>
          ))}
        </select>
        <span class="tag-edit-help">
          Public/unlisted tags need a slug. Private tags have no public page.
        </span>
      </label>

      <label class="tag-edit-field">
        <span class="tag-edit-label">Slug</span>
        <input
          class="input"
          type="text"
          name="slug"
          value={tag.slug ?? ""}
          placeholder="my-tag"
          pattern="[a-z0-9](?:-?[a-z0-9])*"
        />
        <span class="tag-edit-help">
          Lowercase letters, digits, dashes. Renaming preserves a redirect from the old slug.
        </span>
      </label>

      <label class="tag-edit-field">
        <span class="tag-edit-label">Description</span>
        <textarea
          class="input"
          name="description"
          rows={3}
          placeholder="Optional. Markdown supported."
        >
          {tag.description ?? ""}
        </textarea>
      </label>

      <div class="tag-edit-actions">
        <button type="submit" class="btn btn--primary btn--sm">
          Save
        </button>
        <button
          type="button"
          class="btn btn--sm"
          hx-get={`/admin/settings/tags/${tag.id}/display`}
          hx-target={`#tag-${tag.id}`}
          hx-swap="outerHTML"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function ColorPicker({ current }: { current: TagColor }) {
  return (
    <div class="color-picker">
      {TAG_COLORS.map((c) => (
        <label class="color-picker-option">
          <input type="radio" name="color" value={c} checked={c === current} />
          <span class="color-picker-swatch" style={`background-color: var(--tag-${c})`} />
        </label>
      ))}
    </div>
  );
}
