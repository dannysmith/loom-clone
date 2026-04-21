import { TAG_COLORS, type Tag, type TagColor } from "../../../db/schema";

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
  return (
    <div class="tag-row" id={`tag-${tag.id}`}>
      <span class="tag-swatch" style={`background-color: var(--tag-${tag.color})`} />
      <span class="tag-name">{tag.name}</span>
      <span class="tag-color-label">{tag.color}</span>
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

export function TagEditRow({ tag }: { tag: Tag }) {
  return (
    <form
      class="tag-row tag-row--editing"
      id={`tag-${tag.id}`}
      hx-patch={`/admin/settings/tags/${tag.id}`}
      hx-target={`#tag-${tag.id}`}
      hx-swap="outerHTML"
    >
      <input class="input tag-edit-name" type="text" name="name" value={tag.name} required />
      <ColorPicker current={tag.color as TagColor} />
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
