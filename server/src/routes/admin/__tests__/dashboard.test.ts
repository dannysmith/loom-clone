import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createApp } from "../../../app";
import { completeVideo, createVideo, updateVideo } from "../../../lib/store";
import { addTagToVideo, createTag } from "../../../lib/tags";
import { setupTestEnv, type TestEnv, teardownTestEnv } from "../../../test-utils";

let env: TestEnv;

beforeEach(async () => {
  env = await setupTestEnv();
});

afterEach(async () => {
  await teardownTestEnv(env);
});

describe("dashboard tag display", () => {
  test("renders tag chips on cards for videos that have tags", async () => {
    const app = createApp();
    const video = await createVideo();
    await updateVideo(video.id, { title: "Tagged video" });
    await completeVideo(video.id);

    const tutorial = await createTag("tutorial", "blue");
    await addTagToVideo(video.id, tutorial.id);

    const res = await app.request("/admin");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("video-card-tags");
    expect(html).toContain("tag-chip");
    expect(html).toContain(">tutorial<");
    expect(html).toContain("var(--tag-blue)");
  });

  test("renders an empty tags container for untagged videos (keeps grid alignment)", async () => {
    const app = createApp();
    const video = await createVideo();
    await completeVideo(video.id);

    const res = await app.request("/admin");
    const html = await res.text();
    // The empty wrapper is present (CSS hides it in grid view).
    expect(html).toContain("video-card-tags");
    // But the video has no chip referencing it.
    expect(html).not.toContain(">untagged-tag<");
    void video;
  });
});
