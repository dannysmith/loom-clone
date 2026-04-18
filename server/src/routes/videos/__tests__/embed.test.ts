import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createVideo, trashVideo, updateSlug } from "../../../lib/store";
import { setupTestEnv, type TestEnv, teardownTestEnv } from "../../../test-utils";
import embed from "../embed";

let env: TestEnv;
beforeEach(async () => {
  env = await setupTestEnv();
});
afterEach(async () => {
  await teardownTestEnv(env);
});

describe("GET /:slug/embed", () => {
  test("returns 404 for unknown slug", async () => {
    const res = await embed.request("/deadbeef/embed");
    expect(res.status).toBe(404);
  });

  test("returns chromeless HTML page with video player", async () => {
    const video = await createVideo();
    const res = await embed.request(`/${video.slug}/embed`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("<media-player");
    expect(html).toContain("embed");
    expect(html).not.toContain("viewer.css");
  });

  test("old slug 301-redirects to current slug embed URL", async () => {
    const video = await createVideo();
    const oldSlug = video.slug;
    await updateSlug(video.id, "demo");

    const res = await embed.request(`/${oldSlug}/embed`, { redirect: "manual" });
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/demo/embed");
  });

  test("trashed video returns 404", async () => {
    const video = await createVideo();
    await trashVideo(video.id);
    const res = await embed.request(`/${video.slug}/embed`);
    expect(res.status).toBe(404);
  });
});
