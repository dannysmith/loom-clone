import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { mkdir } from "fs/promises";
import { join } from "path";
import { getDb } from "../../db/client";
import {
  slugRedirects as slugRedirectsTable,
  videoEvents,
  videos as videosTable,
} from "../../db/schema";
import { setupTestEnv, type TestEnv, teardownTestEnv } from "../../test-utils";
import { listEvents } from "../events";
import { duplicateVideo, permanentlyDeleteVideo } from "../lifecycle";
import { DATA_DIR } from "../paths";
import { getStepStates } from "../processing/steps-store";
import {
  addSegment,
  createVideo,
  getSegmentDurations,
  getTranscript,
  getVideo,
  setVideoStatus,
  trashVideo,
  updateVideo,
  upsertTranscript,
} from "../store";
import { addTagToVideo, createTag, getVideoTags } from "../tags";

let env: TestEnv;

beforeEach(async () => {
  env = await setupTestEnv();
});

afterEach(async () => {
  await teardownTestEnv(env);
});

describe("permanentlyDeleteVideo", () => {
  test("removes video record and cascades to all related tables", async () => {
    const video = await createVideo();
    await addSegment(video.id, "seg_000.m4s", 4.0);
    const tag = await createTag("test-tag");
    await addTagToVideo(video.id, tag.id);
    await trashVideo(video.id);

    await permanentlyDeleteVideo(video.id);

    expect(await getVideo(video.id, { includeTrashed: true })).toBeUndefined();
    expect(await getSegmentDurations(video.id)).toEqual(new Map());
    expect(await getVideoTags(video.id)).toEqual([]);
    const events = await getDb()
      .select()
      .from(videoEvents)
      .where(eq(videoEvents.videoId, video.id));
    expect(events).toHaveLength(0);
  });

  test("deletes the data directory from disk", async () => {
    const { writeFile: wf } = await import("fs/promises");
    const { existsSync } = await import("fs");
    const { join } = await import("path");

    const video = await createVideo();
    const dir = join("data", video.id);
    await wf(join(dir, "test.txt"), "content");
    expect(existsSync(dir)).toBe(true);

    await trashVideo(video.id);
    await permanentlyDeleteVideo(video.id);

    expect(existsSync(dir)).toBe(false);
  });

  test("throws if video not found", async () => {
    expect(permanentlyDeleteVideo("nonexistent")).rejects.toThrow("not found");
  });

  test("throws if video is not trashed", async () => {
    const video = await createVideo();
    expect(permanentlyDeleteVideo(video.id)).rejects.toThrow("not trashed");
  });
});

describe("duplicateVideo", () => {
  test("creates a new video with different id and slug", async () => {
    const original = await createVideo();
    await updateVideo(original.id, { title: "Original", visibility: "public" });

    const dup = await duplicateVideo(original.id);
    expect(dup.id).not.toBe(original.id);
    expect(dup.slug).not.toBe(original.slug);
    expect(dup.slug).toContain(original.slug); // slug-1 pattern
  });

  test("re-derives processing-step rows for the copy from its files", async () => {
    const original = await createVideo();
    await setVideoStatus(original.id, "ready");
    await getDb()
      .update(videosTable)
      .set({ width: 1280, height: 720, durationSeconds: 90 })
      .where(eq(videosTable.id, original.id));
    // Put a couple of derivative files on disk for the original.
    const dir = join(DATA_DIR, original.id, "derivatives");
    await mkdir(dir, { recursive: true });
    await Bun.write(join(dir, "peaks.json"), "[]");

    const dup = await duplicateVideo(original.id);

    // The copy gets its own step rows inferred from the copied files — not the
    // original's rows — so it serves correctly under table-gated logic.
    const steps = await getStepStates(dup.id);
    expect(steps.get("peaks")?.state).toBe("ready");
    expect(steps.get("metadata")?.state).toBe("ready");
  });

  test("appends (1) to title, increments existing suffix", async () => {
    const v = await createVideo();
    await updateVideo(v.id, { title: "My Video" });

    const d1 = await duplicateVideo(v.id);
    expect(d1.title).toBe("My Video (1)");

    const d2 = await duplicateVideo(d1.id);
    expect(d2.title).toBe("My Video (2)");
  });

  test("preserves null title", async () => {
    const v = await createVideo();
    const dup = await duplicateVideo(v.id);
    expect(dup.title).toBeNull();
  });

  test("preserves notes and the edited flag (lastEditedAt) on the copy", async () => {
    // [P1.2] A copy that drops lastEditedAt is treated as unedited:
    // activeRawFilename then resolves to the full-length source.mp4 instead of
    // the edited cut, and step inference validates source.mp4 against the
    // (shorter) edited duration and fails it → processing_failed.
    const original = await createVideo();
    await getDb()
      .update(videosTable)
      .set({ notes: "private notes", lastEditedAt: "2026-01-02T03:04:05.000Z" })
      .where(eq(videosTable.id, original.id));

    const dup = await duplicateVideo(original.id);
    expect(dup.notes).toBe("private notes");
    // Preserved verbatim (not reset to the duplication time).
    expect(dup.lastEditedAt).toBe("2026-01-02T03:04:05.000Z");
  });

  test("preserves visibility, description, and source", async () => {
    const v = await createVideo();
    await updateVideo(v.id, {
      title: "Test",
      description: "A description",
      visibility: "private",
    });

    const dup = await duplicateVideo(v.id);
    expect(dup.visibility).toBe("private");
    expect(dup.description).toBe("A description");
    expect(dup.source).toBe("recorded");
  });

  test("copies the transcript (DB row + step) to the duplicate", async () => {
    // The captions file is copied with the rest of derivatives/, but the
    // video_transcripts row + FTS index are per-id — without re-inserting them
    // the copy's transcript tab/search are empty and the transcript step (which
    // infers from the DB row, not the file) shows missing.
    const original = await createVideo();
    await upsertTranscript(original.id, "srt", "hello from the transcript");

    const dup = await duplicateVideo(original.id);

    expect((await getTranscript(dup.id))?.plainText).toBe("hello from the transcript");
    expect((await getStepStates(dup.id)).get("transcript")?.state).toBe("ready");
  });

  test("preserves tag associations", async () => {
    const v = await createVideo();
    const tag1 = await createTag("demo", "blue");
    const tag2 = await createTag("tutorial", "green");
    await addTagToVideo(v.id, tag1.id);
    await addTagToVideo(v.id, tag2.id);

    const dup = await duplicateVideo(v.id);
    const dupTags = await getVideoTags(dup.id);
    expect(dupTags.map((t) => t.name).sort()).toEqual(["demo", "tutorial"]);
  });

  test("logs events on both original and duplicate", async () => {
    const v = await createVideo();
    await updateVideo(v.id, { title: "Original" });

    const dup = await duplicateVideo(v.id);

    const origEvents = await listEvents(v.id);
    expect(origEvents.some((e) => e.type === "duplicated")).toBe(true);

    const dupEvents = await listEvents(dup.id);
    expect(dupEvents.some((e) => e.type === "duplicated_from")).toBe(true);
    // Duplicate should NOT inherit original's event log
    expect(dupEvents.filter((e) => e.type === "created")).toHaveLength(0);
  });

  test("does not create slug redirects for the duplicate", async () => {
    const v = await createVideo();
    const dup = await duplicateVideo(v.id);

    const db = getDb();
    const redirects = await db
      .select()
      .from(slugRedirectsTable)
      .where(eq(slugRedirectsTable.videoId, dup.id));
    expect(redirects).toHaveLength(0);
  });

  test("normalises a post-footage copy with an invalid source to processing_failed", async () => {
    // A `reprocessing` original copied verbatim would strand the duplicate (no
    // owner ever settles it); with an unvalidatable (stub) source the inferred
    // ledger isn't ready, so the copy lands in processing_failed — reprocessable
    // and honest — rather than stuck reprocessing.
    const original = await createVideo();
    await setVideoStatus(original.id, "reprocessing");
    const dir = join(DATA_DIR, original.id, "derivatives");
    await mkdir(dir, { recursive: true });
    await Bun.write(join(dir, "source.mp4"), "stub"); // not a playable video

    const dup = await duplicateVideo(original.id);
    expect(dup.status).toBe("processing_failed");
  });

  test("a mid-processing copy is labelled processing, not processing_failed", async () => {
    // [P2.1] The shared rollup distinguishes "still processing" (required steps
    // merely pending) from "failed" (a required step actually failed). The old
    // hand-written duplicate rollup collapsed both to processing_failed.
    const original = await createVideo();
    await setVideoStatus(original.id, "processing");
    // No source.mp4 on disk → the inferred ledger has no ready/failed required
    // steps, so the rollup is "processing".
    const dup = await duplicateVideo(original.id);
    expect(dup.status).toBe("processing");
  });

  test("leaves a footage-state (recording) copy's status untouched", async () => {
    // recording/healing/incomplete mirror footage, not the derivative ledger —
    // the rollup must not relabel them.
    const original = await createVideo(); // status: recording
    const dup = await duplicateVideo(original.id);
    expect(dup.status).toBe("recording");
  });
});
