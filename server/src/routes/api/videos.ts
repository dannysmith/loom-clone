import { zValidator } from "@hono/zod-validator";
import { readdir, rm } from "fs/promises";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { join, resolve } from "path";
import { z } from "zod";
import { DEFAULT_SEGMENT_DURATION } from "../../lib/constants";
import { scheduleDerivatives } from "../../lib/derivatives";
import { apiError, ErrorCode } from "../../lib/errors";
import { logEvent } from "../../lib/events";
import { buildPlaylist, writePlaylist } from "../../lib/playlist";
import { parseSrtToPlainText } from "../../lib/srt";
import {
  addSegment,
  ConflictError,
  createVideo,
  DATA_DIR,
  deleteVideo,
  getVideo,
  listVideosPaginated,
  setVideoStatus,
  updateSlug,
  updateVideo,
  upsertTranscript,
  ValidationError,
  type Video,
} from "../../lib/store";
import { absoluteUrl, urlsForVideo } from "../../lib/url";

// Timeline segment shape we care about — loose typing to stay tolerant of
// schema evolution. We only need the filename list for diffing.
interface TimelineSegmentLike {
  filename?: unknown;
}
interface TimelineLike {
  segments?: unknown;
}

export function expectedFilenamesFromTimeline(timeline: TimelineLike): string[] {
  const segs = Array.isArray(timeline.segments) ? timeline.segments : [];
  const names = new Set<string>();
  // init.mp4 is implicit — it's never in timeline.segments but is always
  // required for playback. Adding it here means a missing init.mp4 surfaces
  // in the `missing` list and gets healed along with the media segments.
  names.add("init.mp4");
  for (const s of segs as TimelineSegmentLike[]) {
    if (typeof s.filename === "string") names.add(s.filename);
  }
  return [...names];
}

// Conservative filename allowlist for segment uploads. init.mp4 is the HLS
// initialization segment; seg_NNN.m4s are the media segments emitted by the
// writer. Anything else is rejected so a malicious or buggy client can't
// traverse out of the video directory or overwrite metadata files.
const SEGMENT_FILENAME = /^(init\.mp4|seg_\d+\.m4s)$/;

async function onDiskFilenames(id: string): Promise<Set<string>> {
  try {
    const entries = await readdir(join(DATA_DIR, id));
    return new Set(entries);
  } catch {
    return new Set();
  }
}

// Shared JSON shape for a single video in API responses.
function videoToApiJson(video: Video) {
  const urls = urlsForVideo(video);
  return {
    id: video.id,
    slug: video.slug,
    status: video.status,
    visibility: video.visibility,
    title: video.title,
    description: video.description,
    durationSeconds: video.durationSeconds,
    width: video.width,
    height: video.height,
    source: video.source,
    createdAt: video.createdAt,
    updatedAt: video.updatedAt,
    completedAt: video.completedAt,
    url: absoluteUrl(urls.page),
    urls,
  };
}

const videos = new Hono();

// List all videos, newest first. Cursor-paginated.
videos.get("/", async (c) => {
  const limit = Number(c.req.query("limit")) || 20;
  const cursor = c.req.query("cursor");
  const includeTrashed = c.req.query("includeTrashed") === "1";
  const result = await listVideosPaginated({ limit, cursor, includeTrashed });
  return c.json({
    items: result.items.map(videoToApiJson),
    nextCursor: result.nextCursor,
  });
});

// Single video by id.
videos.get("/:id", async (c) => {
  const { id } = c.req.param();
  const video = await getVideo(id);
  if (!video) return apiError(c, 404, "Video not found", ErrorCode.VIDEO_NOT_FOUND);
  return c.json(videoToApiJson(video));
});

// Edit title, description, visibility, or slug. Returns the updated video.
const patchSchema = z.object({
  title: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  visibility: z.enum(["public", "unlisted", "private"]).optional(),
  slug: z.string().optional(),
});

videos.patch(
  "/:id",
  zValidator("json", patchSchema, (result, c) => {
    if (!result.success) {
      return apiError(c, 400, result.error.message, ErrorCode.VALIDATION_ERROR);
    }
  }),
  async (c) => {
    const { id } = c.req.param();
    const existing = await getVideo(id);
    if (!existing) return apiError(c, 404, "Video not found", ErrorCode.VIDEO_NOT_FOUND);
    const { slug, ...rest } = c.req.valid("json");

    // Apply title/description/visibility first.
    let updated: Video = existing;
    if (
      rest.title !== undefined ||
      rest.description !== undefined ||
      rest.visibility !== undefined
    ) {
      updated = await updateVideo(id, rest);
    }

    // Slug change is separate — it creates a redirect from the old slug.
    if (slug !== undefined) {
      try {
        updated = await updateSlug(id, slug);
      } catch (err) {
        if (err instanceof ValidationError) {
          return apiError(c, 400, err.message, ErrorCode.VALIDATION_ERROR);
        }
        if (err instanceof ConflictError) {
          return apiError(c, 409, err.message, ErrorCode.SLUG_CONFLICT);
        }
        throw err;
      }
    }

    return c.json(videoToApiJson(updated));
  },
);

// Create a new video record
videos.post("/", async (c) => {
  const video = await createVideo();
  console.log(`[video] created ${video.id} (slug: ${video.slug})`);
  return c.json({ id: video.id, slug: video.slug });
});

// Receive a segment. Idempotent — re-uploads overwrite cleanly and the
// playlist is rebuilt from the on-disk directory listing.
// 50 MB limit — well above normal segment size (~500KB-2MB), guards against
// buggy clients exhausting memory.
videos.put("/:id/segments/:filename", bodyLimit({ maxSize: 50 * 1024 * 1024 }), async (c) => {
  const { id, filename } = c.req.param();
  const video = await getVideo(id);
  if (!video) return apiError(c, 404, "Video not found", ErrorCode.VIDEO_NOT_FOUND);

  if (!SEGMENT_FILENAME.test(filename)) {
    return apiError(c, 400, "Invalid segment filename", ErrorCode.INVALID_SEGMENT_FILENAME);
  }

  // Belt-and-braces: even with the allowlist, resolve the destination and
  // confirm it stays inside the video's directory before writing.
  const videoDir = resolve(join(DATA_DIR, id));
  const path = resolve(join(videoDir, filename));
  if (!path.startsWith(`${videoDir}/`)) {
    return apiError(c, 400, "Invalid segment filename", ErrorCode.INVALID_SEGMENT_FILENAME);
  }

  const body = await c.req.arrayBuffer();
  await Bun.write(path, new Uint8Array(body));

  if (filename !== "init.mp4") {
    const header = c.req.header("x-segment-duration");
    // Fall back to the default for missing or unparseable headers. Without the
    // finiteness guard, parseFloat("abc") = NaN would end up in the segments
    // table and then in the HLS playlist's EXTINF line.
    const parsed = header !== undefined ? Number.parseFloat(header) : DEFAULT_SEGMENT_DURATION;
    const duration = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SEGMENT_DURATION;
    await addSegment(id, filename, duration);

    const playlist = await buildPlaylist(video);
    await writePlaylist(id, playlist);
  }

  const size = (body.byteLength / 1024).toFixed(1);
  console.log(`[segment] ${id}/${filename} (${size} KB)`);
  return c.json({ ok: true });
});

// Finalize recording. Idempotent — safe to call repeatedly as the client
// uploads missing segments in the background. Body SHOULD carry the
// `{ timeline: ... }` JSON; without it we can't diff, so `missing` comes
// back empty (best-effort complete).
videos.post("/:id/complete", async (c) => {
  const { id } = c.req.param();
  const existing = await getVideo(id);
  if (!existing) return apiError(c, 404, "Video not found", ErrorCode.VIDEO_NOT_FOUND);

  let timeline: TimelineLike | null = null;
  const contentType = c.req.header("content-type") ?? "";
  if (contentType.includes("application/json")) {
    let body: { timeline?: TimelineLike };
    try {
      body = (await c.req.json()) as { timeline?: TimelineLike };
    } catch {
      return apiError(c, 400, "Malformed JSON body", ErrorCode.VALIDATION_ERROR);
    }
    if (body.timeline && typeof body.timeline === "object") {
      timeline = body.timeline;
      const path = join(DATA_DIR, id, "recording.json");
      await Bun.write(path, JSON.stringify(timeline, null, 2));
    }
  }

  // Diff expected vs on-disk. Without a timeline we can't know what the
  // client emitted, so nothing is flagged missing.
  let missing: string[] = [];
  if (timeline) {
    const expected = expectedFilenamesFromTimeline(timeline);
    const present = await onDiskFilenames(id);
    missing = expected.filter((f) => !present.has(f)).sort();
  }

  const nextStatus: "healing" | "complete" = missing.length === 0 ? "complete" : "healing";
  const video = await setVideoStatus(id, nextStatus);

  const playlist = await buildPlaylist(video);
  await writePlaylist(id, playlist);

  // Kick off derivative generation (source.mp4, thumbnail.jpg) in the
  // background. Fire-and-forget — the client's stop flow never waits on
  // ffmpeg. A healed recording re-hitting /complete regenerates atomically.
  if (nextStatus === "complete") {
    scheduleDerivatives(id);
  }

  const path = `/${video.slug}`;
  const url = absoluteUrl(path);
  console.log(
    `[complete] ${video.slug} -> ${path} (status=${nextStatus}, missing=${missing.length})`,
  );
  return c.json({
    path,
    url,
    slug: video.slug,
    title: video.title,
    visibility: video.visibility,
    missing,
  });
});

// Upload a transcript (SRT or VTT). Writes the raw file to
// data/<id>/derivatives/captions.srt, parses to plain text, and upserts
// into video_transcripts + FTS. Idempotent — re-uploading replaces.
// 5 MB limit — generous for text transcripts.
videos.put("/:id/transcript", bodyLimit({ maxSize: 5 * 1024 * 1024 }), async (c) => {
  const { id } = c.req.param();
  const video = await getVideo(id);
  if (!video) return apiError(c, 404, "Video not found", ErrorCode.VIDEO_NOT_FOUND);

  const body = await c.req.text();
  if (!body.trim()) {
    return apiError(c, 400, "Empty transcript body", ErrorCode.VALIDATION_ERROR);
  }

  // Detect format from content or content-type header.
  const contentType = c.req.header("content-type") ?? "";
  const isVtt = contentType.includes("text/vtt") || body.trimStart().startsWith("WEBVTT");
  const format = isVtt ? "vtt" : "srt";
  const extension = isVtt ? "captions.vtt" : "captions.srt";

  // Write to derivatives/ atomically (tmp → rename).
  const derivDir = join(DATA_DIR, id, "derivatives");
  const { mkdir } = await import("fs/promises");
  await mkdir(derivDir, { recursive: true });
  const tmpPath = join(derivDir, `${extension}.tmp`);
  const finalPath = join(derivDir, extension);
  await Bun.write(tmpPath, body);
  const { rename } = await import("fs/promises");
  await rename(tmpPath, finalPath);

  // Parse to plain text and upsert into DB + FTS.
  const plainText = parseSrtToPlainText(body);
  await upsertTranscript(id, format, plainText);
  await logEvent(id, "transcript_uploaded", {
    format,
    wordCount: plainText.split(/\s+/).filter(Boolean).length,
  });

  console.log(
    `[transcript] ${id} (${format}, ${plainText.split(/\s+/).filter(Boolean).length} words)`,
  );
  return c.json({ ok: true });
});

// Upload word-level timestamp data (JSON array from WhisperKit). Writes to
// data/<id>/derivatives/words.json. Idempotent — re-uploading replaces.
// 10 MB limit — generous for word-level JSON.
videos.put("/:id/words", bodyLimit({ maxSize: 10 * 1024 * 1024 }), async (c) => {
  const { id } = c.req.param();
  const video = await getVideo(id);
  if (!video) return apiError(c, 404, "Video not found", ErrorCode.VIDEO_NOT_FOUND);

  const contentType = c.req.header("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return apiError(c, 400, "Content-Type must be application/json", ErrorCode.VALIDATION_ERROR);
  }

  let words: unknown;
  try {
    words = await c.req.json();
  } catch {
    return apiError(c, 400, "Malformed JSON body", ErrorCode.VALIDATION_ERROR);
  }

  if (!Array.isArray(words) || words.length === 0) {
    return apiError(c, 400, "Expected non-empty JSON array", ErrorCode.VALIDATION_ERROR);
  }

  // Write to derivatives/ atomically (tmp → rename).
  const derivDir = join(DATA_DIR, id, "derivatives");
  const { mkdir, rename: fsRename } = await import("fs/promises");
  await mkdir(derivDir, { recursive: true });
  const tmpPath = join(derivDir, "words.json.tmp");
  const finalPath = join(derivDir, "words.json");
  await Bun.write(tmpPath, JSON.stringify(words));
  await fsRename(tmpPath, finalPath);

  await logEvent(id, "words_uploaded", { wordCount: (words as unknown[]).length });

  console.log(`[words] ${id} (${(words as unknown[]).length} words)`);
  return c.json({ ok: true });
});

// Accept an AI-suggested title. Only applies if the video's title is still
// null (user hasn't manually set one). Idempotent — re-calling after a user
// edit is a silent no-op.
const suggestTitleSchema = z.object({
  title: z.string().min(1).max(200),
});

videos.put(
  "/:id/suggest-title",
  zValidator("json", suggestTitleSchema, (result, c) => {
    if (!result.success) {
      return apiError(c, 400, result.error.message, ErrorCode.VALIDATION_ERROR);
    }
  }),
  async (c) => {
    const { id } = c.req.param();
    const video = await getVideo(id);
    if (!video) return apiError(c, 404, "Video not found", ErrorCode.VIDEO_NOT_FOUND);

    const { title } = c.req.valid("json");

    if (video.title !== null) {
      // User already set a title — don't overwrite.
      await logEvent(id, "title_suggested", { title, applied: false });
      return c.json({ applied: false });
    }

    await updateVideo(id, { title });
    await logEvent(id, "title_suggested", { title, applied: true });
    console.log(`[suggest-title] ${id}: "${title}"`);
    return c.json({ applied: true });
  },
);

// Cancel/delete a recording. Only allowed for non-complete videos — once a
// video is complete it's shareable and deletion is an admin act.
videos.delete("/:id", async (c) => {
  const { id } = c.req.param();
  const existing = await getVideo(id);
  if (!existing) return apiError(c, 404, "Video not found", ErrorCode.VIDEO_NOT_FOUND);
  if (existing.status === "complete") {
    return apiError(c, 409, "Cannot delete a completed video", ErrorCode.VIDEO_ALREADY_COMPLETE);
  }

  await deleteVideo(id);
  await rm(join(DATA_DIR, id), { recursive: true, force: true });

  console.log(`[delete] ${id} (slug: ${existing.slug})`);
  return c.json({ ok: true });
});

export default videos;
