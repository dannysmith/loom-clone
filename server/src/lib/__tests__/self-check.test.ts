import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { mkdir } from "fs/promises";
import { join } from "path";
import { getDb } from "../../db/client";
import { videos } from "../../db/schema";
import { setupTestEnv, type TestEnv, teardownTestEnv } from "../../test-utils";
import { DATA_DIR } from "../paths";
import { runSelfCheck } from "../self-check";
import { createVideo, setVideoStatus } from "../store";

let env: TestEnv;

beforeEach(async () => {
  env = await setupTestEnv();
});

afterEach(async () => {
  await teardownTestEnv(env);
});

// Disk headroom depends on whatever machine runs the tests, so everything
// except the disk test itself pins the threshold to 0 (never alert).
const check = () => runSelfCheck({ diskFreeAlertBytes: 0 });

const HOUR = 60 * 60 * 1000;
const backdate = (ms: number) => new Date(Date.now() - ms).toISOString();

describe("runSelfCheck failures", () => {
  test("healthy on an empty system", async () => {
    const report = await check();
    expect(report.failures).toEqual([]);
    expect(report.healthy).toBe(true);
  });

  test("reports a video stuck in processing past the stalled threshold", async () => {
    const video = await createVideo();
    await setVideoStatus(video.id, "processing");
    await getDb()
      .update(videos)
      .set({ updatedAt: backdate(1 * HOUR) })
      .where(eq(videos.id, video.id));

    const report = await check();
    expect(report.healthy).toBe(false);
    expect(report.failures.join()).toContain("stuck in processing");
    expect(report.failures.join()).toContain(video.slug);
  });

  test("does not report a video that just entered processing", async () => {
    const video = await createVideo();
    await setVideoStatus(video.id, "processing");
    expect((await check()).healthy).toBe(true);
  });

  test("reports a stalled recording (>4h without activity)", async () => {
    const video = await createVideo();
    await getDb()
      .update(videos)
      .set({ createdAt: backdate(5 * HOUR) })
      .where(eq(videos.id, video.id));

    const report = await check();
    expect(report.failures.join()).toContain("recording(s) with no segment activity");
    expect(report.failures.join()).toContain(video.slug);
  });

  test("reports a stalled heal (>48h), but not one merely hours old", async () => {
    const stuck = await createVideo();
    await getDb()
      .update(videos)
      .set({ status: "healing", updatedAt: backdate(50 * HOUR) })
      .where(eq(videos.id, stuck.id));
    const recent = await createVideo();
    await getDb()
      .update(videos)
      .set({ status: "healing", updatedAt: backdate(5 * HOUR) })
      .where(eq(videos.id, recent.id));

    const report = await check();
    expect(report.failures.join()).toContain(stuck.slug);
    expect(report.failures.join()).not.toContain(recent.slug);
  });

  test("processing_failed and incomplete alert until dealt with", async () => {
    const failed = await createVideo();
    await setVideoStatus(failed.id, "processing_failed");
    const incomplete = await createVideo();
    await setVideoStatus(incomplete.id, "incomplete");

    const report = await check();
    expect(report.failures.join()).toContain("failed processing");
    expect(report.failures.join()).toContain(failed.slug);
    expect(report.failures.join()).toContain("incomplete video(s)");
    expect(report.failures.join()).toContain(incomplete.slug);

    // Trashing them is "dealing with it" — the alert clears.
    const now = new Date().toISOString();
    await getDb().update(videos).set({ trashedAt: now }).where(eq(videos.id, failed.id));
    await getDb().update(videos).set({ trashedAt: now }).where(eq(videos.id, incomplete.id));
    expect((await check()).healthy).toBe(true);
  });

  test("disk headroom alert fires below the threshold", async () => {
    // MAX_SAFE_INTEGER free bytes is impossible, so this always trips.
    const report = await runSelfCheck({ diskFreeAlertBytes: Number.MAX_SAFE_INTEGER });
    expect(report.healthy).toBe(false);
    expect(report.failures.join()).toContain("low on space");
  });

  test("reports missing CDN key in production only", async () => {
    const prevNodeEnv = process.env.NODE_ENV;
    const prevKey = process.env.BUNNY_CDN_API_KEY;
    try {
      process.env.NODE_ENV = "production";
      delete process.env.BUNNY_CDN_API_KEY;
      expect((await check()).failures.join()).toContain("CDN purging disabled");

      process.env.BUNNY_CDN_API_KEY = "test-key";
      expect((await check()).healthy).toBe(true);
    } finally {
      if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevNodeEnv;
      if (prevKey === undefined) delete process.env.BUNNY_CDN_API_KEY;
      else process.env.BUNNY_CDN_API_KEY = prevKey;
    }
  });
});

describe("runSelfCheck stats", () => {
  test("reports disk numbers, the data footprint, and the backup marker", async () => {
    await mkdir(DATA_DIR, { recursive: true });
    await Bun.write(join(DATA_DIR, ".last-backup"), "2026-09-01T03:30:00Z\n");
    await Bun.write(join(DATA_DIR, "some-file"), "0123456789");

    const { stats } = await check();
    expect(stats.disk.totalBytes).toBeGreaterThan(0);
    expect(stats.disk.freeBytes).toBeGreaterThan(0);
    expect(stats.dataDirBytes).toBeGreaterThanOrEqual(10);
    expect(stats.lastBackupAt).toBe("2026-09-01T03:30:00Z");
    // memory is cgroup-dependent (null on macOS, populated in a container) —
    // just assert the key is present.
    expect("memory" in stats).toBe(true);
  });

  test("backup marker is null when the file doesn't exist", async () => {
    const { stats } = await check();
    expect(stats.lastBackupAt).toBeNull();
  });
});
