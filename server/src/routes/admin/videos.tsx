import type { Context } from "hono";
import { Hono } from "hono";
import { listEvents } from "../../lib/events";
import { listVideoFiles } from "../../lib/files";
import {
  ConflictError,
  duplicateVideo,
  trashVideo,
  untrashVideo,
  updateSlug,
  updateVideo,
  ValidationError,
} from "../../lib/store";
import { addTagToVideo, getVideoTags, listTags, removeTagFromVideo } from "../../lib/tags";
import { VideoDetailPage, VideoTabsSection } from "../../views/admin/pages/VideoDetailPage";
import {
  DescriptionDisplay,
  DescriptionEdit,
  SlugDisplay,
  SlugEdit,
  TitleDisplay,
  TitleEdit,
  VideoTagsControl,
  VisibilityDisplay,
  VisibilityEdit,
} from "../../views/admin/partials/VideoFields";
import { type AdminEnv, requireVideo } from "./helpers";

const videoRoutes = new Hono<AdminEnv>();

// --- Video detail ---

videoRoutes.get("/:id", async (c) => {
  const result = await requireVideo(c);
  if (result instanceof Response) return result;
  const video = result;

  const activeTab = c.req.query("tab") === "files" ? "files" : "events";
  const [videoTags, allTags, events, files] = await Promise.all([
    getVideoTags(video.id),
    listTags(),
    listEvents(video.id),
    listVideoFiles(video.id),
  ]);

  return c.html(
    <VideoDetailPage
      video={video}
      videoTags={videoTags}
      allTags={allTags}
      events={events}
      files={files}
      activeTab={activeTab}
    />,
  );
});

// --- Video field editing ---

videoRoutes.get("/:id/partials/title", async (c) => {
  const result = await requireVideo(c);
  if (result instanceof Response) return result;
  return c.html(<TitleDisplay video={result} />);
});

videoRoutes.get("/:id/partials/title/edit", async (c) => {
  const result = await requireVideo(c);
  if (result instanceof Response) return result;
  return c.html(<TitleEdit video={result} />);
});

videoRoutes.patch("/:id/title", async (c) => {
  const body = await c.req.parseBody();
  const title = String(body.title ?? "").trim() || null;
  const video = await updateVideo(c.req.param("id"), { title });
  c.header("HX-Trigger", "video-updated");
  return c.html(<TitleDisplay video={video} />);
});

videoRoutes.get("/:id/partials/slug", async (c) => {
  const result = await requireVideo(c);
  if (result instanceof Response) return result;
  return c.html(<SlugDisplay video={result} />);
});

videoRoutes.get("/:id/partials/slug/edit", async (c) => {
  const result = await requireVideo(c);
  if (result instanceof Response) return result;
  return c.html(<SlugEdit video={result} />);
});

videoRoutes.patch("/:id/slug", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.parseBody();
  const newSlug = String(body.slug ?? "").trim();
  try {
    const video = await updateSlug(id, newSlug);
    c.header("HX-Trigger", "video-updated");
    return c.html(<SlugDisplay video={video} />);
  } catch (err) {
    const result = await requireVideo(c);
    if (result instanceof Response) return result;
    const message =
      err instanceof ValidationError || err instanceof ConflictError ? err.message : "Invalid slug";
    return c.html(<SlugEdit video={result} error={message} />);
  }
});

videoRoutes.get("/:id/partials/description", async (c) => {
  const result = await requireVideo(c);
  if (result instanceof Response) return result;
  return c.html(<DescriptionDisplay video={result} />);
});

videoRoutes.get("/:id/partials/description/edit", async (c) => {
  const result = await requireVideo(c);
  if (result instanceof Response) return result;
  return c.html(<DescriptionEdit video={result} />);
});

videoRoutes.patch("/:id/description", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.parseBody();
  const description = String(body.description ?? "").trim() || null;
  const video = await updateVideo(id, { description });
  c.header("HX-Trigger", "video-updated");
  return c.html(<DescriptionDisplay video={video} />);
});

videoRoutes.get("/:id/partials/visibility", async (c) => {
  const result = await requireVideo(c);
  if (result instanceof Response) return result;
  return c.html(<VisibilityDisplay video={result} />);
});

videoRoutes.get("/:id/partials/visibility/edit", async (c) => {
  const result = await requireVideo(c);
  if (result instanceof Response) return result;
  return c.html(<VisibilityEdit video={result} />);
});

videoRoutes.patch("/:id/visibility", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.parseBody();
  const visibility = String(body.visibility ?? "") as "public" | "unlisted" | "private";
  if (!["public", "unlisted", "private"].includes(visibility))
    return c.text("Invalid visibility", 400);
  const video = await updateVideo(id, { visibility });
  c.header("HX-Trigger", "video-updated");
  return c.html(<VisibilityDisplay video={video} />);
});

// --- Tabs partial ---

videoRoutes.get("/:id/partials/tabs", async (c) => {
  const result = await requireVideo(c);
  if (result instanceof Response) return result;
  const activeTab = c.req.query("tab") === "files" ? "files" : "events";
  const [events, files] = await Promise.all([listEvents(result.id), listVideoFiles(result.id)]);
  return c.html(
    <VideoTabsSection video={result} events={events} files={files} activeTab={activeTab} />,
  );
});

// --- File preview ---

const LANG_MAP: Record<string, string> = {
  ".json": "json",
  ".m3u8": "plaintext",
  ".xml": "xml",
  ".html": "html",
  ".css": "css",
  ".js": "javascript",
  ".ts": "typescript",
  ".md": "markdown",
};

videoRoutes.get("/:id/partials/file-preview", async (c) => {
  const id = c.req.param("id");
  const filePath = c.req.query("path") ?? "";
  if (!filePath || filePath.includes("..") || filePath.startsWith("/")) {
    return c.text("Invalid path", 400);
  }
  const fullPath = `data/${id}/${filePath}`;
  const file = Bun.file(fullPath);
  if (!(await file.exists())) return c.text("File not found", 404);
  const content = await file.text();
  const ext = filePath.substring(filePath.lastIndexOf("."));
  const lang = LANG_MAP[ext] ?? "plaintext";
  return c.html(
    <>
      <div class="file-preview-header">
        <span class="file-preview-filename">{filePath}</span>
        <button type="button" class="btn btn--sm" onclick="this.closest('dialog').close()">
          Close
        </button>
      </div>
      <div class="file-preview-body">
        <pre>
          <code class={`language-${lang}`}>{content}</code>
        </pre>
      </div>
    </>,
  );
});

// --- Video tag assignment ---

async function renderTagsControl(c: Context<AdminEnv>): Promise<Response> {
  const result = await requireVideo(c);
  if (result instanceof Response) return result;
  const [videoTags, allTags] = await Promise.all([getVideoTags(result.id), listTags()]);
  c.header("HX-Trigger", "video-updated");
  return c.html(<VideoTagsControl video={result} videoTags={videoTags} allTags={allTags} />);
}

videoRoutes.post("/:id/tags", async (c) => {
  const body = await c.req.parseBody();
  const tagId = Number(body.tagId);
  if (Number.isFinite(tagId)) {
    await addTagToVideo(c.req.param("id"), tagId);
  }
  return renderTagsControl(c);
});

videoRoutes.delete("/:id/tags/:tagId", async (c) => {
  await removeTagFromVideo(c.req.param("id"), Number(c.req.param("tagId")));
  return renderTagsControl(c);
});

// --- Video actions ---

videoRoutes.post("/:id/trash", async (c) => {
  await trashVideo(c.req.param("id"));
  return c.redirect("/admin");
});

videoRoutes.post("/:id/untrash", async (c) => {
  const id = c.req.param("id");
  await untrashVideo(id);
  return c.redirect(`/admin/videos/${id}`);
});

videoRoutes.post("/:id/duplicate", async (c) => {
  const duplicate = await duplicateVideo(c.req.param("id"));
  return c.redirect(`/admin/videos/${duplicate.id}`);
});

export default videoRoutes;
