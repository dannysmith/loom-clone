import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createApp } from "../app";
import { authHeaders, setupTestEnv, type TestEnv, teardownTestEnv } from "../test-utils";

let env: TestEnv;

beforeEach(async () => {
  env = await setupTestEnv();
});

afterEach(async () => {
  await teardownTestEnv(env);
});

// End-to-end checks for the wiring done in Phase 4. Verifies that the
// static asset pipeline and the admin shell are reachable through the
// real factory, not just in isolation.

describe("createApp", () => {
  test("serves the CSS entry point at /static/styles/app.css", async () => {
    const app = createApp();
    const res = await app.request("/static/styles/app.css");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/css");
    const body = await res.text();
    expect(body).toContain("@layer");
  });

  test("/admin renders the admin shell", async () => {
    const app = createApp();
    const res = await app.request("/admin");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toMatch(/^<!DOCTYPE html>/i);
    expect(body).toContain('class="admin"');
    expect(body).toContain("/static/styles/admin.css");
  });

  test("/api/health returns ok, version, and time", async () => {
    const app = createApp();
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(body.time).toBeTruthy();
  });

  test("/api/health is unauthenticated", async () => {
    // Sanity: the health check must return 200 with no Authorization
    // header, or the desktop app's reachability ping conflates "server
    // down" with "bad credentials".
    const app = createApp();
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
  });
});

describe("auth gate on /api/videos/*", () => {
  test("POST /api/videos returns 401 without an API key", async () => {
    const app = createApp();
    const res = await app.request("/api/videos", { method: "POST" });
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("Bearer");
  });

  test("POST /api/videos succeeds with a valid key", async () => {
    const app = createApp();
    const res = await app.request("/api/videos", {
      method: "POST",
      headers: await authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; slug: string };
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.slug).toBeTruthy();
  });

  test("PUT /api/videos/:id/segments/:filename gated", async () => {
    const app = createApp();
    const res = await app.request("/api/videos/anyid/segments/init.mp4", {
      method: "PUT",
      body: new Uint8Array([0]),
    });
    expect(res.status).toBe(401);
  });

  test("POST /api/videos/:id/complete gated", async () => {
    const app = createApp();
    const res = await app.request("/api/videos/anyid/complete", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(401);
  });

  test("DELETE /api/videos/:id gated", async () => {
    const app = createApp();
    const res = await app.request("/api/videos/anyid", { method: "DELETE" });
    expect(res.status).toBe(401);
  });
});
