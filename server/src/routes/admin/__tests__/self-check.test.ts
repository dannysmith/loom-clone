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

describe("GET /admin/self-check", () => {
  // Uses the real 5 GiB disk threshold — assumes the machine running the
  // tests has more free space than that (anything with less has bigger
  // problems building this project).
  test("returns 200 and a healthy report on a clean system", async () => {
    const app = createApp();
    const res = await app.request("/admin/self-check");
    expect(res.status).toBe(200);
    const report = await res.json();
    expect(report.healthy).toBe(true);
    expect(report.failures).toEqual([]);
    expect(report.stats.disk.totalBytes).toBeGreaterThan(0);
  });

  test("returns 503 with the failure list when something is wrong", async () => {
    const video = await createVideo();
    await setVideoStatus(video.id, "processing_failed");

    const app = createApp();
    const res = await app.request("/admin/self-check");
    expect(res.status).toBe(503);
    const report = await res.json();
    expect(report.healthy).toBe(false);
    expect(report.failures.join()).toContain(video.slug);
  });
});
