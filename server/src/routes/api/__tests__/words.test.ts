import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "path";
import { DATA_DIR } from "../../../lib/store";
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

const SAMPLE_WORDS = [
  { word: "Hello", start: 0.0, end: 0.35 },
  { word: "world", start: 0.4, end: 0.8 },
  { word: "this", start: 0.85, end: 1.1 },
  { word: "is", start: 1.12, end: 1.25 },
  { word: "a", start: 1.27, end: 1.3 },
  { word: "test", start: 1.32, end: 1.6 },
];

describe("PUT /:id/words", () => {
  test("uploads word data and writes words.json", async () => {
    const { id } = await createVideoViaApi();
    const res = await videos.request(`/${id}/words`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(SAMPLE_WORDS),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const file = Bun.file(join(DATA_DIR, id, "derivatives", "words.json"));
    expect(await file.exists()).toBe(true);
    const content = await file.json();
    expect(content).toHaveLength(6);
    expect(content[0].word).toBe("Hello");
  });

  test("returns 404 for non-existent video", async () => {
    const res = await videos.request("/nonexistent-id/words", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(SAMPLE_WORDS),
    });
    expect(res.status).toBe(404);
  });

  test("returns 400 for empty array", async () => {
    const { id } = await createVideoViaApi();
    const res = await videos.request(`/${id}/words`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([]),
    });
    expect(res.status).toBe(400);
  });

  test("returns 400 for non-JSON content type", async () => {
    const { id } = await createVideoViaApi();
    const res = await videos.request(`/${id}/words`, {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify(SAMPLE_WORDS),
    });
    expect(res.status).toBe(400);
  });

  test("is idempotent — re-uploading replaces", async () => {
    const { id } = await createVideoViaApi();

    await videos.request(`/${id}/words`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(SAMPLE_WORDS),
    });

    const updated = [{ word: "Replaced", start: 0.0, end: 0.5 }];
    await videos.request(`/${id}/words`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updated),
    });

    const file = Bun.file(join(DATA_DIR, id, "derivatives", "words.json"));
    const content = await file.json();
    expect(content).toHaveLength(1);
    expect(content[0].word).toBe("Replaced");
  });
});
