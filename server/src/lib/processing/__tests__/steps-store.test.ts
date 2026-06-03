import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { setupTestEnv, type TestEnv, teardownTestEnv } from "../../../test-utils";
import { createVideo } from "../../store";
import {
  getStep,
  getStepStates,
  markStepFailed,
  markStepReady,
  markStepSkipped,
  upsertStep,
} from "../steps-store";

let env: TestEnv;

beforeEach(async () => {
  env = await setupTestEnv();
});

afterEach(async () => {
  await teardownTestEnv(env);
});

describe("video_processing_steps store", () => {
  test("markStepReady creates a ready row with producedAt", async () => {
    const video = await createVideo();
    await markStepReady(video.id, "source", { sizeBytes: 123 });

    const row = await getStep(video.id, "source");
    expect(row?.state).toBe("ready");
    expect(row?.sizeBytes).toBe(123);
    expect(row?.producedAt).not.toBeNull();
    expect(row?.error).toBeNull();
  });

  test("markStepFailed records the (truncated) error", async () => {
    const video = await createVideo();
    await markStepFailed(video.id, "metadata", "ffprobe blew up");

    const row = await getStep(video.id, "metadata");
    expect(row?.state).toBe("failed");
    expect(row?.error).toBe("ffprobe blew up");
  });

  test("markStepSkipped marks skipped and clears error", async () => {
    const video = await createVideo();
    await markStepFailed(video.id, "audio", "boom");
    await markStepSkipped(video.id, "audio");

    const row = await getStep(video.id, "audio");
    expect(row?.state).toBe("skipped");
    expect(row?.error).toBeNull();
  });

  test("upsert is idempotent on (videoId, kind) and preserves attempts", async () => {
    const video = await createVideo();
    await markStepReady(video.id, "thumbnail");
    await upsertStep(video.id, "thumbnail", { state: "pending", incrementAttempts: true });
    await upsertStep(video.id, "thumbnail", { state: "ready", incrementAttempts: true });

    const row = await getStep(video.id, "thumbnail");
    expect(row?.state).toBe("ready");
    expect(row?.attempts).toBe(2);
  });

  test("getStepStates returns a kind→row map", async () => {
    const video = await createVideo();
    await markStepReady(video.id, "source");
    await markStepFailed(video.id, "metadata", "x");

    const map = await getStepStates(video.id);
    expect(map.get("source")?.state).toBe("ready");
    expect(map.get("metadata")?.state).toBe("failed");
    expect(map.get("peaks")).toBeUndefined();
  });
});
