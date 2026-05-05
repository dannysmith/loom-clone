import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import { cp, mkdir } from "fs/promises";
import { humanId } from "human-id";
import { join } from "path";
import { getDb } from "../db/client";
import {
  slugRedirects,
  type Video,
  type VideoTranscript,
  videoSegments,
  videos,
  videoTags,
  videoTranscripts,
} from "../db/schema";
import { purgeGlobalFeeds, purgeSlugRename, purgeVideo } from "./cdn";
import { type EventType, logEvent } from "./events";
import { nowIso } from "./format";
import { searchVideoIds, updateFtsTranscript } from "./search";

export const DATA_DIR = "data";

// Re-export for convenience — routes import Video from here alongside store
// functions rather than reaching into db/schema directly.
export type { Video } from "../db/schema";

// Thrown when a slug or other input fails format/reservation validation.
// Routes map this to HTTP 400.
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

// Thrown when a mutation would violate uniqueness expectations (e.g. slug
// already in use by another video or redirect). Routes map this to HTTP 409.
export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

// Slug format: lowercase alphanumeric + single dashes, no leading/trailing/double dashes.
// Deliberately excludes dots and slashes so `.json`/`.md`/`.mp4` suffix routes and
// nested paths can never collide with a real slug.
//
// Pattern source (without ^/$ anchors) is exported separately for use in Hono
// route constraints: `app.get(`/:slug{${SLUG_PATTERN}}`, ...)`. Non-capturing
// group avoids any chance of a router treating the inner alternatives as
// indexed captures.
export const SLUG_PATTERN = "[a-z0-9](?:-?[a-z0-9])*";
export const SLUG_REGEX = new RegExp(`^${SLUG_PATTERN}$`);
export const SLUG_MAX_LENGTH = 200;

// Slugs that would shadow a top-level route or well-known file. Names are
// stored without their extension because the regex already forbids dots —
// `robots.txt` can't be a slug, but `robots` could without this list.
// Keep this list close to the route mounts in `app.ts`.
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  // Current and near-future module mounts
  "admin",
  "api",
  "static",
  "data",
  "v",
  // Well-known root files
  "robots",
  "favicon",
  "sitemap",
  "humans",
  "manifest",
  "apple-touch-icon",
  // Likely future top-level routes
  "health",
  "login",
  "logout",
  "auth",
  "signup",
  // Currently slug sub-paths; reserved in case they ever go top-level
  "embed",
  "raw",
  "stream",
  "poster",
  "feed",
  "rss",
  "search",
]);

const VALID_VISIBILITY = new Set(["public", "unlisted", "private"]);

export function validateVisibility(v: string): asserts v is Video["visibility"] {
  if (!VALID_VISIBILITY.has(v)) {
    throw new ValidationError(`Invalid visibility "${v}". Must be public, unlisted, or private`);
  }
}

// Validates a user-supplied slug's format and reservation status. Throws
// ValidationError on failure (400-class input errors). Uniqueness is checked
// separately by the caller against the DB (ConflictError, 409).
export function validateSlugFormat(slug: string): void {
  if (slug.length === 0 || slug.length > SLUG_MAX_LENGTH) {
    throw new ValidationError(`Slug must be 1-${SLUG_MAX_LENGTH} characters`);
  }
  if (!SLUG_REGEX.test(slug)) {
    throw new ValidationError(
      `Slug "${slug}" must be lowercase alphanumeric with single dashes (no dots, slashes, leading/trailing dashes)`,
    );
  }
  if (RESERVED_SLUGS.has(slug)) {
    throw new ValidationError(`Slug "${slug}" is reserved`);
  }
}

// Checks that a slug is not already taken by another video or redirect.
// Throws ConflictError if unavailable. `excludeVideoId` is used when
// renaming an existing video's slug (so its own current slug doesn't clash).
export function checkSlugAvailable(slug: string, excludeVideoId?: string): void {
  const db = getDb();
  const slugWhere = excludeVideoId
    ? and(eq(videos.slug, slug), ne(videos.id, excludeVideoId))
    : eq(videos.slug, slug);
  const taken = db.select({ id: videos.id }).from(videos).where(slugWhere).get();
  if (taken) {
    throw new ConflictError(`Slug "${slug}" is already in use by another video`);
  }

  const redirectTaken = db
    .select({ oldSlug: slugRedirects.oldSlug, videoId: slugRedirects.videoId })
    .from(slugRedirects)
    .where(eq(slugRedirects.oldSlug, slug))
    .get();
  if (redirectTaken && redirectTaken.videoId !== excludeVideoId) {
    throw new ConflictError(`Slug "${slug}" is reserved as a redirect`);
  }
}

// Most lookups default to hiding trashed videos so public-facing routes can't
// accidentally surface them. Admin-side callers opt in via { includeTrashed: true }.
export type GetOpts = { includeTrashed?: boolean };

export type VideoPatch = {
  title?: string | null;
  description?: string | null;
  notes?: string | null;
  visibility?: Video["visibility"];
};

function generateSlug(): string {
  // 3-word slug from human-id (adjective-noun-verb, ~15M combinations).
  // Re-roll if it lands on a reserved word — unlikely but the loop costs nothing.
  while (true) {
    const slug = humanId({ separator: "-", capitalize: false });
    if (!RESERVED_SLUGS.has(slug)) return slug;
  }
}

export async function createVideo(): Promise<Video> {
  const db = getDb();
  const id = crypto.randomUUID();
  const slug = generateSlug();
  const now = nowIso();

  const [video] = await db
    .insert(videos)
    .values({ id, slug, createdAt: now, updatedAt: now })
    .returning();
  if (!video) throw new Error("failed to create video");

  await mkdir(join(DATA_DIR, id), { recursive: true });
  await logEvent(id, "created");
  return video;
}

// Options for creating a video from an uploaded file.
export type UploadVideoOpts = {
  slug?: string; // custom slug; random if empty/omitted
  title?: string | null;
  description?: string | null;
  visibility?: string; // validated internally
};

// Creates a video record for an uploaded MP4. Handles slug validation/
// generation, visibility validation, tag assignment, and event logging.
// File I/O (saving the upload, probing duration, scheduling derivatives)
// stays in the route — the store handles DB concerns only.
// Throws ValidationError/ConflictError on bad input.
export async function createUploadedVideo(opts: UploadVideoOpts): Promise<Video> {
  const db = getDb();
  const id = crypto.randomUUID();
  const now = nowIso();

  // Visibility
  const visibility = opts.visibility || "unlisted";
  validateVisibility(visibility);

  // Slug: validate custom slug or generate a random one.
  let slug: string;
  if (opts.slug) {
    validateSlugFormat(opts.slug);
    checkSlugAvailable(opts.slug);
    slug = opts.slug;
  } else {
    slug = generateSlug();
  }

  const [video] = await db
    .insert(videos)
    .values({
      id,
      slug,
      status: "complete",
      visibility,
      title: opts.title ?? null,
      description: opts.description ?? null,
      source: "uploaded",
      createdAt: now,
      updatedAt: now,
      completedAt: now,
    })
    .returning();
  if (!video) throw new Error("Failed to create uploaded video");

  await mkdir(join(DATA_DIR, id), { recursive: true });
  await logEvent(id, "uploaded");
  return video;
}

export async function getVideo(id: string, opts: GetOpts = {}): Promise<Video | undefined> {
  const where = opts.includeTrashed
    ? eq(videos.id, id)
    : and(eq(videos.id, id), isNull(videos.trashedAt));
  return getDb().select().from(videos).where(where).get();
}

export async function getVideoBySlug(slug: string, opts: GetOpts = {}): Promise<Video | undefined> {
  const where = opts.includeTrashed
    ? eq(videos.slug, slug)
    : and(eq(videos.slug, slug), isNull(videos.trashedAt));
  return getDb().select().from(videos).where(where).get();
}

// Newest first. Excludes trashed videos by default.
export async function listVideos(opts: GetOpts = {}): Promise<Video[]> {
  const base = getDb().select().from(videos);
  return opts.includeTrashed
    ? base.orderBy(desc(videos.createdAt))
    : base.where(isNull(videos.trashedAt)).orderBy(desc(videos.createdAt));
}

export type ListPaginatedOpts = GetOpts & {
  limit?: number;
  cursor?: string; // id of the last video from the previous page
};

// Cursor-paginated listing. Cursor is a video id; items after that video's
// createdAt (in DESC order) are returned. Fetches limit+1 to detect whether
// a next page exists without a separate count query.
export async function listVideosPaginated(opts: ListPaginatedOpts = {}): Promise<{
  items: Video[];
  nextCursor: string | null;
}> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const db = getDb();

  const conditions: ReturnType<typeof eq>[] = [];
  if (!opts.includeTrashed) conditions.push(isNull(videos.trashedAt));

  if (opts.cursor) {
    const cursorVideo = db
      .select({ createdAt: videos.createdAt, id: videos.id })
      .from(videos)
      .where(eq(videos.id, opts.cursor))
      .get();
    if (cursorVideo) {
      // Composite cursor: items that sort after the cursor in (createdAt DESC, id DESC).
      // Handles timestamp ties from rapid creates (common in tests, possible in prod).
      conditions.push(
        or(
          lt(videos.createdAt, cursorVideo.createdAt),
          and(eq(videos.createdAt, cursorVideo.createdAt), lt(videos.id, cursorVideo.id)),
        )!,
      );
    }
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const rows = await db
    .select()
    .from(videos)
    .where(where)
    .orderBy(desc(videos.createdAt), desc(videos.id))
    .limit(limit + 1);

  const hasNext = rows.length > limit;
  const items = hasNext ? rows.slice(0, limit) : rows;
  const lastItem = items[items.length - 1];
  const nextCursor = hasNext && lastItem ? lastItem.id : null;

  return { items, nextCursor };
}

// --- Dashboard listing with filtering, sorting, and search ---

export type DashboardSort =
  | "date-desc"
  | "date-asc"
  | "duration-desc"
  | "duration-asc"
  | "title-asc"
  | "title-desc";

export type DashboardFilters = {
  search?: string;
  visibility?: Video["visibility"];
  status?: Video["status"];
  tagId?: number;
  dateFrom?: string; // ISO date string
  dateTo?: string; // ISO date string
  durationMin?: number; // seconds
  durationMax?: number; // seconds
  sort?: DashboardSort;
  cursor?: string; // video ID of last item from previous page
  limit?: number;
  trashedOnly?: boolean; // true for the Trash Bin page
};

export async function listVideosFiltered(filters: DashboardFilters = {}): Promise<{
  items: Video[];
  nextCursor: string | null;
}> {
  const limit = Math.min(Math.max(filters.limit ?? 20, 1), 100);
  const sort = filters.sort ?? "date-desc";
  const db = getDb();

  const conditions: ReturnType<typeof eq>[] = [];

  // Trash filter
  if (filters.trashedOnly) {
    conditions.push(sql`${videos.trashedAt} IS NOT NULL`);
  } else {
    conditions.push(isNull(videos.trashedAt));
  }

  // FTS5 search
  if (filters.search) {
    const matchingIds = searchVideoIds(filters.search);
    if (matchingIds.length === 0) return { items: [], nextCursor: null };
    conditions.push(inArray(videos.id, matchingIds));
  }

  // Filters
  if (filters.visibility) conditions.push(eq(videos.visibility, filters.visibility));
  if (filters.status) conditions.push(eq(videos.status, filters.status));
  if (filters.dateFrom) conditions.push(gte(videos.createdAt, filters.dateFrom));
  if (filters.dateTo) conditions.push(lte(videos.createdAt, filters.dateTo));
  if (filters.durationMin != null)
    conditions.push(gte(videos.durationSeconds, filters.durationMin));
  if (filters.durationMax != null)
    conditions.push(lte(videos.durationSeconds, filters.durationMax));

  // Tag filter via subquery
  if (filters.tagId != null) {
    const taggedIds = db
      .select({ videoId: videoTags.videoId })
      .from(videoTags)
      .where(eq(videoTags.tagId, filters.tagId));
    conditions.push(inArray(videos.id, taggedIds));
  }

  // Cursor pagination — look up the cursor video's sort-column value
  if (filters.cursor) {
    const cursorVideo = db
      .select({
        id: videos.id,
        createdAt: videos.createdAt,
        durationSeconds: videos.durationSeconds,
        title: videos.title,
      })
      .from(videos)
      .where(eq(videos.id, filters.cursor))
      .get();

    if (cursorVideo) {
      conditions.push(cursorCondition(sort, cursorVideo));
    }
  }

  // Sort order
  const orderCols = sortOrder(sort);

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const rows = await db
    .select()
    .from(videos)
    .where(where)
    .orderBy(...orderCols)
    .limit(limit + 1);

  const hasNext = rows.length > limit;
  const items = hasNext ? rows.slice(0, limit) : rows;
  const lastItem = items[items.length - 1];
  const nextCursor = hasNext && lastItem ? lastItem.id : null;

  return { items, nextCursor };
}

type CursorVideo = {
  id: string;
  createdAt: string;
  durationSeconds: number | null;
  title: string | null;
};

// Returns a WHERE clause that selects rows "after" the cursor in the given
// sort order. Uses composite tiebreakers to ensure stable pagination.
function cursorCondition(sort: DashboardSort, c: CursorVideo): ReturnType<typeof eq> {
  switch (sort) {
    case "date-desc":
      return or(
        lt(videos.createdAt, c.createdAt),
        and(eq(videos.createdAt, c.createdAt), lt(videos.id, c.id)),
      )!;
    case "date-asc":
      return or(
        gt(videos.createdAt, c.createdAt),
        and(eq(videos.createdAt, c.createdAt), gt(videos.id, c.id)),
      )!;
    case "duration-desc": {
      const d = c.durationSeconds ?? 0;
      return or(
        lt(videos.durationSeconds, d),
        and(eq(videos.durationSeconds, d), lt(videos.id, c.id)),
      )!;
    }
    case "duration-asc": {
      const d = c.durationSeconds ?? 0;
      return or(
        gt(videos.durationSeconds, d),
        and(eq(videos.durationSeconds, d), gt(videos.id, c.id)),
        // Nulls sort last in asc — include them after all non-null values
        and(
          sql`${videos.durationSeconds} IS NOT NULL`,
          eq(videos.durationSeconds, d),
          gt(videos.id, c.id),
        ),
      )!;
    }
    case "title-asc": {
      const t = c.title ?? "";
      return or(
        sql`${videos.title} > ${t}`,
        and(sql`${videos.title} = ${t}`, gt(videos.id, c.id)),
      )!;
    }
    case "title-desc": {
      const t = c.title ?? "";
      return or(
        sql`${videos.title} < ${t}`,
        and(sql`${videos.title} = ${t}`, lt(videos.id, c.id)),
      )!;
    }
  }
}

function sortOrder(sort: DashboardSort) {
  switch (sort) {
    case "date-desc":
      return [desc(videos.createdAt), desc(videos.id)] as const;
    case "date-asc":
      return [asc(videos.createdAt), asc(videos.id)] as const;
    case "duration-desc":
      return [desc(videos.durationSeconds), desc(videos.id)] as const;
    case "duration-asc":
      return [asc(videos.durationSeconds), asc(videos.id)] as const;
    case "title-asc":
      return [asc(videos.title), asc(videos.id)] as const;
    case "title-desc":
      return [desc(videos.title), desc(videos.id)] as const;
  }
}

// Resolves a public slug for viewer-facing routes. Checks the current slug
// first, then falls back to the redirect table. Returns null for unknown
// slugs, trashed videos, and private videos — private content is only
// accessible via bearer-authed API routes (by id, not slug).
export async function resolveSlug(
  slug: string,
  opts: GetOpts = {},
): Promise<{ video: Video; redirected: boolean } | null> {
  const direct = await getVideoBySlug(slug, opts);
  if (direct) {
    if (direct.visibility === "private") return null;
    return { video: direct, redirected: false };
  }

  const redirect = await getDb()
    .select()
    .from(slugRedirects)
    .where(eq(slugRedirects.oldSlug, slug))
    .get();
  if (!redirect) return null;

  const target = await getVideo(redirect.videoId, opts);
  if (!target || target.visibility === "private") return null;
  return { video: target, redirected: true };
}

// Idempotent: same filename overwrites its duration. Upsert on the composite
// primary key handles duplicates cleanly. The FK constraint on video_id
// rejects inserts for unknown videos, so no pre-check SELECT is needed.
export async function addSegment(id: string, filename: string, duration: number): Promise<void> {
  const db = getDb();
  await db
    .insert(videoSegments)
    .values({ videoId: id, filename, durationSeconds: duration, uploadedAt: nowIso() })
    .onConflictDoUpdate({
      target: [videoSegments.videoId, videoSegments.filename],
      set: { durationSeconds: duration, uploadedAt: nowIso() },
    });
}

export async function getSegmentDurations(id: string): Promise<Map<string, number>> {
  const rows = await getDb()
    .select({ filename: videoSegments.filename, duration: videoSegments.durationSeconds })
    .from(videoSegments)
    .where(eq(videoSegments.videoId, id));
  const map = new Map<string, number>();
  for (const row of rows) map.set(row.filename, row.duration);
  return map;
}

async function sumSegmentDuration(id: string): Promise<number> {
  const [row] = await getDb()
    .select({ total: sql<number>`COALESCE(SUM(${videoSegments.durationSeconds}), 0)` })
    .from(videoSegments)
    .where(eq(videoSegments.videoId, id));
  return row?.total ?? 0;
}

export async function setVideoStatus(id: string, status: Video["status"]): Promise<Video> {
  const db = getDb();
  const existing = await getVideo(id);
  if (!existing) throw new Error(`Video ${id} not found`);
  if (existing.status === status) return existing;

  const now = nowIso();
  const updates: Partial<Video> = { status, updatedAt: now };

  // Cache duration and set completedAt on transition TO complete. completedAt
  // is set-once so a healing→complete→(something weird)→complete chain keeps
  // the original timestamp. Duration is always recomputed so segments added
  // during healing get reflected.
  if (status === "complete") {
    updates.durationSeconds = await sumSegmentDuration(id);
    if (!existing.completedAt) updates.completedAt = now;
  }

  const [video] = await db.update(videos).set(updates).where(eq(videos.id, id)).returning();
  if (!video) throw new Error(`Video ${id} not found`);

  if (status === "complete") {
    const eventType = existing.status === "healing" ? "healed" : "completed";
    await logEvent(id, eventType);
    purgeGlobalFeeds();
  }

  return video;
}

// Thin shim retained so routes and tests don't all need updating.
export async function completeVideo(id: string): Promise<Video> {
  return setVideoStatus(id, "complete");
}

export async function deleteVideo(id: string): Promise<Video | undefined> {
  const db = getDb();
  const video = await getVideo(id, { includeTrashed: true });
  if (!video) return undefined;
  // FK cascades handle video_segments, slug_redirects, video_tags, video_events.
  await db.delete(videos).where(eq(videos.id, id));
  purgeVideo(video.slug);
  return video;
}

// Applies a title/description/visibility patch. Only fields the caller
// actually changed produce an event; repeatedly setting the same value is a
// no-op (no event, no row touch). Returns the updated video.
export async function updateVideo(id: string, patch: VideoPatch): Promise<Video> {
  const existing = await getVideo(id, { includeTrashed: true });
  if (!existing) throw new Error(`Video ${id} not found`);

  const changes: Partial<Video> = {};
  const events: Array<{ type: EventType; data: unknown }> = [];

  if (patch.title !== undefined && patch.title !== existing.title) {
    changes.title = patch.title;
    events.push({ type: "title_changed", data: { from: existing.title, to: patch.title } });
  }
  if (patch.description !== undefined && patch.description !== existing.description) {
    changes.description = patch.description;
    events.push({
      type: "description_changed",
      data: { from: existing.description, to: patch.description },
    });
  }
  if (patch.notes !== undefined && patch.notes !== existing.notes) {
    changes.notes = patch.notes;
    events.push({
      type: "notes_changed",
      data: { from: existing.notes, to: patch.notes },
    });
  }
  if (patch.visibility !== undefined && patch.visibility !== existing.visibility) {
    changes.visibility = patch.visibility;
    events.push({
      type: "visibility_changed",
      data: { from: existing.visibility, to: patch.visibility },
    });
  }

  if (events.length === 0) return existing;

  changes.updatedAt = nowIso();
  const [updated] = await getDb().update(videos).set(changes).where(eq(videos.id, id)).returning();
  if (!updated) throw new Error(`Video ${id} not found`);

  for (const event of events) {
    await logEvent(id, event.type, event.data);
  }
  purgeVideo(updated.slug);
  return updated;
}

// Changes a video's slug, preserving the old one as a redirect. Old URLs
// continue to work (resolveSlug follows the redirect). Rejects with
// ConflictError if the new slug is already taken by another video's current
// slug or by any existing redirect row.
export async function updateSlug(id: string, newSlug: string): Promise<Video> {
  const db = getDb();
  const existing = await getVideo(id, { includeTrashed: true });
  if (!existing) throw new Error(`Video ${id} not found`);
  if (existing.slug === newSlug) return existing;

  // Format + reservation + uniqueness checks.
  validateSlugFormat(newSlug);
  checkSlugAvailable(newSlug, id);

  const oldSlug = existing.slug;
  const now = nowIso();

  // Transaction: add the old slug to redirects + point the video at the new
  // slug. Atomic so a crash can't leave a video with no resolvable URL.
  // If the new slug was a previous slug for this same video, remove that
  // redirect first — the video is reclaiming its old slug.
  await db.transaction((tx) => {
    tx.delete(slugRedirects)
      .where(and(eq(slugRedirects.oldSlug, newSlug), eq(slugRedirects.videoId, id)))
      .run();
    tx.insert(slugRedirects).values({ oldSlug, videoId: id, createdAt: now }).run();
    tx.update(videos).set({ slug: newSlug, updatedAt: now }).where(eq(videos.id, id)).run();
  });

  await logEvent(id, "slug_changed", { from: oldSlug, to: newSlug });
  purgeSlugRename(oldSlug, newSlug);

  const updated = await getVideo(id, { includeTrashed: true });
  if (!updated) throw new Error(`Video ${id} not found post-update`);
  return updated;
}

// Soft-delete: sets trashedAt. All default-scoped lookups will ignore the
// video after this. FK cascades handle nothing here — the row stays, and
// segments/events/tags stay with it.
export async function trashVideo(id: string): Promise<Video> {
  const existing = await getVideo(id, { includeTrashed: true });
  if (!existing) throw new Error(`Video ${id} not found`);
  if (existing.trashedAt) return existing;

  const now = nowIso();
  const [updated] = await getDb()
    .update(videos)
    .set({ trashedAt: now, updatedAt: now })
    .where(eq(videos.id, id))
    .returning();
  if (!updated) throw new Error(`Video ${id} not found`);

  await logEvent(id, "trashed");
  purgeVideo(updated.slug);
  return updated;
}

// Restore a trashed video. Clears trashedAt, preserving the original
// visibility, slug, and all data.
export async function untrashVideo(id: string): Promise<Video> {
  const existing = await getVideo(id, { includeTrashed: true });
  if (!existing) throw new Error(`Video ${id} not found`);
  if (!existing.trashedAt) return existing;

  const now = nowIso();
  const [updated] = await getDb()
    .update(videos)
    .set({ trashedAt: null, updatedAt: now })
    .where(eq(videos.id, id))
    .returning();
  if (!updated) throw new Error(`Video ${id} not found`);

  await logEvent(id, "untrashed");
  purgeGlobalFeeds();
  return updated;
}

// Creates a complete copy of a video: new UUID, new slug, new title suffix,
// all files copied, tags preserved, events on both original and duplicate.
export async function duplicateVideo(id: string): Promise<Video> {
  const db = getDb();
  const original = await getVideo(id, { includeTrashed: true });
  if (!original) throw new Error(`Video ${id} not found`);

  const newId = crypto.randomUUID();
  const newSlug = await findAvailableSlug(original.slug);
  const newTitle = original.title ? findAvailableTitle(original.title) : null;
  const now = nowIso();

  // Insert the new video row with preserved metadata.
  const [duplicate] = await db
    .insert(videos)
    .values({
      id: newId,
      slug: newSlug,
      status: original.status,
      visibility: original.visibility,
      title: newTitle,
      description: original.description,
      durationSeconds: original.durationSeconds,
      width: original.width,
      height: original.height,
      aspectRatio: original.aspectRatio,
      fileBytes: original.fileBytes,
      cameraName: original.cameraName,
      microphoneName: original.microphoneName,
      recordingHealth: original.recordingHealth,
      source: original.source,
      createdAt: now,
      updatedAt: now,
      completedAt: original.completedAt ? now : null,
    })
    .returning();
  if (!duplicate) throw new Error("Failed to create duplicate video");

  // Copy tag associations.
  const originalTags = await db
    .select({ tagId: videoTags.tagId })
    .from(videoTags)
    .where(eq(videoTags.videoId, id));
  for (const { tagId } of originalTags) {
    await db.insert(videoTags).values({ videoId: newId, tagId }).onConflictDoNothing();
  }

  // Copy segment records.
  const originalSegments = await db
    .select()
    .from(videoSegments)
    .where(eq(videoSegments.videoId, id));
  for (const seg of originalSegments) {
    await db.insert(videoSegments).values({
      videoId: newId,
      filename: seg.filename,
      durationSeconds: seg.durationSeconds,
      uploadedAt: now,
    });
  }

  // Copy files on disk.
  const srcDir = join(DATA_DIR, id);
  const dstDir = join(DATA_DIR, newId);
  try {
    await cp(srcDir, dstDir, { recursive: true });
  } catch {
    // Source dir may not exist (e.g. in tests). The video record is still valid.
    await mkdir(dstDir, { recursive: true });
  }

  // Log events on both videos.
  await logEvent(id, "duplicated", { newId: newId, newSlug });
  await logEvent(newId, "duplicated_from", { originalId: id, originalSlug: original.slug });

  return duplicate;
}

// Finds an available slug by appending -1, -2, etc.
async function findAvailableSlug(baseSlug: string): Promise<string> {
  const db = getDb();
  for (let i = 1; i < 100; i++) {
    const candidate = `${baseSlug}-${i}`;
    if (candidate.length > SLUG_MAX_LENGTH) break;
    const existing = db
      .select({ id: videos.id })
      .from(videos)
      .where(eq(videos.slug, candidate))
      .get();
    const redirect = db
      .select({ oldSlug: slugRedirects.oldSlug })
      .from(slugRedirects)
      .where(eq(slugRedirects.oldSlug, candidate))
      .get();
    if (!existing && !redirect) return candidate;
  }
  // Fallback: fresh random slug
  return generateSlug();
}

// Appends " (1)" to a title, stripping any existing " (N)" suffix first.
// Titles aren't unique so no DB check needed — just increment the suffix.
function findAvailableTitle(baseTitle: string): string {
  const match = baseTitle.match(/^(.*) \((\d+)\)$/);
  if (match?.[1] != null && match[2] != null) {
    return `${match[1]} (${Number(match[2]) + 1})`;
  }
  return `${baseTitle} (1)`;
}

// --- Transcripts ---

export async function getTranscript(videoId: string): Promise<VideoTranscript | undefined> {
  return getDb().select().from(videoTranscripts).where(eq(videoTranscripts.videoId, videoId)).get();
}

// Upserts a transcript record and updates the FTS index. Idempotent —
// re-uploading replaces the previous transcript.
export async function upsertTranscript(
  videoId: string,
  format: string,
  plainText: string,
): Promise<void> {
  const wordCount = plainText.split(/\s+/).filter(Boolean).length;
  const now = nowIso();
  await getDb()
    .insert(videoTranscripts)
    .values({ videoId, format, plainText, wordCount, createdAt: now })
    .onConflictDoUpdate({
      target: videoTranscripts.videoId,
      set: { format, plainText, wordCount, createdAt: now },
    });
  updateFtsTranscript(videoId, plainText);
}
