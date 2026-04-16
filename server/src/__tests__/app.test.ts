import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createApp } from "../app";
import { setupTestEnv, type TestEnv, teardownTestEnv } from "../test-utils";

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

  test("/api/health still works", async () => {
    const app = createApp();
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
