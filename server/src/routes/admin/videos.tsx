import type { Context } from "hono";
import { Hono } from "hono";
import { purgeVideo } from "../../lib/cdn";
import { listEvents, logEvent } from "../../lib/events";
import { listVideoFiles } from "../../lib/files";
import { slugFromTitle } from "../../lib/slug-utils";
import {
  ConflictError,
  checkSlugAvailable,
  duplicateVideo,
  getTranscript,
  trashVideo,
  untrashVideo,
  updateSlug,
  updateVideo,
  ValidationError,
  validateSlugFormat,
} from "../../lib/store";
import { addTagToVideo, getVideoTags, listTags, removeTagFromVideo } from "../../lib/tags";
import {
  listThumbnailCandidates,
  promoteCandidate,
  saveCustomThumbnail,
} from "../../lib/thumbnails";
import { VideoDetailPage, VideoTabsSection } from "../../views/admin/pages/VideoDetailPage";
import { ThumbnailPicker } from "../../views/admin/partials/ThumbnailPicker";
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

function parseTab(q: string | undefined): "events" | "files" | "transcript" {
  if (q === "files") return "files";
  if (q === "transcript") return "transcript";
  return "events";
}

videoRoutes.get("/:id", async (c) => {
  const result = await requireVideo(c);
  if (result instanceof Response) return result;
  const video = result;

  const activeTab = parseTab(c.req.query("tab"));
  const [videoTags, allTags, events, files, thumbnailCandidates, transcript] = await Promise.all([
    getVideoTags(video.id),
    listTags(),
    listEvents(video.id),
    listVideoFiles(video.id),
    listThumbnailCandidates(video.id),
    getTranscript(video.id),
  ]);

  return c.html(
    <VideoDetailPage
      video={video}
      videoTags={videoTags}
      allTags={allTags}
      events={events}
      files={files}
      thumbnailCandidates={thumbnailCandidates}
      transcript={transcript}
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

videoRoutes.get("/:id/partials/slug/check", async (c) => {
  const result = await requireVideo(c);
  if (result instanceof Response) return result;
  const slug = String(c.req.query("slug") ?? "").trim();
  if (!slug || slug === result.slug) return c.body(null);
  try {
    validateSlugFormat(slug);
    checkSlugAvailable(slug, result.id);
    return c.body(null);
  } catch (err) {
    const message =
      err instanceof ValidationError || err instanceof ConflictError ? err.message : "Invalid slug";
    return c.html(<span class="editable-error">{message}</span>);
  }
});

videoRoutes.get("/:id/partials/slug/from-title", async (c) => {
  const result = await requireVideo(c);
  if (result instanceof Response) return result;
  if (!result.title) return c.text("", 400);
  return c.text(slugFromTitle(result.title));
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
  const activeTab = parseTab(c.req.query("tab"));
  const [events, files, transcript] = await Promise.all([
    listEvents(result.id),
    listVideoFiles(result.id),
    getTranscript(result.id),
  ]);
  return c.html(
    <VideoTabsSection
      video={result}
      events={events}
      files={files}
      transcript={transcript}
      activeTab={activeTab}
    />,
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

// --- Thumbnail picker ---

videoRoutes.get("/:id/partials/thumbnails", async (c) => {
  const result = await requireVideo(c);
  if (result instanceof Response) return result;
  const candidates = await listThumbnailCandidates(result.id);
  return c.html(<ThumbnailPicker video={result} candidates={candidates} />);
});

videoRoutes.post("/:id/thumbnail/promote", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.parseBody();
  const candidateId = String(body.candidateId ?? "");
  if (!candidateId) return c.text("Missing candidateId", 400);

  const ok = await promoteCandidate(id, candidateId);
  if (!ok) return c.text("Candidate not found", 404);

  await logEvent(id, "thumbnail_promoted", { candidateId });
  const result = await requireVideo(c);
  if (result instanceof Response) return result;
  purgeVideo(result.slug);

  c.header("HX-Trigger", "video-updated");
  const candidates = await listThumbnailCandidates(id);
  return c.html(<ThumbnailPicker video={result} candidates={candidates} />);
});

const MAX_UPLOAD_SIZE = 5 * 1024 * 1024; // 5 MB
const MAX_UPLOAD_WIDTH = 3840;

videoRoutes.post("/:id/thumbnail/upload", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.parseBody();
  const file = body.thumbnail;
  if (!(file instanceof File)) return c.text("No file uploaded", 400);
  if (file.size > MAX_UPLOAD_SIZE) return c.text("File too large (max 5 MB)", 400);
  if (!file.type.startsWith("image/jpeg") && !file.type.startsWith("image/png")) {
    return c.text("Only JPEG and PNG uploads accepted", 400);
  }

  const imageData = await file.arrayBuffer();

  // Basic dimension check via ffprobe before saving.
  const ffprobePath = Bun.which("ffprobe");
  if (ffprobePath) {
    const tmpPath = `data/${id}/derivatives/thumbnail-candidates/_upload-check.tmp`;
    await Bun.write(tmpPath, imageData);
    try {
      const proc = Bun.spawn(
        [
          ffprobePath,
          "-v",
          "quiet",
          "-print_format",
          "json",
          "-show_streams",
          "-select_streams",
          "v:0",
          tmpPath,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      if (exitCode === 0) {
        const data = JSON.parse(stdout) as { streams?: Array<{ width?: number }> };
        const width = data.streams?.[0]?.width ?? 0;
        if (width > MAX_UPLOAD_WIDTH) {
          return c.text(`Image too wide (${width}px, max ${MAX_UPLOAD_WIDTH}px)`, 400);
        }
      }
    } finally {
      const { rm } = await import("fs/promises");
      await rm(tmpPath, { force: true }).catch(() => {});
    }
  }

  const candidateId = await saveCustomThumbnail(id, imageData);
  await logEvent(id, "thumbnail_uploaded", { candidateId });

  // Auto-promote the newly uploaded custom thumbnail.
  await promoteCandidate(id, candidateId);
  await logEvent(id, "thumbnail_promoted", { candidateId });

  const result = await requireVideo(c);
  if (result instanceof Response) return result;
  purgeVideo(result.slug);

  c.header("HX-Trigger", "video-updated");
  const candidates = await listThumbnailCandidates(id);
  return c.html(<ThumbnailPicker video={result} candidates={candidates} />);
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
