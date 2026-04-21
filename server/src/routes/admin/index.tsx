import { eq } from "drizzle-orm";
import { writeFile } from "fs/promises";
import type { Context } from "hono";
import { Hono } from "hono";
import { csrf } from "hono/csrf";
import { join } from "path";
import { getDb } from "../../db/client";
import { videos } from "../../db/schema";
import {
  clearSession,
  createSession,
  getAdminConfig,
  requireAdmin,
  verifyCredentials,
} from "../../lib/admin-auth";
import { createAdminToken, listAdminTokens, revokeAdminToken } from "../../lib/admin-tokens";
import { createApiKey, listApiKeys, revokeApiKey } from "../../lib/api-keys";
import { probeDuration, scheduleUploadDerivatives } from "../../lib/derivatives";
import { listEvents } from "../../lib/events";
import { serveFileWithRange } from "../../lib/file-serve";
import { listVideoFiles } from "../../lib/files";
import {
  ConflictError,
  createUploadedVideo,
  DATA_DIR,
  type DashboardFilters,
  type DashboardSort,
  duplicateVideo,
  getVideo,
  listVideosFiltered,
  trashVideo,
  untrashVideo,
  updateSlug,
  updateVideo,
  ValidationError,
  type Video,
} from "../../lib/store";
import {
  addTagToVideo,
  createTag,
  deleteTag,
  getTag,
  getVideoTags,
  listTags,
  removeTagFromVideo,
  updateTag,
} from "../../lib/tags";
import { DashboardPage } from "../../views/admin/pages/DashboardPage";
import { LoginPage } from "../../views/admin/pages/LoginPage";
import { GeneralPane, SettingsPage } from "../../views/admin/pages/SettingsPage";
import { TrashBinPage } from "../../views/admin/pages/TrashBinPage";
import { UploadPage } from "../../views/admin/pages/UploadPage";
import { VideoDetailPage } from "../../views/admin/pages/VideoDetailPage";
import { ApiKeysPane } from "../../views/admin/partials/ApiKeysPane";
import { TagEditRow, TagRow, TagsPane } from "../../views/admin/partials/TagsPane";
import {
  DescriptionDisplay,
  DescriptionEdit,
  SlugDisplay,
  SlugEdit,
  TitleDisplay,
  TitleEdit,
  VideoTagsControl,
  VisibilityControl,
} from "../../views/admin/partials/VideoFields";
import { VideoList, VideoListAppend } from "../../views/admin/partials/VideoList";

type AdminEnv = { Variables: { adminAuthMethod: string } };
const admin = new Hono<AdminEnv>();

// --- Public routes (no auth) ---

admin.get("/login", (c) => c.html(<LoginPage />));

admin.post("/login", async (c) => {
  const config = getAdminConfig();
  if (!config) return c.redirect("/admin");

  const body = await c.req.parseBody();
  const username = String(body.username ?? "");
  const password = String(body.password ?? "");

  if (!verifyCredentials(config, username, password)) {
    return c.html(<LoginPage error="Invalid username or password" />, 401);
  }

  await createSession(c, config);
  return c.redirect("/admin");
});

// --- Auth + CSRF on everything below ---

admin.use("*", requireAdmin());

// CSRF protection for cookie-based auth only. Bearer token requests are
// inherently CSRF-safe (the token is explicitly attached, not auto-sent
// by the browser), so we skip the Origin check for them. We check the
// actual auth method (set by requireAdmin) rather than the presence of
// the Authorization header — a request with both a valid session cookie
// and a bogus Authorization header would otherwise bypass CSRF.
const csrfCheck = csrf();
admin.use("*", (c, next) => {
  if (c.get("adminAuthMethod") === "bearer") return next();
  return csrfCheck(c, next);
});

// --- Authenticated routes ---

admin.post("/logout", (c) => {
  clearSession(c);
  return c.redirect("/admin/login");
});

// --- Dashboard ---

admin.get("/", async (c) => {
  const filters = parseFilters(c);
  const view = c.req.query("view") || "grid";
  const [result, tags] = await Promise.all([listVideosFiltered(filters), listTags()]);
  return c.html(
    <DashboardPage
      videos={result.items}
      nextCursor={result.nextCursor}
      filters={filters}
      tags={tags}
      view={view}
    />,
  );
});

// HTMX partial — returns just the video list (or appended batch for pagination).
admin.get("/partials/video-list", async (c) => {
  const filters = parseFilters(c);
  const view = c.req.query("view") || "grid";
  const result = await listVideosFiltered(filters);

  // If there's a cursor, we're loading more — return just the new cards + button.
  if (filters.cursor) {
    return c.html(
      <VideoListAppend
        videos={result.items}
        nextCursor={result.nextCursor}
        filters={filters}
        view={view}
      />,
    );
  }

  return c.html(
    <VideoList
      videos={result.items}
      nextCursor={result.nextCursor}
      filters={filters}
      view={view}
    />,
  );
});

// --- Video detail ---

admin.get("/videos/:id", async (c) => {
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

admin.get("/videos/:id/partials/title", async (c) => {
  const result = await requireVideo(c);
  if (result instanceof Response) return result;
  return c.html(<TitleDisplay video={result} />);
});

admin.get("/videos/:id/partials/title/edit", async (c) => {
  const result = await requireVideo(c);
  if (result instanceof Response) return result;
  return c.html(<TitleEdit video={result} />);
});

admin.patch("/videos/:id/title", async (c) => {
  const body = await c.req.parseBody();
  const title = String(body.title ?? "").trim() || null;
  const video = await updateVideo(c.req.param("id"), { title });
  return c.html(<TitleDisplay video={video} />);
});

admin.get("/videos/:id/partials/slug", async (c) => {
  const result = await requireVideo(c);
  if (result instanceof Response) return result;
  return c.html(<SlugDisplay video={result} />);
});

admin.get("/videos/:id/partials/slug/edit", async (c) => {
  const result = await requireVideo(c);
  if (result instanceof Response) return result;
  return c.html(<SlugEdit video={result} />);
});

admin.patch("/videos/:id/slug", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.parseBody();
  const newSlug = String(body.slug ?? "").trim();
  try {
    const video = await updateSlug(id, newSlug);
    return c.html(<SlugDisplay video={video} />);
  } catch (err) {
    const result = await requireVideo(c);
    if (result instanceof Response) return result;
    const message =
      err instanceof ValidationError || err instanceof ConflictError ? err.message : "Invalid slug";
    return c.html(<SlugEdit video={result} error={message} />);
  }
});

admin.get("/videos/:id/partials/description", async (c) => {
  const result = await requireVideo(c);
  if (result instanceof Response) return result;
  return c.html(<DescriptionDisplay video={result} />);
});

admin.get("/videos/:id/partials/description/edit", async (c) => {
  const result = await requireVideo(c);
  if (result instanceof Response) return result;
  return c.html(<DescriptionEdit video={result} />);
});

admin.patch("/videos/:id/description", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.parseBody();
  const description = String(body.description ?? "").trim() || null;
  const video = await updateVideo(id, { description });
  return c.html(<DescriptionDisplay video={video} />);
});

admin.patch("/videos/:id/visibility", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.parseBody();
  const visibility = String(body.visibility ?? "") as "public" | "unlisted" | "private";
  if (!["public", "unlisted", "private"].includes(visibility))
    return c.text("Invalid visibility", 400);
  const video = await updateVideo(id, { visibility });
  return c.html(<VisibilityControl video={video} />);
});

// --- Video tag assignment ---

// Shared helper for returning the updated tags control after add/remove.
async function renderTagsControl(c: Context<AdminEnv>): Promise<Response> {
  const result = await requireVideo(c);
  if (result instanceof Response) return result;
  const [videoTags, allTags] = await Promise.all([getVideoTags(result.id), listTags()]);
  return c.html(<VideoTagsControl video={result} videoTags={videoTags} allTags={allTags} />);
}

admin.post("/videos/:id/tags", async (c) => {
  const body = await c.req.parseBody();
  const tagId = Number(body.tagId);
  if (Number.isFinite(tagId)) {
    await addTagToVideo(c.req.param("id"), tagId);
  }
  return renderTagsControl(c);
});

admin.delete("/videos/:id/tags/:tagId", async (c) => {
  await removeTagFromVideo(c.req.param("id"), Number(c.req.param("tagId")));
  return renderTagsControl(c);
});

// --- Admin media routes (session-gated, serves by video ID) ---

const RAW_FILENAME = /^(source|\d+p)\.mp4$/;
const STREAM_FILENAME = /^(stream\.m3u8|init\.mp4|seg_\d+\.m4s)$/;

admin.get("/videos/:id/media/raw/:file", async (c) => {
  const file = c.req.param("file");
  if (!RAW_FILENAME.test(file)) return c.text("Not found", 404);
  const result = await requireVideo(c);
  if (result instanceof Response) return result;
  return serveFileWithRange(
    c,
    join(DATA_DIR, result.id, "derivatives", file),
    "video/mp4",
    "immutable",
  );
});

admin.get("/videos/:id/media/stream/:file", async (c) => {
  const file = c.req.param("file");
  if (!STREAM_FILENAME.test(file)) return c.text("Not found", 404);
  const result = await requireVideo(c);
  if (result instanceof Response) return result;
  const contentType = file.endsWith(".m3u8")
    ? "application/vnd.apple.mpegurl"
    : file.endsWith(".m4s")
      ? "video/iso.segment"
      : "video/mp4";
  const cache = file.endsWith(".m3u8") ? ("short" as const) : ("immutable" as const);
  return serveFileWithRange(c, join(DATA_DIR, result.id, file), contentType, cache);
});

admin.get("/videos/:id/media/poster.jpg", async (c) => {
  const result = await requireVideo(c);
  if (result instanceof Response) return result;
  return serveFileWithRange(
    c,
    join(DATA_DIR, result.id, "derivatives", "thumbnail.jpg"),
    "image/jpeg",
    "immutable",
  );
});

// --- Other pages ---

admin.get("/trash", async (c) => {
  const result = await listVideosFiltered({ trashedOnly: true });
  const view = c.req.query("view") || "grid";
  return c.html(<TrashBinPage videos={result.items} view={view} />);
});

// --- Video actions ---

admin.post("/videos/:id/trash", async (c) => {
  await trashVideo(c.req.param("id"));
  return c.redirect("/admin");
});

admin.post("/videos/:id/untrash", async (c) => {
  const id = c.req.param("id");
  await untrashVideo(id);
  return c.redirect(`/admin/videos/${id}`);
});

admin.post("/videos/:id/duplicate", async (c) => {
  const duplicate = await duplicateVideo(c.req.param("id"));
  return c.redirect(`/admin/videos/${duplicate.id}`);
});

// --- Upload ---

admin.get("/upload", async (c) => {
  const tags = await listTags();
  return c.html(<UploadPage tags={tags} />);
});

admin.post("/upload", async (c) => {
  const body = await c.req.parseBody();
  const file = body.file;
  if (!(file instanceof File) || file.size === 0) {
    const tags = await listTags();
    return c.html(<UploadPage tags={tags} error="Please select an MP4 file." />, 400);
  }

  // Parse form fields.
  const slug = body.slug ? String(body.slug).trim() : undefined;
  const title = body.title ? String(body.title).trim() || null : null;
  const description = body.description ? String(body.description).trim() || null : null;
  const visibility = String(body.visibility || "unlisted");
  const tagValues = Array.isArray(body.tags) ? body.tags : body.tags ? [body.tags] : [];
  const tagIds = tagValues.map(Number).filter(Number.isFinite);

  try {
    // Create the video record (validates slug + visibility, creates directory).
    const video = await createUploadedVideo({ slug, title, description, visibility });

    // Save the uploaded file into the video's data directory.
    const uploadPath = join(DATA_DIR, video.id, "upload.mp4");
    await writeFile(uploadPath, Buffer.from(await file.arrayBuffer()));

    // Probe duration and update the record.
    const duration = await probeDuration(uploadPath);
    if (duration != null) {
      await getDb()
        .update(videos)
        .set({ durationSeconds: duration })
        .where(eq(videos.id, video.id));
    }

    // Apply tags.
    for (const tagId of tagIds) {
      await addTagToVideo(video.id, tagId);
    }

    // Fire-and-forget: generate derivatives (source.mp4 with faststart + thumbnail)
    scheduleUploadDerivatives(video.id);

    return c.redirect(`/admin/videos/${video.id}`);
  } catch (err) {
    const message =
      err instanceof ValidationError || err instanceof ConflictError
        ? err.message
        : "Upload failed";
    const tags = await listTags();
    return c.html(<UploadPage tags={tags} error={message} />, 400);
  }
});

// --- Settings ---

admin.get("/settings", (c) =>
  c.html(
    <SettingsPage activeTab="general">
      <GeneralPane />
    </SettingsPage>,
  ),
);

admin.get("/settings/tags", async (c) => {
  const tags = await listTags();
  return c.html(
    <SettingsPage activeTab="tags">
      <TagsPane tags={tags} />
    </SettingsPage>,
  );
});

admin.post("/settings/tags", async (c) => {
  const body = await c.req.parseBody();
  const name = String(body.name ?? "").trim();
  const color = String(body.color ?? "gray");
  if (name) {
    await createTag(name, color as Parameters<typeof createTag>[1]);
  }
  const tags = await listTags();
  return c.html(<TagsPane tags={tags} />);
});

admin.get("/settings/tags/:id/edit", async (c) => {
  const tag = await getTag(Number(c.req.param("id")));
  if (!tag) return c.text("Tag not found", 404);
  return c.html(<TagEditRow tag={tag} />);
});

admin.get("/settings/tags/:id/display", async (c) => {
  const tag = await getTag(Number(c.req.param("id")));
  if (!tag) return c.text("Tag not found", 404);
  return c.html(<TagRow tag={tag} />);
});

admin.patch("/settings/tags/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.parseBody();
  const name = body.name ? String(body.name).trim() : undefined;
  const color = body.color ? String(body.color) : undefined;
  await updateTag(id, { name, color: color as Parameters<typeof updateTag>[1]["color"] });
  const tag = await getTag(id);
  if (!tag) return c.text("Tag not found", 404);
  return c.html(<TagRow tag={tag} />);
});

admin.delete("/settings/tags/:id", async (c) => {
  await deleteTag(Number(c.req.param("id")));
  const tags = await listTags();
  return c.html(<TagsPane tags={tags} />);
});

// --- API Keys ---

// Helper to render the full keys pane with both key types.
async function renderKeysPane(opts?: { newRecordingToken?: string; newAdminToken?: string }) {
  const [recordingKeys, adminTokens] = await Promise.all([listApiKeys(), listAdminTokens()]);
  return (
    <ApiKeysPane
      recordingKeys={recordingKeys}
      adminTokens={adminTokens}
      newRecordingToken={opts?.newRecordingToken}
      newAdminToken={opts?.newAdminToken}
    />
  );
}

admin.get("/settings/keys", async (c) =>
  c.html(<SettingsPage activeTab="keys">{await renderKeysPane()}</SettingsPage>),
);

// Recording API keys (lck_)
admin.post("/settings/keys/recording", async (c) => {
  const name = String((await c.req.parseBody()).name ?? "").trim();
  let newRecordingToken: string | undefined;
  if (name) newRecordingToken = (await createApiKey(name)).plaintext;
  return c.html(await renderKeysPane({ newRecordingToken }));
});

admin.post("/settings/keys/recording/:id/revoke", async (c) => {
  await revokeApiKey(c.req.param("id"));
  return c.html(await renderKeysPane());
});

// Admin API tokens (lca_)
admin.post("/settings/keys/admin", async (c) => {
  const name = String((await c.req.parseBody()).name ?? "").trim();
  let newAdminToken: string | undefined;
  if (name) newAdminToken = (await createAdminToken(name)).plaintext;
  return c.html(await renderKeysPane({ newAdminToken }));
});

admin.post("/settings/keys/admin/:id/revoke", async (c) => {
  await revokeAdminToken(c.req.param("id"));
  return c.html(await renderKeysPane());
});

export default admin;

// --- Helpers ---

// Loads a video by :id param, including trashed videos (admin can see
// everything). Returns the video or a 404 text response.
async function requireVideo(c: Context<AdminEnv>): Promise<Video | Response> {
  const id = c.req.param("id") as string;
  const video = await getVideo(id, { includeTrashed: true });
  if (!video) return c.text("Video not found", 404);
  return video;
}

const VALID_SORTS = new Set<DashboardSort>([
  "date-desc",
  "date-asc",
  "duration-desc",
  "duration-asc",
  "title-asc",
  "title-desc",
]);

const VALID_VISIBILITY = new Set(["public", "unlisted", "private"]);
const VALID_STATUS = new Set(["recording", "healing", "complete", "failed"]);

function parseFilters(c: Context<AdminEnv>): DashboardFilters {
  const filters: DashboardFilters = {};
  const q = (key: string) => c.req.query(key);

  const search = q("q")?.trim();
  if (search) filters.search = search;

  const visibility = q("visibility");
  if (visibility && VALID_VISIBILITY.has(visibility))
    filters.visibility = visibility as DashboardFilters["visibility"];

  const status = q("status");
  if (status && VALID_STATUS.has(status)) filters.status = status as DashboardFilters["status"];

  const tagId = q("tag");
  if (tagId) {
    const n = Number(tagId);
    if (Number.isFinite(n)) filters.tagId = n;
  }

  const dateFrom = q("from");
  if (dateFrom) filters.dateFrom = dateFrom;
  const dateTo = q("to");
  if (dateTo) filters.dateTo = dateTo;

  const dmin = q("dmin");
  if (dmin) {
    const n = Number(dmin);
    if (Number.isFinite(n)) filters.durationMin = n;
  }
  const dmax = q("dmax");
  if (dmax) {
    const n = Number(dmax);
    if (Number.isFinite(n)) filters.durationMax = n;
  }

  const sort = q("sort");
  if (sort && VALID_SORTS.has(sort as DashboardSort)) filters.sort = sort as DashboardSort;

  const cursor = q("cursor");
  if (cursor) filters.cursor = cursor;

  return filters;
}
