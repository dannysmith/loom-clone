import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createApp } from "../app";
import { createVideo } from "../lib/store";
import { setupTestEnv, type TestEnv, teardownTestEnv } from "../test-utils";

let env: TestEnv;

beforeEach(async () => {
  env = await setupTestEnv();
});

afterEach(async () => {
  await teardownTestEnv(env);
});

// Wildcard CORS is applied to the public viewer surface so external
// origins (e.g. an inline player on danny.is) can fetch JSON metadata,
// captions, and storyboard VTTs cross-origin. /api/* and /admin/* must
// stay same-origin / token-gated and therefore must NOT advertise CORS.
describe("CORS — public viewer routes", () => {
  test("/:slug.json sets Access-Control-Allow-Origin: *", async () => {
    const app = createApp();
    const video = await createVideo();
    const res = await app.request(`/${video.slug}.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("/:slug/captions.vtt sets Access-Control-Allow-Origin: *", async () => {
    const app = createApp();
    const video = await createVideo();
    // The route returns 404 because no captions file exists, but middleware
    // runs regardless — that's what we're verifying.
    const res = await app.request(`/${video.slug}/captions.vtt`);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("OPTIONS preflight on /:slug.json returns 204 with allowed methods", async () => {
    const app = createApp();
    const video = await createVideo();
    const res = await app.request(`/${video.slug}.json`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://danny.is",
        "Access-Control-Request-Method": "GET",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const allowMethods = res.headers.get("access-control-allow-methods") ?? "";
    expect(allowMethods).toContain("GET");
  });

  test("public site endpoints set CORS headers", async () => {
    const app = createApp();
    for (const path of ["/feed.xml", "/feed.json", "/llms.txt", "/sitemap.xml"]) {
      const res = await app.request(path);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
    }
  });
});

describe("CORS — same-origin routes do not advertise CORS", () => {
  test("/api/health does NOT set Access-Control-Allow-Origin", async () => {
    const app = createApp();
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("/admin does NOT set Access-Control-Allow-Origin", async () => {
    const app = createApp();
    const res = await app.request("/admin");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});
