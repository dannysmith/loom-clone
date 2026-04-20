import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { getDb } from "../../db/client";
import {
  slugRedirects as slugRedirectsTable,
  videoEvents,
  videos as videosTable,
} from "../../db/schema";
import { setupTestEnv, type TestEnv, teardownTestEnv } from "../../test-utils";
import {
  addSegment,
  ConflictError,
  completeVideo,
  createVideo,
  deleteVideo,
  ValidationError,
  getSegmentDurations,
  getVideo,
  getVideoBySlug,
  listVideos,
  RESERVED_SLUGS,
  resolveSlug,
  SLUG_MAX_LENGTH,
  setVideoStatus,
  trashVideo,
  updateSlug,
  updateVideo,
  validateSlugFormat,
} from "../store";

let env: TestEnv;

beforeEach(async () => {
  env = await setupTestEnv();
});

afterEach(async () => {
  await teardownTestEnv(env);
});

describe("createVideo", () => {
  test("returns a record with id, 8-char hex slug, sensible defaults", async () => {
    const video = await createVideo();
    expect(video.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(video.slug).toMatch(/^[0-9a-f]{8}$/);
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

  test("throws for unknown video id", async () => {
    expect(addSegment("nope", "seg_000.m4s", 4.0)).rejects.toThrow("Video nope not found");
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
