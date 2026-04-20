import { and, eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { type Tag, tags, videoTags } from "../db/schema";
import { logEvent } from "./events";
import { ConflictError } from "./store";

// Creates a new tag. Tag names are unique case-sensitively (matches the DB
// constraint); callers that want case-insensitive matching should normalise
// upstream. Throws ConflictError if the name already exists.
export async function createTag(name: string): Promise<Tag> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Tag name cannot be empty");

  // Use onConflictDoNothing to avoid the TOCTOU race of check-then-insert.
  // If the name already exists, the insert returns nothing and we throw.
  const [tag] = await getDb()
    .insert(tags)
    .values({ name: trimmed })
    .onConflictDoNothing()
    .returning();
  if (!tag) throw new ConflictError(`Tag "${trimmed}" already exists`);
  return tag;
}

export async function listTags(): Promise<Tag[]> {
  return getDb().select().from(tags).orderBy(tags.name);
}

export async function getTag(id: number): Promise<Tag | undefined> {
  return getDb().select().from(tags).where(eq(tags.id, id)).get();
}

// Renames a tag. Conflicts with another tag's existing name throw ConflictError.
export async function renameTag(id: number, name: string): Promise<Tag> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Tag name cannot be empty");

  const existing = await getTag(id);
  if (!existing) throw new Error(`Tag ${id} not found`);
  if (existing.name === trimmed) return existing;

  try {
    const [updated] = await getDb()
      .update(tags)
      .set({ name: trimmed })
      .where(eq(tags.id, id))
      .returning();
    if (!updated) throw new Error(`Tag ${id} not found`);
    return updated;
  } catch (err) {
    // SQLite UNIQUE constraint violation on tags.name — convert to ConflictError.
    if (err instanceof Error && err.message.includes("UNIQUE constraint failed")) {
      throw new ConflictError(`Tag "${trimmed}" already exists`);
    }
    throw err;
  }
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
      createdAt: tags.createdAt,
    })
    .from(videoTags)
    .innerJoin(tags, eq(videoTags.tagId, tags.id))
    .where(eq(videoTags.videoId, videoId))
    .orderBy(tags.name);
}
