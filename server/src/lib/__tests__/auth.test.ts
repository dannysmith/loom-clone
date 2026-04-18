import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { setupTestEnv, type TestEnv, teardownTestEnv } from "../../test-utils";
import { createApiKey, listApiKeys, revokeApiKey } from "../api-keys";
import { requireApiKey } from "../auth";

let env: TestEnv;

beforeEach(async () => {
  env = await setupTestEnv();
});

afterEach(async () => {
  await teardownTestEnv(env);
});

// Mounts requireApiKey() in front of a single OK route so we can assert
// what each rejection path looks like in isolation.
function appWithGuard(): Hono {
  const app = new Hono();
  app.use("*", requireApiKey());
  app.get("/x", (c) => c.text("ok"));
  return app;
}

describe("requireApiKey middleware", () => {
  test("401 with WWW-Authenticate and MISSING_AUTH_HEADER when no header", async () => {
    const res = await appWithGuard().request("/x");
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("Bearer");
    const body = await res.json();
    expect(body.code).toBe("MISSING_AUTH_HEADER");
  });

  test("401 with MALFORMED_AUTH_HEADER for non-Bearer auth scheme", async () => {
    const res = await appWithGuard().request("/x", {
      headers: { Authorization: "Basic dXNlcjpwYXNz" },
    });
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("MALFORMED_AUTH_HEADER");
  });

  test("401 for Bearer with no token (runtime trims trailing space)", async () => {
    // The Request API trims trailing whitespace from header values, so
    // "Bearer " becomes "Bearer" — indistinguishable from a malformed header.
    const res = await appWithGuard().request("/x", {
      headers: { Authorization: "Bearer " },
    });
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("MALFORMED_AUTH_HEADER");
  });

  test("401 with INVALID_API_KEY for an unknown token", async () => {
    const res = await appWithGuard().request("/x", {
      headers: { Authorization: "Bearer lck_doesnotexist" },
    });
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("INVALID_API_KEY");
  });

  test("401 with INVALID_API_KEY for a revoked token", async () => {
    const { id, plaintext } = await createApiKey("macbook");
    await revokeApiKey(id);
    const res = await appWithGuard().request("/x", {
      headers: { Authorization: `Bearer ${plaintext}` },
    });
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("INVALID_API_KEY");
  });

  test("passes through with a valid token and updates lastUsedAt", async () => {
    const { plaintext } = await createApiKey("macbook");
    const res = await appWithGuard().request("/x", {
      headers: { Authorization: `Bearer ${plaintext}` },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    // touchLastUsed runs fire-and-forget; give it a tick to land.
    await new Promise((r) => setTimeout(r, 20));
    const [row] = await listApiKeys();
    expect(row?.lastUsedAt).not.toBeNull();
  });

  test("scheme match is case-insensitive (RFC 7235)", async () => {
    const { plaintext } = await createApiKey("macbook");
    const res = await appWithGuard().request("/x", {
      headers: { Authorization: `bearer ${plaintext}` },
    });
    expect(res.status).toBe(200);
  });
});
