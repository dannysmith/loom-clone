import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { getDb } from "../../db/client";
import { videoEvents, videos as videosTable } from "../../db/schema";
import { setupTestEnv, type TestEnv, teardownTestEnv } from "../../test-utils";
import {
  addSegment,
  completeVideo,
  createVideo,
  deleteVideo,
  getSegmentDurations,
  getVideo,
  getVideoBySlug,
  setVideoStatus,
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
});
