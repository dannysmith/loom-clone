import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readChapters, writeChapters } from "../../../lib/chapters";
import { setupTestEnv, type TestEnv, teardownTestEnv } from "../../../test-utils";
import videos from "../videos";

let env: TestEnv;
beforeEach(async () => {
  env = await setupTestEnv();
});
afterEach(async () => {
  await teardownTestEnv(env);
});

async function createVideoViaApi(): Promise<{ id: string; slug: string }> {
  const res = await videos.request("/", { method: "POST" });
  expect(res.status).toBe(200);
  return res.json();
}

const HEADERS = { "Content-Type": "application/json" } as const;

describe("PUT /:id/chapters/:chapterId/suggest-title", () => {
  test("applies title to a chapter whose title is null", async () => {
    const { id } = await createVideoViaApi();
    await writeChapters(id, [{ id: "ch-a", title: null, t: 5, createdDuringRecording: true }]);
    const res = await videos.request(`/${id}/chapters/ch-a/suggest-title`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ title: "Intro to billing" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ applied: true });
    const stored = await readChapters(id);
    expect(stored?.chapters[0]?.title).toBe("Intro to billing");
  });

  test("returns user_set when chapter already has a title", async () => {
    const { id } = await createVideoViaApi();
    await writeChapters(id, [
      { id: "ch-a", title: "User wrote this", t: 5, createdDuringRecording: true },
    ]);
    const res = await videos.request(`/${id}/chapters/ch-a/suggest-title`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ title: "AI guess" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ applied: false, reason: "user_set" });
    const stored = await readChapters(id);
    expect(stored?.chapters[0]?.title).toBe("User wrote this");
  });

  test("returns not_found when chapter doesn't exist", async () => {
    const { id } = await createVideoViaApi();
    await writeChapters(id, [{ id: "ch-a", title: null, t: 5, createdDuringRecording: true }]);
    const res = await videos.request(`/${id}/chapters/ch-deleted/suggest-title`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ title: "Whatever" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ applied: false, reason: "not_found" });
  });

  test("returns no_chapters when chapters.json is missing", async () => {
    const { id } = await createVideoViaApi();
    const res = await videos.request(`/${id}/chapters/ch-x/suggest-title`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ title: "X" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ applied: false, reason: "no_chapters" });
  });

  test("returns 404 for unknown video", async () => {
    const res = await videos.request("/nope/chapters/c/suggest-title", {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ title: "X" }),
    });
    expect(res.status).toBe(404);
  });

  test("rejects empty / oversized titles", async () => {
    const { id } = await createVideoViaApi();
    await writeChapters(id, [{ id: "ch-a", title: null, t: 5, createdDuringRecording: true }]);
    const empty = await videos.request(`/${id}/chapters/ch-a/suggest-title`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ title: "" }),
    });
    expect(empty.status).toBe(400);
    const huge = await videos.request(`/${id}/chapters/ch-a/suggest-title`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ title: "x".repeat(201) }),
    });
    expect(huge.status).toBe(400);
  });
});
