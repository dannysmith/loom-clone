import type { Tag } from "../../../db/schema";
import { AdminLayout } from "../../layouts/AdminLayout";

export function UploadPage({ tags }: { tags: Tag[] }) {
  return (
    <AdminLayout title="Upload Video" activePage="dashboard">
      <div class="page-header">
        <h1>Upload Video</h1>
      </div>

      <form
        class="upload-form"
        method="post"
        action="/admin/upload"
        enctype="multipart/form-data"
        hx-post="/admin/upload"
        hx-encoding="multipart/form-data"
        hx-indicator="#upload-progress"
        {...{ "hx-on:htmx:xhr:progress": "updateProgress(event)" }}
      >
        <div class="form-field">
          <label class="label" for="file">
            Video file (MP4)
          </label>
          <input class="input" id="file" name="file" type="file" accept="video/mp4,.mp4" required />
        </div>

        <div class="form-field">
          <label class="label" for="upload-title">
            Title (optional)
          </label>
          <input class="input" id="upload-title" name="title" type="text" />
        </div>

        <div class="form-field">
          <label class="label" for="upload-slug">
            Slug (optional — random if blank)
          </label>
          <input class="input" id="upload-slug" name="slug" type="text" />
        </div>

        <div class="form-field">
          <label class="label" for="upload-description">
            Description (optional)
          </label>
          <textarea class="input" id="upload-description" name="description" rows={3} />
        </div>

        <div class="form-field">
          <label class="label" for="upload-visibility">
            Visibility
          </label>
          <select class="input" id="upload-visibility" name="visibility" style="inline-size: auto">
            <option value="unlisted" selected>
              unlisted
            </option>
            <option value="public">public</option>
            <option value="private">private</option>
          </select>
        </div>

        {tags.length > 0 && (
          <div class="form-field">
            <span class="label">Tags (optional)</span>
            <div class="upload-tags">
              {tags.map((t) => (
                <label class="upload-tag-option">
                  <input type="checkbox" name="tags" value={String(t.id)} />
                  <span
                    class="badge"
                    style={`background-color: var(--tag-${t.color}); color: #fff`}
                  >
                    {t.name}
                  </span>
                </label>
              ))}
            </div>
          </div>
        )}

        <div id="upload-progress" class="upload-progress htmx-indicator">
          <progress class="upload-progress-bar" value="0" max="100" />
          <span class="upload-progress-text">Uploading...</span>
        </div>

        <button type="submit" class="btn btn--primary">
          Upload
        </button>
      </form>
    </AdminLayout>
  );
}
