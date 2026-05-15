import { and, desc, eq, getTableColumns, inArray, isNull, ne } from "drizzle-orm";
import { getDb } from "../db/client";
import {
  TAG_COLORS,
  type Tag,
  type TagColor,
  tagSlugRedirects,
  tags,
  type Video,
  videos,
  videoTags,
} from "../db/schema";
import { purgeTag } from "./cdn";
import { logEvent } from "./events";
import { ConflictError, checkSlugAvailable, ValidationError, validateSlugFormat } from "./store";

function validateColor(color: string): asserts color is TagColor {
  if (!TAG_COLORS.includes(color as TagColor)) {
    throw new ValidationError(
      `Invalid tag color "${color}". Must be one of: ${TAG_COLORS.join(", ")}`,
    );
  }
}

const VALID_TAG_VISIBILITY = new Set(["public", "unlisted", "private"] as const);

function validateTagVisibility(v: string): asserts v is Tag["visibility"] {
  if (!VALID_TAG_VISIBILITY.has(v as Tag["visibility"])) {
    throw new ValidationError(`Invalid visibility "${v}". Must be public, unlisted, or private`);
  }
}

// A tag has a public surface when it isn't private and has a slug. Used to
// decide whether to issue CDN purges and to render public URLs in the admin.
function hasPublicSurface(tag: Pick<Tag, "visibility" | "slug">): boolean {
  return tag.visibility !== "private" && tag.slug !== null;
}

// Creates a new tag. Tag names are unique case-sensitively (matches the DB
// constraint); callers that want case-insensitive matching should normalise
// upstream. Throws ConflictError if the name already exists.
export async function createTag(name: string, color?: TagColor): Promise<Tag> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Tag name cannot be empty");
  if (color !== undefined) validateColor(color);

  // Use onConflictDoNothing to avoid the TOCTOU race of check-then-insert.
  // If the name already exists, the insert returns nothing and we throw.
  const values: { name: string; color?: TagColor } = { name: trimmed };
  if (color !== undefined) values.color = color;

  const [tag] = await getDb().insert(tags).values(values).onConflictDoNothing().returning();
  if (!tag) throw new ConflictError(`Tag "${trimmed}" already exists`);
  return tag;
}

export async function listTags(): Promise<Tag[]> {
  return getDb().select().from(tags).orderBy(tags.name);
}

export async function getTag(id: number): Promise<Tag | undefined> {
  return getDb().select().from(tags).where(eq(tags.id, id)).get();
}

// Lookup by current slug only — does not follow tag_slug_redirects. Use
// resolveTagSlug() for viewer-facing lookups that should follow redirects.
export async function getTagBySlug(slug: string): Promise<Tag | undefined> {
  return getDb().select().from(tags).where(eq(tags.slug, slug)).get();
}

export type TagPatch = {
  name?: string;
  color?: TagColor;
  visibility?: Tag["visibility"];
  // null clears the slug (only valid when visibility is private).
  slug?: string | null;
  description?: string | null;
};

// Updates a tag's mutable fields. Slug renames preserve the old slug as a
// redirect (mirroring video slug behaviour). Visibility rules:
//   - private: slug may be null
//   - unlisted/public: slug must be non-null (in patch or already on the tag)
// Throws ValidationError / ConflictError on invalid input.
export async function updateTag(id: number, patch: TagPatch): Promise<Tag> {
  const existing = await getTag(id);
  if (!existing) throw new Error(`Tag ${id} not found`);

  const changes: Partial<Tag> = {};
  let oldSlugForRedirect: string | null = null;

  // Name
  if (patch.name !== undefined) {
    const trimmed = patch.name.trim();
    if (!trimmed) throw new Error("Tag name cannot be empty");
    if (trimmed !== existing.name) changes.name = trimmed;
  }

  // Color
  if (patch.color !== undefined) {
    validateColor(patch.color);
    if (patch.color !== existing.color) changes.color = patch.color;
  }

  // Visibility
  if (patch.visibility !== undefined) {
    validateTagVisibility(patch.visibility);
    if (patch.visibility !== existing.visibility) changes.visibility = patch.visibility;
  }

  // Slug — validate format/reservation/uniqueness; capture old slug for
  // redirect insertion if it changed and was non-null.
  if (patch.slug !== undefined) {
    const newSlug = patch.slug === null ? null : patch.slug.trim() || null;
    if (newSlug !== existing.slug) {
      if (newSlug !== null) {
        validateSlugFormat(newSlug);
        checkSlugAvailable(newSlug, { tagId: id });
      }
      changes.slug = newSlug;
      if (existing.slug) oldSlugForRedirect = existing.slug;
    }
  }

  // Description
  if (patch.description !== undefined) {
    const desc = patch.description === null ? null : patch.description.trim() || null;
    if (desc !== existing.description) changes.description = desc;
  }

  // Invariant check across merged state: public/unlisted tags must have a slug.
  const finalVisibility = changes.visibility ?? existing.visibility;
  const finalSlug = "slug" in changes ? changes.slug : existing.slug;
  if ((finalVisibility === "public" || finalVisibility === "unlisted") && !finalSlug) {
    throw new ValidationError(`Tag visibility "${finalVisibility}" requires a slug`);
  }

  if (Object.keys(changes).length === 0) return existing;

  try {
    await getDb().transaction((tx) => {
      if (oldSlugForRedirect) {
        // Reclaim case: if this tag is taking back a slug it once owned via
        // a redirect, drop that redirect row first.
        if (changes.slug) {
          tx.delete(tagSlugRedirects)
            .where(and(eq(tagSlugRedirects.oldSlug, changes.slug), eq(tagSlugRedirects.tagId, id)))
            .run();
        }
        tx.insert(tagSlugRedirects).values({ oldSlug: oldSlugForRedirect, tagId: id }).run();
      }
      tx.update(tags).set(changes).where(eq(tags.id, id)).run();
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes("UNIQUE constraint failed")) {
      if (err.message.includes("tags.name")) {
        throw new ConflictError(`Tag "${changes.name}" already exists`);
      }
      if (err.message.includes("tags.slug")) {
        throw new ConflictError(`Slug "${changes.slug}" is already in use`);
      }
    }
    throw err;
  }

  const updated = await getTag(id);
  if (!updated) throw new Error(`Tag ${id} not found post-update`);

  // CDN: purge any slug that was, or is now, publicly reachable. Covers
  // visibility flips, slug renames, and content edits in one pass.
  if (hasPublicSurface(existing) && existing.slug) purgeTag(existing.slug);
  if (hasPublicSurface(updated) && updated.slug && updated.slug !== existing.slug) {
    purgeTag(updated.slug);
  }

  return updated;
}

// Convenience alias — existing callers that only rename don't need to learn
// the patch API. Delegates to updateTag.
export async function renameTag(id: number, name: string): Promise<Tag> {
  return updateTag(id, { name });
}

// Deletes a tag and, via FK cascade, removes all video_tag associations
// and tag_slug_redirect rows. The affected videos are not touched.
export async function deleteTag(id: number): Promise<void> {
  const existing = await getTag(id);
  await getDb().delete(tags).where(eq(tags.id, id));
  if (existing?.slug && hasPublicSurface(existing)) {
    purgeTag(existing.slug);
  }
}

// Idempotent: attaching the same tag twice is a no-op thanks to the composite
// primary key and onConflictDoNothing. Returns true if a new association was
// created (and a `tag_added` event logged), false if it already existed.
export async function addTagToVideo(videoId: string, tagId: number): Promise<boolean> {
  const tag = await getTag(tagId);
  if (!tag) throw new Error(`Tag ${tagId} not found`);

  const result = await getDb()
    .insert(videoTags)
    .values({ videoId, tagId })
    .onConflictDoNothing()
    .returning();

  if (result.length === 0) return false;
  await logEvent(videoId, "tag_added", { tagId, tagName: tag.name });
  if (tag.slug && hasPublicSurface(tag)) purgeTag(tag.slug);
  return true;
}

// Idempotent: returns false if the tag wasn't attached. Emits `tag_removed`
// only when an association actually existed.
export async function removeTagFromVideo(videoId: string, tagId: number): Promise<boolean> {
  const tag = await getTag(tagId);
  if (!tag) throw new Error(`Tag ${tagId} not found`);

  const result = await getDb()
    .delete(videoTags)
    .where(and(eq(videoTags.videoId, videoId), eq(videoTags.tagId, tagId)))
    .returning();

  if (result.length === 0) return false;
  await logEvent(videoId, "tag_removed", { tagId, tagName: tag.name });
  if (tag.slug && hasPublicSurface(tag)) purgeTag(tag.slug);
  return true;
}

// Returns all tags attached to a video, sorted by name.
export async function getVideoTags(videoId: string): Promise<Tag[]> {
  return getDb()
    .select(getTableColumns(tags))
    .from(videoTags)
    .innerJoin(tags, eq(videoTags.tagId, tags.id))
    .where(eq(videoTags.videoId, videoId))
    .orderBy(tags.name);
}

// Batch lookup: returns a videoId → Tag[] map for the given video IDs.
// Used by the dashboard so we don't N+1 a per-video tag query in the list
// renderer. Tags within each entry are sorted by name.
export async function getTagsForVideos(videoIds: string[]): Promise<Record<string, Tag[]>> {
  const result: Record<string, Tag[]> = {};
  if (videoIds.length === 0) return result;

  const rows = await getDb()
    .select({ videoId: videoTags.videoId, ...getTableColumns(tags) })
    .from(videoTags)
    .innerJoin(tags, eq(videoTags.tagId, tags.id))
    .where(inArray(videoTags.videoId, videoIds))
    .orderBy(tags.name);

  for (const { videoId, ...tag } of rows) {
    const bucket = result[videoId] ?? [];
    bucket.push(tag);
    result[videoId] = bucket;
  }
  return result;
}

// Resolves a slug for viewer-facing tag routes. Checks the current slug
// first, then falls back to tag_slug_redirects. Returns null for unknown
// slugs and private tags — those have no public surface.
export async function resolveTagSlug(
  slug: string,
): Promise<{ tag: Tag; redirected: boolean } | null> {
  const direct = await getTagBySlug(slug);
  if (direct) {
    if (direct.visibility === "private") return null;
    return { tag: direct, redirected: false };
  }

  const redirect = await getDb()
    .select()
    .from(tagSlugRedirects)
    .where(eq(tagSlugRedirects.oldSlug, slug))
    .get();
  if (!redirect) return null;

  const target = await getTag(redirect.tagId);
  if (!target || target.visibility === "private" || !target.slug) return null;
  return { tag: target, redirected: true };
}

// Lists public/unlisted, complete, non-trashed videos attached to a tag.
// Excludes private videos per the public-tag-page contract. Newest first.
export async function getVideosForTag(tagId: number): Promise<Video[]> {
  return getDb()
    .select(getTableColumns(videos))
    .from(videoTags)
    .innerJoin(videos, eq(videoTags.videoId, videos.id))
    .where(
      and(
        eq(videoTags.tagId, tagId),
        eq(videos.status, "complete"),
        isNull(videos.trashedAt),
        // Exclude only private videos — public AND unlisted appear.
        ne(videos.visibility, "private"),
      ),
    )
    .orderBy(desc(videos.completedAt), desc(videos.createdAt));
}
