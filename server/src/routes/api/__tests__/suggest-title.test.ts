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

describe("PUT /:id/suggest-title", () => {
  test("applies title when video has no title set", async () => {
    const { id } = await createVideoViaApi();
    const res = await videos.request(`/${id}/suggest-title`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Quick demo of the billing API" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.applied).toBe(true);

    const video = await getVideo(id);
    expect(video!.title).toBe("Quick demo of the billing API");
  });

  test("does not overwrite when user has already set a title", async () => {
    const { id } = await createVideoViaApi();

    // User sets a title manually via PATCH
    await videos.request(`/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "My custom title" }),
    });

    // AI suggestion arrives later
    const res = await videos.request(`/${id}/suggest-title`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "AI suggested title" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.applied).toBe(false);

    // Title unchanged
    const video = await getVideo(id);
    expect(video!.title).toBe("My custom title");
  });

  test("returns 404 for non-existent video", async () => {
    const res = await videos.request("/nonexistent-id/suggest-title", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Some title" }),
    });
    expect(res.status).toBe(404);
  });

  test("returns 400 for empty title", async () => {
    const { id } = await createVideoViaApi();
    const res = await videos.request(`/${id}/suggest-title`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "" }),
    });
    expect(res.status).toBe(400);
  });

  test("returns 400 for missing title field", async () => {
    const { id } = await createVideoViaApi();
    const res = await videos.request(`/${id}/suggest-title`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test("is idempotent — re-calling after applied is a no-op", async () => {
    const { id } = await createVideoViaApi();

    // First call applies
    const res1 = await videos.request(`/${id}/suggest-title`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "First suggestion" }),
    });
    expect((await res1.json()).applied).toBe(true);

    // Second call sees title is no longer null
    const res2 = await videos.request(`/${id}/suggest-title`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Second suggestion" }),
    });
    expect((await res2.json()).applied).toBe(false);

    // Title remains first suggestion
    const video = await getVideo(id);
    expect(video!.title).toBe("First suggestion");
  });
});
