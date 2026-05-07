import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getVideo } from "../../../lib/store";
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

describe("PUT /:id/suggest-description", () => {
  test("applies description when video has no description set", async () => {
    const { id } = await createVideoViaApi();
    const res = await videos.request(`/${id}/suggest-description`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "A walkthrough of the new billing API." }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.applied).toBe(true);

    const video = await getVideo(id);
    expect(video!.description).toBe("A walkthrough of the new billing API.");
  });

  test("does not overwrite when user has already set a description", async () => {
    const { id } = await createVideoViaApi();

    // User sets a description manually via PATCH
    await videos.request(`/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "My custom description" }),
    });

    // AI suggestion arrives later
    const res = await videos.request(`/${id}/suggest-description`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "AI suggested description" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.applied).toBe(false);

    // Description unchanged
    const video = await getVideo(id);
    expect(video!.description).toBe("My custom description");
  });

  test("returns 404 for non-existent video", async () => {
    const res = await videos.request("/nonexistent-id/suggest-description", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "Some description" }),
    });
    expect(res.status).toBe(404);
  });

  test("returns 400 for empty description", async () => {
    const { id } = await createVideoViaApi();
    const res = await videos.request(`/${id}/suggest-description`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "" }),
    });
    expect(res.status).toBe(400);
  });

  test("returns 400 for whitespace-only description", async () => {
    const { id } = await createVideoViaApi();
    const res = await videos.request(`/${id}/suggest-description`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "   \t\n  " }),
    });
    expect(res.status).toBe(400);
  });

  test("returns 400 for missing description field", async () => {
    const { id } = await createVideoViaApi();
    const res = await videos.request(`/${id}/suggest-description`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test("is idempotent — re-calling after applied is a no-op", async () => {
    const { id } = await createVideoViaApi();

    // First call applies
    const res1 = await videos.request(`/${id}/suggest-description`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "First suggestion" }),
    });
    expect((await res1.json()).applied).toBe(true);

    // Second call sees description is no longer null
    const res2 = await videos.request(`/${id}/suggest-description`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "Second suggestion" }),
    });
    expect((await res2.json()).applied).toBe(false);

    // Description remains first suggestion
    const video = await getVideo(id);
    expect(video!.description).toBe("First suggestion");
  });
});
