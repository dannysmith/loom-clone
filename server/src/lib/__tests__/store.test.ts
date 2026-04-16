import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "path";
import { setupTestEnv, type TestEnv, teardownTestEnv } from "../../test-utils";
import {
  addSegment,
  completeVideo,
  createVideo,
  DATA_DIR,
  deleteVideo,
  getSegmentDurations,
  getVideo,
  getVideoBySlug,
  loadAllVideos,
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
  test("returns a record with id, 8-char hex slug, recording status, createdAt", async () => {
    const video = await createVideo();
    expect(video.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(video.slug).toMatch(/^[0-9a-f]{8}$/);
    expect(video.status).toBe("recording");
    expect(() => new Date(video.createdAt)).not.toThrow();
  });

  test("writes video.json to disk", async () => {
    const video = await createVideo();
    const file = Bun.file(join(DATA_DIR, video.id, "video.json"));
    expect(await file.exists()).toBe(true);
    const onDisk = await file.json();
    expect(onDisk).toEqual(video);
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
    expect(getVideo(video.id)).toEqual(video);
  });

  test("finds a created video by slug", async () => {
    const video = await createVideo();
    expect(getVideoBySlug(video.slug)).toEqual(video);
  });

  test("returns undefined for unknown id", () => {
    expect(getVideo("nope")).toBeUndefined();
  });

  test("returns undefined for unknown slug", () => {
    expect(getVideoBySlug("deadbeef")).toBeUndefined();
  });
});

describe("addSegment", () => {
  test("stores duration and persists segments.json", async () => {
    const video = await createVideo();
    await addSegment(video.id, "seg_000.m4s", 4.0);
    await addSegment(video.id, "seg_001.m4s", 3.5);

    const durations = getSegmentDurations(video.id);
    expect(durations.get("seg_000.m4s")).toBe(4.0);
    expect(durations.get("seg_001.m4s")).toBe(3.5);

    const sidecar = await Bun.file(join(DATA_DIR, video.id, "segments.json")).json();
    expect(sidecar).toEqual({ "seg_000.m4s": 4.0, "seg_001.m4s": 3.5 });
  });

  test("is idempotent — same filename overwrites duration", async () => {
    const video = await createVideo();
    await addSegment(video.id, "seg_000.m4s", 4.0);
    await addSegment(video.id, "seg_000.m4s", 5.0);
    expect(getSegmentDurations(video.id).get("seg_000.m4s")).toBe(5.0);
  });

  test("throws for unknown video id", async () => {
    expect(addSegment("nope", "seg_000.m4s", 4.0)).rejects.toThrow("Video nope not found");
  });
});

describe("getSegmentDurations", () => {
  test("returns an empty map for unknown id", () => {
    const durations = getSegmentDurations("nope");
    expect(durations.size).toBe(0);
  });
});

describe("setVideoStatus / completeVideo", () => {
  test("transitions status and persists", async () => {
    const video = await createVideo();
    const updated = await setVideoStatus(video.id, "healing");
    expect(updated.status).toBe("healing");
    expect(getVideo(video.id)?.status).toBe("healing");

    const onDisk = await Bun.file(join(DATA_DIR, video.id, "video.json")).json();
    expect(onDisk.status).toBe("healing");
  });

  test("completeVideo sets status to complete", async () => {
    const video = await createVideo();
    const updated = await completeVideo(video.id);
    expect(updated.status).toBe("complete");
  });

  test("throws for unknown id", async () => {
    expect(setVideoStatus("nope", "complete")).rejects.toThrow("Video nope not found");
  });
});

describe("deleteVideo", () => {
  test("removes video from maps and returns the record", async () => {
    const video = await createVideo();
    const deleted = await deleteVideo(video.id);
    expect(deleted).toEqual(video);
    expect(getVideo(video.id)).toBeUndefined();
    expect(getVideoBySlug(video.slug)).toBeUndefined();
  });

  test("returns undefined for unknown id", async () => {
    expect(await deleteVideo("nope")).toBeUndefined();
  });
});

describe("loadAllVideos", () => {
  test("returns 0 when data/ doesn't exist", async () => {
    expect(await loadAllVideos()).toBe(0);
  });

  test("rehydrates multiple videos from disk including segment durations", async () => {
    const a = await createVideo();
    await addSegment(a.id, "seg_000.m4s", 4.0);
    const b = await createVideo();
    await setVideoStatus(b.id, "complete");

    // Simulate a fresh start: clear in-memory state, then reload.
    const { _resetForTests } = await import("../store");
    _resetForTests();
    expect(getVideo(a.id)).toBeUndefined();

    const count = await loadAllVideos();
    expect(count).toBe(2);
    expect(getVideo(a.id)?.id).toBe(a.id);
    expect(getVideo(b.id)?.status).toBe("complete");
    expect(getSegmentDurations(a.id).get("seg_000.m4s")).toBe(4.0);
  });

  test("skips malformed video.json files without throwing", async () => {
    const video = await createVideo();
    // Overwrite with garbage.
    await Bun.write(join(DATA_DIR, video.id, "video.json"), "not json");
    const { _resetForTests } = await import("../store");
    _resetForTests();

    // Should not throw; the malformed record is skipped.
    const count = await loadAllVideos();
    expect(count).toBe(0);
  });
});
