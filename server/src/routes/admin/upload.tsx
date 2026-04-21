import { eq } from "drizzle-orm";
import { writeFile } from "fs/promises";
import { Hono } from "hono";
import { join } from "path";
import { getDb } from "../../db/client";
import { videos } from "../../db/schema";
import { probeDuration, scheduleUploadDerivatives } from "../../lib/derivatives";
import { ConflictError, createUploadedVideo, DATA_DIR, ValidationError } from "../../lib/store";
import { addTagToVideo, listTags } from "../../lib/tags";
import { UploadPage } from "../../views/admin/pages/UploadPage";
import type { AdminEnv } from "./helpers";

const upload = new Hono<AdminEnv>();

upload.get("/", async (c) => {
  const tags = await listTags();
  return c.html(<UploadPage tags={tags} />);
});

upload.post("/", async (c) => {
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

export default upload;
