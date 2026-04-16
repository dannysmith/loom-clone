import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";
import { mkdir } from "fs/promises";
import { join } from "path";
import { getDb } from "../db/client";
import { slugRedirects, type Video, videoSegments, videos } from "../db/schema";
import { logEvent } from "./events";

export const DATA_DIR = "data";

// Back-compat alias — routes and tests that imported VideoRecord continue to
// work. The new shape has extra fields (visibility, source, timestamps,
// nullable metadata) but that's additive and non-breaking.
export type VideoRecord = Video;

// Thrown by mutating ops when the requested change would violate uniqueness
// expectations (e.g. slug already in use) or slug format/reservation rules.
// Routes map this to HTTP 409.
export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

// Slug format: lowercase alphanumeric + single dashes, no leading/trailing/double dashes.
// Deliberately excludes dots and slashes so `.json`/`.md`/`.mp4` suffix routes and
// nested paths can never collide with a real slug.
export const SLUG_REGEX = /^[a-z0-9](-?[a-z0-9])*$/;
export const SLUG_MAX_LENGTH = 64;

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

// Validates a user-supplied slug's format and reservation status. Throws
// ConflictError on failure so routes get a uniform 409 mapping. Uniqueness
// is checked separately by the caller against the DB.
export function validateSlugFormat(slug: string): void {
  if (slug.length === 0 || slug.length > SLUG_MAX_LENGTH) {
    throw new ConflictError(`Slug must be 1-${SLUG_MAX_LENGTH} characters`);
  }
  if (!SLUG_REGEX.test(slug)) {
    throw new ConflictError(
      `Slug "${slug}" must be lowercase alphanumeric with single dashes (no dots, slashes, leading/trailing dashes)`,
    );
  }
  if (RESERVED_SLUGS.has(slug)) {
    throw new ConflictError(`Slug "${slug}" is reserved`);
  }
}

// Most lookups default to hiding trashed videos so public-facing routes can't
// accidentally surface them. Admin-side callers opt in via { includeTrashed: true }.
export type GetOpts = { includeTrashed?: boolean };

export type VideoPatch = {
  title?: string | null;
  description?: string | null;
  visibility?: Video["visibility"];
};

function nowIso(): string {
  return new Date().toISOString();
}

function generateSlug(): string {
  // 8 hex chars from 4 random bytes. Re-roll if it lands on a reserved word —
  // none currently match the 8-char hex shape, but the loop costs nothing and
  // means the reserved list can grow without revisiting this function.
  while (true) {
    const slug = crypto
      .getRandomValues(new Uint8Array(4))
      .reduce((s, b) => s + b.toString(16).padStart(2, "0"), "");
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

// Resolves a public slug. Checks the current slug first, then falls back to
// the redirect table. Returns null for unknown slugs and for redirects whose
// target video has been trashed (respects the same visibility rules as
// getVideoBySlug).
export async function resolveSlug(
  slug: string,
  opts: GetOpts = {},
): Promise<{ video: Video; redirected: boolean } | null> {
  const direct = await getVideoBySlug(slug, opts);
  if (direct) return { video: direct, redirected: false };

  const redirect = await getDb()
    .select()
    .from(slugRedirects)
    .where(eq(slugRedirects.oldSlug, slug))
    .get();
  if (!redirect) return null;

  const target = await getVideo(redirect.videoId, opts);
  if (!target) return null;
  return { video: target, redirected: true };
}

// Idempotent: same filename overwrites its duration. Upsert on the composite
// primary key handles duplicates cleanly.
export async function addSegment(id: string, filename: string, duration: number): Promise<void> {
  const db = getDb();
  const exists = await getVideo(id);
  if (!exists) throw new Error(`Video ${id} not found`);
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
  return video;
}

// Applies a title/description/visibility patch. Only fields the caller
// actually changed produce an event; repeatedly setting the same value is a
// no-op (no event, no row touch). Returns the updated video.
export async function updateVideo(id: string, patch: VideoPatch): Promise<Video> {
  const existing = await getVideo(id, { includeTrashed: true });
  if (!existing) throw new Error(`Video ${id} not found`);

  const changes: Partial<Video> = {};
  const events: Array<{ type: string; data: unknown }> = [];

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

  // Format + reservation checks before hitting the DB.
  validateSlugFormat(newSlug);

  const slugTaken = await db
    .select()
    .from(videos)
    .where(and(eq(videos.slug, newSlug), ne(videos.id, id)))
    .get();
  if (slugTaken) {
    throw new ConflictError(`Slug "${newSlug}" is already in use by another video`);
  }

  const redirectTaken = await db
    .select()
    .from(slugRedirects)
    .where(eq(slugRedirects.oldSlug, newSlug))
    .get();
  if (redirectTaken) {
    throw new ConflictError(`Slug "${newSlug}" is reserved as a redirect`);
  }

  const oldSlug = existing.slug;
  const now = nowIso();

  // Transaction: add the old slug to redirects + point the video at the new
  // slug. Atomic so a crash can't leave a video with no resolvable URL.
  db.transaction((tx) => {
    tx.insert(slugRedirects).values({ oldSlug, videoId: id, createdAt: now }).run();
    tx.update(videos).set({ slug: newSlug, updatedAt: now }).where(eq(videos.id, id)).run();
  });

  await logEvent(id, "slug_changed", { from: oldSlug, to: newSlug });

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
  return updated;
}
