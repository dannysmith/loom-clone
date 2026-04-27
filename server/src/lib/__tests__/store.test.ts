import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { getDb } from "../../db/client";
import {
  slugRedirects as slugRedirectsTable,
  videoEvents,
  videos as videosTable,
} from "../../db/schema";
import { setupTestEnv, type TestEnv, teardownTestEnv } from "../../test-utils";
import { listEvents } from "../events";
import {
  addSegment,
  ConflictError,
  completeVideo,
  createVideo,
  deleteVideo,
  duplicateVideo,
  getSegmentDurations,
  getVideo,
  getVideoBySlug,
  listVideos,
  listVideosFiltered,
  RESERVED_SLUGS,
  resolveSlug,
  SLUG_MAX_LENGTH,
  setVideoStatus,
  trashVideo,
  untrashVideo,
  updateSlug,
  updateVideo,
  ValidationError,
  validateSlugFormat,
} from "../store";
import { addTagToVideo, createTag, getVideoTags } from "../tags";

let env: TestEnv;

beforeEach(async () => {
  env = await setupTestEnv();
});

afterEach(async () => {
  await teardownTestEnv(env);
});

describe("createVideo", () => {
  test("returns a record with id, word-based slug, sensible defaults", async () => {
    const video = await createVideo();
    expect(video.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(video.slug).toMatch(/^[a-z]+-[a-z]+-[a-z]+$/);
    expect(video.status).toBe("recording");
    expect(video.visibility).toBe("unlisted");
    expect(video.source).toBe("recorded");
    expect(video.trashedAt).toBeNull();
    expect(video.completedAt).toBeNull();
    expect(() => new Date(video.createdAt)).not.toThrow();
  });

  test("logs a `created` event", async () => {
    const video = await createVideo();
    const events = await getDb()
      .select()
      .from(videoEvents)
      .where(eq(videoEvents.videoId, video.id));
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("created");
  });

  test("consecutive videos get different ids and slugs", async () => {
    const a = await createVideo();
    const b = await createVideo();
    expect(a.id).not.toBe(b.id);
    expect(a.slug).not.toBe(b.slug);
  });
});

describe("getVideo / getVideoBySlug", () => {
  test("finds a created video by id", async () => {
    const video = await createVideo();
    expect(await getVideo(video.id)).toEqual(video);
  });

  test("finds a created video by slug", async () => {
    const video = await createVideo();
    expect(await getVideoBySlug(video.slug)).toEqual(video);
  });

  test("returns undefined for unknown id", async () => {
    expect(await getVideo("nope")).toBeUndefined();
  });

  test("returns undefined for unknown slug", async () => {
    expect(await getVideoBySlug("deadbeef")).toBeUndefined();
  });
});

describe("addSegment", () => {
  test("stores duration and is readable via getSegmentDurations", async () => {
    const video = await createVideo();
    await addSegment(video.id, "seg_000.m4s", 4.0);
    await addSegment(video.id, "seg_001.m4s", 3.5);

    const durations = await getSegmentDurations(video.id);
    expect(durations.get("seg_000.m4s")).toBe(4.0);
    expect(durations.get("seg_001.m4s")).toBe(3.5);
  });

  test("is idempotent — same filename overwrites duration", async () => {
    const video = await createVideo();
    await addSegment(video.id, "seg_000.m4s", 4.0);
    await addSegment(video.id, "seg_000.m4s", 5.0);
    const durations = await getSegmentDurations(video.id);
    expect(durations.get("seg_000.m4s")).toBe(5.0);
  });

  test("throws for unknown video id (FK constraint)", async () => {
    expect(addSegment("nope", "seg_000.m4s", 4.0)).rejects.toThrow("FOREIGN KEY constraint failed");
  });
});

describe("getSegmentDurations", () => {
  test("returns an empty map for unknown id", async () => {
    const durations = await getSegmentDurations("nope");
    expect(durations.size).toBe(0);
  });
});

describe("setVideoStatus / completeVideo", () => {
  test("transitions status and updates updatedAt", async () => {
    const video = await createVideo();
    const updated = await setVideoStatus(video.id, "healing");
    expect(updated.status).toBe("healing");
    expect(updated.updatedAt >= video.updatedAt).toBe(true);
  });

  test("completeVideo sets status to complete, populates completedAt and durationSeconds", async () => {
    const video = await createVideo();
    await addSegment(video.id, "seg_000.m4s", 4.0);
    await addSegment(video.id, "seg_001.m4s", 3.5);

    const updated = await completeVideo(video.id);
    expect(updated.status).toBe("complete");
    expect(updated.completedAt).not.toBeNull();
    expect(updated.durationSeconds).toBeCloseTo(7.5, 5);
  });

  test("completedAt is set-once — re-completing after healing does not overwrite", async () => {
    const video = await createVideo();
    const first = await completeVideo(video.id);
    const firstCompletedAt = first.completedAt;
    expect(firstCompletedAt).not.toBeNull();

    await setVideoStatus(video.id, "healing");
    // Small delay so a bug that overwrote completedAt would produce a different ISO string.
    await new Promise((r) => setTimeout(r, 5));
    const second = await completeVideo(video.id);
    expect(second.completedAt).toBe(firstCompletedAt);
  });

  test("logs `completed` on clean recording→complete", async () => {
    const video = await createVideo();
    await completeVideo(video.id);
    const events = await getDb()
      .select()
      .from(videoEvents)
      .where(eq(videoEvents.videoId, video.id));
    const types = events.map((e) => e.type);
    expect(types).toContain("completed");
    expect(types).not.toContain("healed");
  });

  test("logs `healed` on healing→complete transition", async () => {
    const video = await createVideo();
    await setVideoStatus(video.id, "healing");
    await completeVideo(video.id);
    const events = await getDb()
      .select()
      .from(videoEvents)
      .where(eq(videoEvents.videoId, video.id));
    const types = events.map((e) => e.type);
    expect(types).toContain("healed");
  });

  test("throws for unknown id", async () => {
    expect(setVideoStatus("nope", "complete")).rejects.toThrow("Video nope not found");
  });
});

describe("deleteVideo", () => {
  test("removes video and cascades to segments and events", async () => {
    const video = await createVideo();
    await addSegment(video.id, "seg_000.m4s", 4.0);

    const deleted = await deleteVideo(video.id);
    expect(deleted?.id).toBe(video.id);
    expect(await getVideo(video.id)).toBeUndefined();
    expect(await getVideoBySlug(video.slug)).toBeUndefined();

    // Cascade check: no orphaned segments or events.
    const segs = await getSegmentDurations(video.id);
    expect(segs.size).toBe(0);
    const events = await getDb()
      .select()
      .from(videoEvents)
      .where(eq(videoEvents.videoId, video.id));
    expect(events).toHaveLength(0);
  });

  test("returns undefined for unknown id", async () => {
    expect(await deleteVideo("nope")).toBeUndefined();
  });

  test("slug is freed for reuse after hard delete (FK cascade on slug_redirects)", async () => {
    // Sanity check — we can insert a new video; the deleted video's row is gone so its
    // unique slug constraint no longer reserves that string.
    const video = await createVideo();
    await deleteVideo(video.id);
    // Re-insert a row with the same slug via a direct DB call — would fail if the
    // original row still existed.
    const db = getDb();
    await db
      .insert(videosTable)
      .values({ id: "v2", slug: video.slug, createdAt: "x", updatedAt: "x" });
    expect(await getVideoBySlug(video.slug)).toBeDefined();
  });

  test("hard delete cascades slug_redirects rows for the deleted video", async () => {
    const video = await createVideo();
    const originalSlug = video.slug;
    await updateSlug(video.id, "v1-renamed"); // creates a redirect row
    await updateSlug(video.id, "v1-final"); // another redirect row

    // Two redirect rows should exist for this video.
    const before = await getDb()
      .select()
      .from(slugRedirectsTable)
      .where(eq(slugRedirectsTable.videoId, video.id));
    expect(before).toHaveLength(2);

    await deleteVideo(video.id);

    // After cascade, no redirects remain — and the freed slugs can be reused.
    const after = await getDb()
      .select()
      .from(slugRedirectsTable)
      .where(eq(slugRedirectsTable.videoId, video.id));
    expect(after).toHaveLength(0);

    // Resolving either freed slug returns null (no dangling redirect to nowhere).
    expect(await resolveSlug(originalSlug)).toBeNull();
    expect(await resolveSlug("v1-renamed")).toBeNull();
  });
});

describe("updateSlug / resolveSlug", () => {
  test("no-op when new slug equals current", async () => {
    const video = await createVideo();
    const result = await updateSlug(video.id, video.slug);
    expect(result.slug).toBe(video.slug);
  });

  test("updates slug and old slug becomes a redirect", async () => {
    const video = await createVideo();
    const oldSlug = video.slug;
    const updated = await updateSlug(video.id, "welcome-to-the-team");
    expect(updated.slug).toBe("welcome-to-the-team");

    // Old slug resolves as a redirect
    const resolved = await resolveSlug(oldSlug);
    expect(resolved?.redirected).toBe(true);
    expect(resolved?.video.id).toBe(video.id);

    // New slug resolves direct
    const direct = await resolveSlug("welcome-to-the-team");
    expect(direct?.redirected).toBe(false);
    expect(direct?.video.id).toBe(video.id);
  });

  test("logs slug_changed event with from/to", async () => {
    const video = await createVideo();
    const oldSlug = video.slug;
    await updateSlug(video.id, "readable-slug");

    const events = await getDb()
      .select()
      .from(videoEvents)
      .where(eq(videoEvents.videoId, video.id));
    const slugEvent = events.find((e) => e.type === "slug_changed");
    expect(slugEvent).toBeDefined();
    const data = JSON.parse(slugEvent?.data ?? "{}");
    expect(data).toEqual({ from: oldSlug, to: "readable-slug" });
  });

  test("rejects ConflictError if new slug is another video's current slug", async () => {
    const a = await createVideo();
    const b = await createVideo();
    expect(updateSlug(a.id, b.slug)).rejects.toBeInstanceOf(ConflictError);
  });

  test("rejects ConflictError if new slug is already a redirect", async () => {
    const video = await createVideo();
    const originalSlug = video.slug;
    await updateSlug(video.id, "first-slug"); // originalSlug now a redirect
    const other = await createVideo();
    expect(updateSlug(other.id, originalSlug)).rejects.toBeInstanceOf(ConflictError);
  });

  test("redirect chain — multiple renames, all old slugs still resolve", async () => {
    const video = await createVideo();
    const first = video.slug;
    await updateSlug(video.id, "second");
    await updateSlug(video.id, "third");

    expect((await resolveSlug(first))?.video.id).toBe(video.id);
    expect((await resolveSlug("second"))?.video.id).toBe(video.id);
    expect((await resolveSlug("third"))?.video.id).toBe(video.id);
    expect((await resolveSlug("third"))?.redirected).toBe(false);
    expect((await resolveSlug(first))?.redirected).toBe(true);
  });

  test("resolveSlug returns null for unknown slug", async () => {
    expect(await resolveSlug("does-not-exist")).toBeNull();
  });

  test("resolveSlug returns null for private video on current slug", async () => {
    const video = await createVideo();
    await updateVideo(video.id, { visibility: "private" });
    expect(await resolveSlug(video.slug)).toBeNull();
  });

  test("resolveSlug returns null for private video on redirect slug", async () => {
    const video = await createVideo();
    const oldSlug = video.slug;
    await updateSlug(video.id, "renamed-private");
    await updateVideo(video.id, { visibility: "private" });
    expect(await resolveSlug(oldSlug)).toBeNull();
  });

  test("resolveSlug returns unlisted videos (they're accessible by URL)", async () => {
    const video = await createVideo();
    // Default visibility is "unlisted"
    const resolved = await resolveSlug(video.slug);
    expect(resolved).not.toBeNull();
    expect(resolved?.video.id).toBe(video.id);
  });

  test("rejects ValidationError if new slug fails format validation", async () => {
    const video = await createVideo();
    expect(updateSlug(video.id, "BadCASE")).rejects.toBeInstanceOf(ValidationError);
    expect(updateSlug(video.id, "with.dot")).rejects.toBeInstanceOf(ValidationError);
    expect(updateSlug(video.id, "trailing-")).rejects.toBeInstanceOf(ValidationError);
  });

  test("rejects ValidationError if new slug is reserved", async () => {
    const video = await createVideo();
    expect(updateSlug(video.id, "admin")).rejects.toBeInstanceOf(ValidationError);
    expect(updateSlug(video.id, "api")).rejects.toBeInstanceOf(ValidationError);
    expect(updateSlug(video.id, "favicon")).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("validateSlugFormat", () => {
  test("accepts well-formed slugs", () => {
    const ok = ["a", "a1", "abc", "abc-def", "a-b-c-1-2-3", "welcome-to-the-team", "deadbeef"];
    for (const slug of ok) {
      expect(() => validateSlugFormat(slug)).not.toThrow();
    }
  });

  test("rejects empty, too-long, or wrong-shape slugs", () => {
    const bad = [
      "", // empty
      "A", // uppercase
      "ABC", // uppercase
      "a_b", // underscore
      "a b", // space
      "a.b", // dot
      "a/b", // slash
      "-leading", // leading dash
      "trailing-", // trailing dash
      "double--dash", // consecutive dashes
      "a".repeat(SLUG_MAX_LENGTH + 1), // too long
    ];
    for (const slug of bad) {
      expect(() => validateSlugFormat(slug)).toThrow(ValidationError);
    }
  });

  test("rejects every reserved word", () => {
    for (const slug of RESERVED_SLUGS) {
      expect(() => validateSlugFormat(slug)).toThrow(ValidationError);
    }
  });
});

describe("updateVideo", () => {
  test("updates title and logs title_changed", async () => {
    const video = await createVideo();
    const updated = await updateVideo(video.id, { title: "My Tutorial" });
    expect(updated.title).toBe("My Tutorial");

    const events = await getDb()
      .select()
      .from(videoEvents)
      .where(eq(videoEvents.videoId, video.id));
    const event = events.find((e) => e.type === "title_changed");
    expect(event).toBeDefined();
    expect(JSON.parse(event?.data ?? "{}")).toEqual({ from: null, to: "My Tutorial" });
  });

  test("updates visibility and logs visibility_changed", async () => {
    const video = await createVideo();
    const updated = await updateVideo(video.id, { visibility: "public" });
    expect(updated.visibility).toBe("public");

    const events = await getDb()
      .select()
      .from(videoEvents)
      .where(eq(videoEvents.videoId, video.id));
    const event = events.find((e) => e.type === "visibility_changed");
    expect(JSON.parse(event?.data ?? "{}")).toEqual({ from: "unlisted", to: "public" });
  });

  test("updating multiple fields emits one event per changed field", async () => {
    const video = await createVideo();
    await updateVideo(video.id, {
      title: "T",
      description: "D",
      visibility: "public",
    });
    const events = await getDb()
      .select()
      .from(videoEvents)
      .where(eq(videoEvents.videoId, video.id));
    const types = events.map((e) => e.type);
    expect(types).toContain("title_changed");
    expect(types).toContain("description_changed");
    expect(types).toContain("visibility_changed");
  });

  test("no-op when value unchanged — no event, no updatedAt churn", async () => {
    const video = await createVideo();
    await updateVideo(video.id, { title: "Hello" });
    const afterFirst = await getVideo(video.id);
    expect(afterFirst).toBeDefined();

    await new Promise((r) => setTimeout(r, 5));
    const result = await updateVideo(video.id, { title: "Hello" });
    expect(result.updatedAt).toBe(afterFirst!.updatedAt);

    const events = await getDb()
      .select()
      .from(videoEvents)
      .where(eq(videoEvents.videoId, video.id));
    const titleEvents = events.filter((e) => e.type === "title_changed");
    expect(titleEvents).toHaveLength(1); // only the first call produced an event
  });
});

describe("trashVideo", () => {
  test("sets trashedAt and logs `trashed` event", async () => {
    const video = await createVideo();
    const trashed = await trashVideo(video.id);
    expect(trashed.trashedAt).not.toBeNull();

    const events = await getDb()
      .select()
      .from(videoEvents)
      .where(eq(videoEvents.videoId, video.id));
    expect(events.map((e) => e.type)).toContain("trashed");
  });

  test("no-op when already trashed", async () => {
    const video = await createVideo();
    const first = await trashVideo(video.id);
    await new Promise((r) => setTimeout(r, 5));
    const second = await trashVideo(video.id);
    expect(second.trashedAt).toBe(first.trashedAt);
  });

  test("public lookups exclude trashed videos by default", async () => {
    const video = await createVideo();
    await trashVideo(video.id);

    expect(await getVideo(video.id)).toBeUndefined();
    expect(await getVideoBySlug(video.slug)).toBeUndefined();
    expect(await resolveSlug(video.slug)).toBeNull();
  });

  test("includeTrashed opt-in surfaces trashed videos", async () => {
    const video = await createVideo();
    await trashVideo(video.id);

    expect((await getVideo(video.id, { includeTrashed: true }))?.id).toBe(video.id);
    expect((await getVideoBySlug(video.slug, { includeTrashed: true }))?.id).toBe(video.id);
    expect((await resolveSlug(video.slug, { includeTrashed: true }))?.video.id).toBe(video.id);
  });
});

describe("listVideos", () => {
  test("returns newest-first, excludes trashed by default", async () => {
    const a = await createVideo();
    await new Promise((r) => setTimeout(r, 5));
    const b = await createVideo();
    await new Promise((r) => setTimeout(r, 5));
    const c = await createVideo();
    await trashVideo(b.id);

    const list = await listVideos();
    expect(list.map((v) => v.id)).toEqual([c.id, a.id]);
  });

  test("includeTrashed returns everything", async () => {
    const a = await createVideo();
    const b = await createVideo();
    await trashVideo(a.id);

    const list = await listVideos({ includeTrashed: true });
    expect(list.map((v) => v.id).sort()).toEqual([a.id, b.id].sort());
  });
});

// Small delay helper to ensure distinct timestamps for ordering tests.
const tick = () => new Promise((r) => setTimeout(r, 5));

describe("untrashVideo", () => {
  test("clears trashedAt and logs event", async () => {
    const v = await createVideo();
    await trashVideo(v.id);
    const restored = await untrashVideo(v.id);
    expect(restored.trashedAt).toBeNull();

    const events = await listEvents(v.id);
    expect(events.some((e) => e.type === "untrashed")).toBe(true);
  });

  test("is a no-op if not trashed", async () => {
    const v = await createVideo();
    const result = await untrashVideo(v.id);
    expect(result.id).toBe(v.id);

    const events = await listEvents(v.id);
    expect(events.filter((e) => e.type === "untrashed")).toHaveLength(0);
  });

  test("restored video appears in default queries again", async () => {
    const v = await createVideo();
    await trashVideo(v.id);
    expect(await getVideo(v.id)).toBeUndefined();

    await untrashVideo(v.id);
    expect((await getVideo(v.id))?.id).toBe(v.id);
  });
});

describe("duplicateVideo", () => {
  test("creates a new video with different id and slug", async () => {
    const original = await createVideo();
    await updateVideo(original.id, { title: "Original", visibility: "public" });

    const dup = await duplicateVideo(original.id);
    expect(dup.id).not.toBe(original.id);
    expect(dup.slug).not.toBe(original.slug);
    expect(dup.slug).toContain(original.slug); // slug-1 pattern
  });

  test("appends (1) to title, increments existing suffix", async () => {
    const v = await createVideo();
    await updateVideo(v.id, { title: "My Video" });

    const d1 = await duplicateVideo(v.id);
    expect(d1.title).toBe("My Video (1)");

    const d2 = await duplicateVideo(d1.id);
    expect(d2.title).toBe("My Video (2)");
  });

  test("preserves null title", async () => {
    const v = await createVideo();
    const dup = await duplicateVideo(v.id);
    expect(dup.title).toBeNull();
  });

  test("preserves visibility, description, and source", async () => {
    const v = await createVideo();
    await updateVideo(v.id, {
      title: "Test",
      description: "A description",
      visibility: "private",
    });

    const dup = await duplicateVideo(v.id);
    expect(dup.visibility).toBe("private");
    expect(dup.description).toBe("A description");
    expect(dup.source).toBe("recorded");
  });

  test("preserves tag associations", async () => {
    const v = await createVideo();
    const tag1 = await createTag("demo", "blue");
    const tag2 = await createTag("tutorial", "green");
    await addTagToVideo(v.id, tag1.id);
    await addTagToVideo(v.id, tag2.id);

    const dup = await duplicateVideo(v.id);
    const dupTags = await getVideoTags(dup.id);
    expect(dupTags.map((t) => t.name).sort()).toEqual(["demo", "tutorial"]);
  });

  test("logs events on both original and duplicate", async () => {
    const v = await createVideo();
    await updateVideo(v.id, { title: "Original" });

    const dup = await duplicateVideo(v.id);

    const origEvents = await listEvents(v.id);
    expect(origEvents.some((e) => e.type === "duplicated")).toBe(true);

    const dupEvents = await listEvents(dup.id);
    expect(dupEvents.some((e) => e.type === "duplicated_from")).toBe(true);
    // Duplicate should NOT inherit original's event log
    expect(dupEvents.filter((e) => e.type === "created")).toHaveLength(0);
  });

  test("does not create slug redirects for the duplicate", async () => {
    const v = await createVideo();
    const dup = await duplicateVideo(v.id);

    const db = getDb();
    const redirects = await db
      .select()
      .from(slugRedirectsTable)
      .where(eq(slugRedirectsTable.videoId, dup.id));
    expect(redirects).toHaveLength(0);
  });
});

describe("listVideosFiltered", () => {
  test("excludes trashed videos by default", async () => {
    const a = await createVideo();
    const b = await createVideo();
    await trashVideo(a.id);

    const result = await listVideosFiltered();
    expect(result.items.map((v) => v.id)).toEqual([b.id]);
  });

  test("trashedOnly returns only trashed videos", async () => {
    const a = await createVideo();
    await createVideo(); // untrashed video, should be excluded
    await trashVideo(a.id);

    const result = await listVideosFiltered({ trashedOnly: true });
    expect(result.items.map((v) => v.id)).toEqual([a.id]);
  });

  test("filters by visibility", async () => {
    const pub = await createVideo();
    await updateVideo(pub.id, { visibility: "public" });
    const priv = await createVideo();
    await updateVideo(priv.id, { visibility: "private" });

    const result = await listVideosFiltered({ visibility: "public" });
    expect(result.items.map((v) => v.id)).toContain(pub.id);
    expect(result.items.map((v) => v.id)).not.toContain(priv.id);
  });

  test("filters by status", async () => {
    const a = await createVideo();
    await tick();
    const b = await createVideo();
    await completeVideo(b.id);

    const result = await listVideosFiltered({ status: "recording" });
    expect(result.items.map((v) => v.id)).toContain(a.id);
    expect(result.items.map((v) => v.id)).not.toContain(b.id);
  });

  test("filters by tag", async () => {
    const tagged = await createVideo();
    const untagged = await createVideo();
    const tag = await createTag("test-tag");
    await addTagToVideo(tagged.id, tag.id);

    const result = await listVideosFiltered({ tagId: tag.id });
    expect(result.items.map((v) => v.id)).toContain(tagged.id);
    expect(result.items.map((v) => v.id)).not.toContain(untagged.id);
  });

  test("FTS search filters results", async () => {
    const v1 = await createVideo();
    await updateVideo(v1.id, { title: "Alpha Video" });
    const v2 = await createVideo();
    await updateVideo(v2.id, { title: "Beta Video" });

    const result = await listVideosFiltered({ search: "alpha" });
    expect(result.items.map((v) => v.id)).toContain(v1.id);
    expect(result.items.map((v) => v.id)).not.toContain(v2.id);
  });

  test("search with no matches returns empty", async () => {
    await createVideo();
    const result = await listVideosFiltered({ search: "nonexistent" });
    expect(result.items).toHaveLength(0);
  });

  test("sorts by date descending (default)", async () => {
    const a = await createVideo();
    await tick();
    const b = await createVideo();
    await tick();
    const c = await createVideo();

    const result = await listVideosFiltered();
    expect(result.items.map((v) => v.id)).toEqual([c.id, b.id, a.id]);
  });

  test("sorts by date ascending", async () => {
    const a = await createVideo();
    await tick();
    const b = await createVideo();
    await tick();
    const c = await createVideo();

    const result = await listVideosFiltered({ sort: "date-asc" });
    expect(result.items.map((v) => v.id)).toEqual([a.id, b.id, c.id]);
  });

  test("sorts by title ascending", async () => {
    const c = await createVideo();
    await updateVideo(c.id, { title: "Charlie" });
    const a = await createVideo();
    await updateVideo(a.id, { title: "Alpha" });
    const b = await createVideo();
    await updateVideo(b.id, { title: "Bravo" });

    const result = await listVideosFiltered({ sort: "title-asc" });
    expect(result.items.map((v) => v.title)).toEqual(["Alpha", "Bravo", "Charlie"]);
  });

  test("cursor pagination returns next page", async () => {
    await createVideo();
    await tick();
    await createVideo();
    await tick();
    await createVideo();

    const page1 = await listVideosFiltered({ limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await listVideosFiltered({ limit: 2, cursor: page1.nextCursor! });
    expect(page2.items).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();

    // All three videos appear across both pages, no duplicates
    const allIds = [...page1.items, ...page2.items].map((v) => v.id);
    expect(new Set(allIds).size).toBe(3);
  });

  test("multiple filters combine (AND logic)", async () => {
    const v1 = await createVideo();
    await updateVideo(v1.id, { title: "Public Recording", visibility: "public" });

    const v2 = await createVideo();
    await updateVideo(v2.id, { title: "Private Recording", visibility: "private" });

    const v3 = await createVideo();
    await updateVideo(v3.id, { title: "Public Other", visibility: "public" });
    await completeVideo(v3.id);

    // Filter: public + recording status
    const result = await listVideosFiltered({ visibility: "public", status: "recording" });
    expect(result.items.map((v) => v.id)).toEqual([v1.id]);
  });
});
