import { and, eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { TAG_COLORS, type Tag, type TagColor, tags, videoTags } from "../db/schema";
import { logEvent } from "./events";
import { ConflictError, ValidationError } from "./store";

function validateColor(color: string): asserts color is TagColor {
  if (!TAG_COLORS.includes(color as TagColor)) {
    throw new ValidationError(
      `Invalid tag color "${color}". Must be one of: ${TAG_COLORS.join(", ")}`,
    );
  }
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

export type TagPatch = {
  name?: string;
  color?: TagColor;
};

// Updates a tag's name and/or color. Name conflicts throw ConflictError.
// renameTag is retained as a convenience alias.
export async function updateTag(id: number, patch: TagPatch): Promise<Tag> {
  const existing = await getTag(id);
  if (!existing) throw new Error(`Tag ${id} not found`);

  const changes: { name?: string; color?: TagColor } = {};

  if (patch.name !== undefined) {
    const trimmed = patch.name.trim();
    if (!trimmed) throw new Error("Tag name cannot be empty");
    if (trimmed !== existing.name) changes.name = trimmed;
  }

  if (patch.color !== undefined) {
    validateColor(patch.color);
    if (patch.color !== existing.color) changes.color = patch.color;
  }

  if (Object.keys(changes).length === 0) return existing;

  try {
    const [updated] = await getDb().update(tags).set(changes).where(eq(tags.id, id)).returning();
    if (!updated) throw new Error(`Tag ${id} not found`);
    return updated;
  } catch (err) {
    // SQLite UNIQUE constraint violation on tags.name — convert to ConflictError.
    if (err instanceof Error && err.message.includes("UNIQUE constraint failed")) {
      throw new ConflictError(`Tag "${changes.name}" already exists`);
    }
    throw err;
  }
}

// Convenience alias — existing callers that only rename don't need to learn
// the patch API. Delegates to updateTag.
export async function renameTag(id: number, name: string): Promise<Tag> {
  return updateTag(id, { name });
}

// Deletes a tag and, via FK cascade, removes all video_tag associations.
// The affected videos are not touched; they simply lose this tag.
export async function deleteTag(id: number): Promise<void> {
  await getDb().delete(tags).where(eq(tags.id, id));
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
  return true;
}

// Returns all tags attached to a video, sorted by name.
export async function getVideoTags(videoId: string): Promise<Tag[]> {
  return getDb()
    .select({
      id: tags.id,
      name: tags.name,
      color: tags.color,
      createdAt: tags.createdAt,
    })
    .from(videoTags)
    .innerJoin(tags, eq(videoTags.tagId, tags.id))
    .where(eq(videoTags.videoId, videoId))
    .orderBy(tags.name);
}
