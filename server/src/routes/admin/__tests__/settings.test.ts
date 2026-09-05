import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createApp } from "../../../app";
import { createVideo, setVideoStatus } from "../../../lib/store";
import { setupTestEnv, type TestEnv, teardownTestEnv } from "../../../test-utils";

let env: TestEnv;

beforeEach(async () => {
  env = await setupTestEnv();
});

afterEach(async () => {
  await teardownTestEnv(env);
});

describe("settings general pane (system health + stats)", () => {
  test("renders health and stats on a clean system", async () => {
    const app = createApp();
    const res = await app.request("/admin/settings");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("All checks passing");
    expect(html).toContain("Data volume");
    expect(html).toContain("Video data");
    // No backup marker in dev/tests — the row degrades, never crashes.
    expect(html).toContain("Not recorded yet");
  });

  test("renders the failure list when a check fails", async () => {
    const video = await createVideo();
    await setVideoStatus(video.id, "processing_failed");

    const app = createApp();
    const html = await (await app.request("/admin/settings")).text();
    expect(html).not.toContain("All checks passing");
    expect(html).toContain("failed processing");
    expect(html).toContain(video.slug);
  });
});
