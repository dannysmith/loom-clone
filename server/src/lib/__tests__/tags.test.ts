import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { getDb } from "../../db/client";
import { videoEvents, videoTags } from "../../db/schema";
import { setupTestEnv, type TestEnv, teardownTestEnv } from "../../test-utils";
import { ConflictError, createVideo, deleteVideo } from "../store";
import {
  addTagToVideo,
  createTag,
  deleteTag,
  getTag,
  getVideoTags,
  listTags,
  removeTagFromVideo,
  renameTag,
} from "../tags";

let env: TestEnv;

beforeEach(async () => {
  env = await setupTestEnv();
});

afterEach(async () => {
  await teardownTestEnv(env);
});

describe("createTag", () => {
  test("creates a tag and returns the record", async () => {
    const tag = await createTag("tutorial");
    expect(tag.id).toBeGreaterThan(0);
    expect(tag.name).toBe("tutorial");
    expect(() => new Date(tag.createdAt)).not.toThrow();
  });

  test("trims whitespace in the name", async () => {
    const tag = await createTag("  tutorial  ");
    expect(tag.name).toBe("tutorial");
  });

  test("rejects empty names", async () => {
    expect(createTag("")).rejects.toThrow();
    expect(createTag("   ")).rejects.toThrow();
  });

  test("rejects duplicates with ConflictError", async () => {
    await createTag("tutorial");
    expect(createTag("tutorial")).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("listTags / getTag", () => {
  test("listTags returns tags sorted by name", async () => {
    await createTag("zulu");
    await createTag("alpha");
    await createTag("mike");
    const list = await listTags();
    expect(list.map((t) => t.name)).toEqual(["alpha", "mike", "zulu"]);
  });

  test("getTag returns the tag or undefined", async () => {
    const tag = await createTag("tutorial");
    expect((await getTag(tag.id))?.name).toBe("tutorial");
    expect(await getTag(99999)).toBeUndefined();
  });
});

describe("renameTag", () => {
  test("updates the name", async () => {
    const tag = await createTag("old");
    const renamed = await renameTag(tag.id, "new");
    expect(renamed.name).toBe("new");
  });

  test("is a no-op when name unchanged", async () => {
    const tag = await createTag("same");
    const result = await renameTag(tag.id, "same");
    expect(result.name).toBe("same");
  });

  test("rejects conflicts with another existing tag name", async () => {
    const tag = await createTag("first");
    await createTag("second");
    expect(renameTag(tag.id, "second")).rejects.toBeInstanceOf(ConflictError);
  });

  test("throws for unknown tag id", async () => {
    expect(renameTag(999, "whatever")).rejects.toThrow();
  });
});

describe("deleteTag", () => {
  test("removes the tag", async () => {
    const tag = await createTag("temp");
    await deleteTag(tag.id);
    expect(await getTag(tag.id)).toBeUndefined();
  });

  test("cascades to video_tags — associations disappear", async () => {
    const video = await createVideo();
    const tag = await createTag("cascade");
    await addTagToVideo(video.id, tag.id);
    expect(await getVideoTags(video.id)).toHaveLength(1);

    await deleteTag(tag.id);
    expect(await getVideoTags(video.id)).toHaveLength(0);
  });
});

describe("addTagToVideo / removeTagFromVideo / getVideoTags", () => {
  test("addTagToVideo creates the association and logs tag_added", async () => {
    const video = await createVideo();
    const tag = await createTag("demo");
    const added = await addTagToVideo(video.id, tag.id);
    expect(added).toBe(true);

    const attached = await getVideoTags(video.id);
    expect(attached.map((t) => t.name)).toEqual(["demo"]);

    const events = await getDb()
      .select()
      .from(videoEvents)
      .where(eq(videoEvents.videoId, video.id));
    const tagEvent = events.find((e) => e.type === "tag_added");
    expect(tagEvent).toBeDefined();
    expect(JSON.parse(tagEvent?.data ?? "{}")).toEqual({ tagId: tag.id, tagName: "demo" });
  });

  test("addTagToVideo is idempotent — second call returns false, no duplicate event", async () => {
    const video = await createVideo();
    const tag = await createTag("demo");
    expect(await addTagToVideo(video.id, tag.id)).toBe(true);
    expect(await addTagToVideo(video.id, tag.id)).toBe(false);

    const events = await getDb()
      .select()
      .from(videoEvents)
      .where(eq(videoEvents.videoId, video.id));
    const addEvents = events.filter((e) => e.type === "tag_added");
    expect(addEvents).toHaveLength(1);
  });

  test("removeTagFromVideo detaches and logs tag_removed", async () => {
    const video = await createVideo();
    const tag = await createTag("demo");
    await addTagToVideo(video.id, tag.id);

    const removed = await removeTagFromVideo(video.id, tag.id);
    expect(removed).toBe(true);
    expect(await getVideoTags(video.id)).toHaveLength(0);

    const events = await getDb()
      .select()
      .from(videoEvents)
      .where(eq(videoEvents.videoId, video.id));
    const removeEvent = events.find((e) => e.type === "tag_removed");
    expect(removeEvent).toBeDefined();
  });

  test("removeTagFromVideo returns false if association didn't exist", async () => {
    const video = await createVideo();
    const tag = await createTag("demo");
    expect(await removeTagFromVideo(video.id, tag.id)).toBe(false);
  });

  test("getVideoTags returns tags sorted by name", async () => {
    const video = await createVideo();
    const zulu = await createTag("zulu");
    const alpha = await createTag("alpha");
    await addTagToVideo(video.id, zulu.id);
    await addTagToVideo(video.id, alpha.id);
    const attached = await getVideoTags(video.id);
    expect(attached.map((t) => t.name)).toEqual(["alpha", "zulu"]);
  });

  test("deleting a video cascades to video_tags", async () => {
    const video = await createVideo();
    const tag = await createTag("demo");
    await addTagToVideo(video.id, tag.id);

    await deleteVideo(video.id);

    const remaining = await getDb().select().from(videoTags).where(eq(videoTags.videoId, video.id));
    expect(remaining).toHaveLength(0);
    // Tag itself is not deleted.
    expect(await getTag(tag.id)).toBeDefined();
  });
});
