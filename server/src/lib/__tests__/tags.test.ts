import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { getDb } from "../../db/client";
import { tagSlugRedirects, videoEvents, videoTags } from "../../db/schema";
import { setupTestEnv, type TestEnv, teardownTestEnv } from "../../test-utils";
import {
  ConflictError,
  checkSlugAvailable,
  completeVideo,
  createVideo,
  deleteVideo,
  updateSlug,
  updateVideo,
  ValidationError,
} from "../store";
import {
  addTagToVideo,
  createTag,
  deleteTag,
  getTag,
  getTagsForVideos,
  getVideosForTag,
  getVideoTags,
  listTags,
  removeTagFromVideo,
  renameTag,
  resolveTagSlug,
  updateTag,
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
    expect(tag.color).toBe("gray");
    expect(() => new Date(tag.createdAt)).not.toThrow();
  });

  test("accepts an explicit color", async () => {
    const tag = await createTag("important", "red");
    expect(tag.name).toBe("important");
    expect(tag.color).toBe("red");
  });

  test("defaults color to gray when omitted", async () => {
    const tag = await createTag("plain");
    expect(tag.color).toBe("gray");
  });

  test("rejects invalid color", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: testing invalid input
    expect(createTag("bad", "neon" as any)).rejects.toThrow("Invalid tag color");
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

describe("updateTag", () => {
  test("updates color only", async () => {
    const tag = await createTag("demo");
    const updated = await updateTag(tag.id, { color: "blue" });
    expect(updated.name).toBe("demo");
    expect(updated.color).toBe("blue");
  });

  test("updates name and color together", async () => {
    const tag = await createTag("demo");
    const updated = await updateTag(tag.id, { name: "renamed", color: "purple" });
    expect(updated.name).toBe("renamed");
    expect(updated.color).toBe("purple");
  });

  test("is a no-op when nothing changed", async () => {
    const tag = await createTag("same", "red");
    const result = await updateTag(tag.id, { name: "same", color: "red" });
    expect(result.name).toBe("same");
    expect(result.color).toBe("red");
  });

  test("rejects invalid color", async () => {
    const tag = await createTag("demo");
    // biome-ignore lint/suspicious/noExplicitAny: testing invalid input
    expect(updateTag(tag.id, { color: "neon" as any })).rejects.toThrow("Invalid tag color");
  });

  test("rejects name conflict", async () => {
    await createTag("first");
    const second = await createTag("second");
    expect(updateTag(second.id, { name: "first" })).rejects.toBeInstanceOf(ConflictError);
  });

  test("throws for unknown tag id", async () => {
    expect(updateTag(999, { color: "red" })).rejects.toThrow();
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

  test("getVideoTags returns tags sorted by name with color", async () => {
    const video = await createVideo();
    const zulu = await createTag("zulu", "red");
    const alpha = await createTag("alpha", "blue");
    await addTagToVideo(video.id, zulu.id);
    await addTagToVideo(video.id, alpha.id);
    const attached = await getVideoTags(video.id);
    expect(attached.map((t) => t.name)).toEqual(["alpha", "zulu"]);
    expect(attached.map((t) => t.color)).toEqual(["blue", "red"]);
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

describe("tag visibility / slug / description", () => {
  test("new tags default to private with no slug", async () => {
    const tag = await createTag("demo");
    expect(tag.visibility).toBe("private");
    expect(tag.slug).toBeNull();
    expect(tag.description).toBeNull();
  });

  test("public/unlisted tags require a slug", async () => {
    const tag = await createTag("demo");
    expect(updateTag(tag.id, { visibility: "public" })).rejects.toBeInstanceOf(ValidationError);
    expect(updateTag(tag.id, { visibility: "unlisted" })).rejects.toBeInstanceOf(ValidationError);
  });

  test("can set slug + visibility together", async () => {
    const tag = await createTag("demo");
    const updated = await updateTag(tag.id, { visibility: "public", slug: "demo-tag" });
    expect(updated.visibility).toBe("public");
    expect(updated.slug).toBe("demo-tag");
  });

  test("clearing slug while public throws", async () => {
    const tag = await createTag("demo");
    await updateTag(tag.id, { visibility: "public", slug: "demo" });
    expect(updateTag(tag.id, { slug: null })).rejects.toBeInstanceOf(ValidationError);
  });

  test("can go back to private without clearing slug", async () => {
    const tag = await createTag("demo");
    await updateTag(tag.id, { visibility: "public", slug: "demo" });
    const updated = await updateTag(tag.id, { visibility: "private" });
    expect(updated.visibility).toBe("private");
    expect(updated.slug).toBe("demo"); // slug preserved
  });

  test("description is trimmed and nullified when empty", async () => {
    const tag = await createTag("demo");
    const updated = await updateTag(tag.id, { description: "  hello world  " });
    expect(updated.description).toBe("hello world");
    const cleared = await updateTag(tag.id, { description: "   " });
    expect(cleared.description).toBeNull();
  });

  test("videoSort defaults to date-desc and accepts the three valid options", async () => {
    const tag = await createTag("demo");
    expect(tag.videoSort).toBe("date-desc");

    const a = await updateTag(tag.id, { videoSort: "date-asc" });
    expect(a.videoSort).toBe("date-asc");

    const b = await updateTag(tag.id, { videoSort: "alpha" });
    expect(b.videoSort).toBe("alpha");

    // biome-ignore lint/suspicious/noExplicitAny: testing invalid input
    expect(updateTag(tag.id, { videoSort: "random" as any })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  test("invalid slug format rejected", async () => {
    const tag = await createTag("demo");
    expect(updateTag(tag.id, { visibility: "public", slug: "Bad Slug!" })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  test("reserved slug rejected", async () => {
    const tag = await createTag("demo");
    expect(updateTag(tag.id, { visibility: "public", slug: "admin" })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});

describe("slug namespace uniqueness (videos vs tags)", () => {
  test("a tag slug can't collide with a video slug", async () => {
    const video = await createVideo();
    const tag = await createTag("demo");
    expect(updateTag(tag.id, { visibility: "public", slug: video.slug })).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  test("a video slug can't collide with a tag slug", async () => {
    const tag = await createTag("demo");
    await updateTag(tag.id, { visibility: "public", slug: "shared" });
    const video = await createVideo();
    expect(updateSlug(video.id, "shared")).rejects.toBeInstanceOf(ConflictError);
  });

  test("a tag slug can't collide with a video slug redirect", async () => {
    const video = await createVideo();
    const oldSlug = video.slug;
    await updateSlug(video.id, "renamed");
    // oldSlug now lives in slug_redirects
    const tag = await createTag("demo");
    expect(updateTag(tag.id, { visibility: "public", slug: oldSlug })).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  test("a video slug can't collide with a tag slug redirect", async () => {
    const tag = await createTag("demo");
    await updateTag(tag.id, { visibility: "public", slug: "old" });
    await updateTag(tag.id, { slug: "new" });
    // 'old' now lives in tag_slug_redirects
    const video = await createVideo();
    expect(updateSlug(video.id, "old")).rejects.toBeInstanceOf(ConflictError);
  });

  test("checkSlugAvailable accepts a slug nobody owns", () => {
    expect(() => checkSlugAvailable("brand-new-slug")).not.toThrow();
  });
});

describe("tag slug rename and redirect", () => {
  test("renaming a tag's slug creates a redirect entry", async () => {
    const tag = await createTag("demo");
    await updateTag(tag.id, { visibility: "public", slug: "old-slug" });
    await updateTag(tag.id, { slug: "new-slug" });

    const redirect = await getDb()
      .select()
      .from(tagSlugRedirects)
      .where(eq(tagSlugRedirects.oldSlug, "old-slug"))
      .get();
    expect(redirect).toBeDefined();
    expect(redirect?.tagId).toBe(tag.id);
  });

  test("resolveTagSlug follows redirects with redirected=true", async () => {
    const tag = await createTag("demo");
    await updateTag(tag.id, { visibility: "public", slug: "old" });
    await updateTag(tag.id, { slug: "new" });

    const direct = await resolveTagSlug("new");
    expect(direct?.redirected).toBe(false);
    expect(direct?.tag.slug).toBe("new");

    const viaRedirect = await resolveTagSlug("old");
    expect(viaRedirect?.redirected).toBe(true);
    expect(viaRedirect?.tag.slug).toBe("new");
  });

  test("resolveTagSlug returns null for private tags", async () => {
    const tag = await createTag("demo");
    // Private tag with a slug (set via flipping to public then back).
    await updateTag(tag.id, { visibility: "public", slug: "demo" });
    await updateTag(tag.id, { visibility: "private" });
    expect(await resolveTagSlug("demo")).toBeNull();
  });

  test("resolveTagSlug returns null for unknown slugs", async () => {
    expect(await resolveTagSlug("nonexistent")).toBeNull();
  });

  test("reclaiming an old slug deletes the matching redirect row", async () => {
    const tag = await createTag("demo");
    await updateTag(tag.id, { visibility: "public", slug: "a" });
    await updateTag(tag.id, { slug: "b" });
    // Now 'a' is a redirect → tag
    await updateTag(tag.id, { slug: "a" });
    // The 'a' redirect should be gone (otherwise checkSlugAvailable would
    // have rejected the rename back to 'a').
    const remaining = await getDb()
      .select()
      .from(tagSlugRedirects)
      .where(eq(tagSlugRedirects.oldSlug, "a"))
      .get();
    expect(remaining).toBeUndefined();
  });
});

describe("getVideosForTag", () => {
  async function makeCompleteVideo(visibility: "public" | "unlisted" | "private" = "public") {
    const v = await createVideo();
    await updateVideo(v.id, { visibility });
    await completeVideo(v.id);
    return v;
  }

  test("returns public + unlisted videos, excludes private", async () => {
    const tag = await createTag("demo");
    const pub = await makeCompleteVideo("public");
    const unl = await makeCompleteVideo("unlisted");
    const priv = await makeCompleteVideo("private");
    await addTagToVideo(pub.id, tag.id);
    await addTagToVideo(unl.id, tag.id);
    await addTagToVideo(priv.id, tag.id);

    const videos = await getVideosForTag(tag.id);
    const ids = videos.map((v) => v.id);
    expect(ids).toContain(pub.id);
    expect(ids).toContain(unl.id);
    expect(ids).not.toContain(priv.id);
  });

  test("excludes incomplete videos", async () => {
    const tag = await createTag("demo");
    const video = await createVideo(); // status: recording
    await updateVideo(video.id, { visibility: "public" });
    await addTagToVideo(video.id, tag.id);

    expect(await getVideosForTag(tag.id)).toHaveLength(0);
  });

  test("date-desc puts newest completedAt first", async () => {
    const tag = await createTag("demo");
    const a = await makeCompleteVideo("public");
    const b = await makeCompleteVideo("public");
    const c = await makeCompleteVideo("public");
    await addTagToVideo(a.id, tag.id);
    await addTagToVideo(b.id, tag.id);
    await addTagToVideo(c.id, tag.id);

    const sorted = await getVideosForTag(tag.id, "date-desc");
    expect(sorted.map((v) => v.id)).toEqual([c.id, b.id, a.id]);
  });

  test("date-asc puts oldest completedAt first", async () => {
    const tag = await createTag("demo");
    const a = await makeCompleteVideo("public");
    const b = await makeCompleteVideo("public");
    const c = await makeCompleteVideo("public");
    await addTagToVideo(a.id, tag.id);
    await addTagToVideo(b.id, tag.id);
    await addTagToVideo(c.id, tag.id);

    const sorted = await getVideosForTag(tag.id, "date-asc");
    expect(sorted.map((v) => v.id)).toEqual([a.id, b.id, c.id]);
  });

  test("alpha sorts by title (case-insensitive), falling back to slug", async () => {
    const tag = await createTag("demo");
    const titled = await makeCompleteVideo("public");
    const otherTitled = await makeCompleteVideo("public");
    const untitled = await makeCompleteVideo("public");
    await updateVideo(titled.id, { title: "zebra" });
    await updateVideo(otherTitled.id, { title: "Apple" });
    // untitled keeps its random slug. Force a known slug so we can predict order.
    const { updateSlug } = await import("../store");
    await updateSlug(untitled.id, "kangaroo");

    await addTagToVideo(titled.id, tag.id);
    await addTagToVideo(otherTitled.id, tag.id);
    await addTagToVideo(untitled.id, tag.id);

    const sorted = await getVideosForTag(tag.id, "alpha");
    // "Apple" → "apple", slug "kangaroo", title "zebra"
    expect(sorted.map((v) => v.id)).toEqual([otherTitled.id, untitled.id, titled.id]);
  });
});

describe("getTagsForVideos", () => {
  test("returns an empty map for an empty input", async () => {
    expect(await getTagsForVideos([])).toEqual({});
  });

  test("returns tags grouped by video, sorted by name within each entry", async () => {
    const a = await createVideo();
    const b = await createVideo();
    const c = await createVideo(); // no tags
    const zulu = await createTag("zulu");
    const alpha = await createTag("alpha");
    const mike = await createTag("mike");

    await addTagToVideo(a.id, zulu.id);
    await addTagToVideo(a.id, alpha.id);
    await addTagToVideo(b.id, mike.id);

    const map = await getTagsForVideos([a.id, b.id, c.id]);
    expect(map[a.id]?.map((t) => t.name)).toEqual(["alpha", "zulu"]);
    expect(map[b.id]?.map((t) => t.name)).toEqual(["mike"]);
    expect(map[c.id]).toBeUndefined();
  });
});
