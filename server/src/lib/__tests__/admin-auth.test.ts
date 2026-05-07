import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { setupTestEnv, type TestEnv, teardownTestEnv } from "../../test-utils";
import { createSession, getAdminConfig, requireAdmin, verifyCredentials } from "../admin-auth";
import {
  createAdminToken,
  listAdminTokens,
  revokeAdminToken,
  verifyAdminToken,
} from "../admin-tokens";

let env: TestEnv;

beforeEach(async () => {
  env = await setupTestEnv();
});

afterEach(async () => {
  await teardownTestEnv(env);
});

// ---------- Config ----------

describe("getAdminConfig", () => {
  // Tests run with NODE_ENV unset (dev) by default; a couple of cases below
  // flip it to "production" and clean up afterwards.
  const originalNodeEnv = process.env.NODE_ENV;
  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  });

  test("returns null when ADMIN_PASSWORD is not set (dev)", () => {
    delete process.env.NODE_ENV;
    delete process.env.ADMIN_PASSWORD;
    delete process.env.SESSION_SECRET;
    expect(getAdminConfig()).toBeNull();
  });

  test("throws in production when ADMIN_PASSWORD is missing", () => {
    process.env.NODE_ENV = "production";
    delete process.env.ADMIN_PASSWORD;
    delete process.env.SESSION_SECRET;
    expect(() => getAdminConfig()).toThrow(/ADMIN_PASSWORD/);
  });

  test("throws when ADMIN_PASSWORD is set but SESSION_SECRET is missing", () => {
    process.env.ADMIN_PASSWORD = "secret";
    delete process.env.SESSION_SECRET;
    expect(() => getAdminConfig()).toThrow("SESSION_SECRET");
    delete process.env.ADMIN_PASSWORD;
  });

  test("returns config when both are set", () => {
    process.env.ADMIN_PASSWORD = "secret";
    process.env.SESSION_SECRET = "s3cr3t";
    const config = getAdminConfig();
    expect(config).not.toBeNull();
    expect(config!.username).toBe("admin");
    expect(config!.password).toBe("secret");
    delete process.env.ADMIN_PASSWORD;
    delete process.env.SESSION_SECRET;
  });

  test("respects ADMIN_USERNAME", () => {
    process.env.ADMIN_PASSWORD = "secret";
    process.env.SESSION_SECRET = "s3cr3t";
    process.env.ADMIN_USERNAME = "danny";
    expect(getAdminConfig()!.username).toBe("danny");
    delete process.env.ADMIN_PASSWORD;
    delete process.env.SESSION_SECRET;
    delete process.env.ADMIN_USERNAME;
  });
});

// ---------- Credentials ----------

describe("verifyCredentials", () => {
  const config = { username: "admin", password: "hunter2", sessionSecret: "xxx" };

  test("returns true for correct credentials", () => {
    expect(verifyCredentials(config, "admin", "hunter2")).toBe(true);
  });

  test("returns false for wrong password", () => {
    expect(verifyCredentials(config, "admin", "wrong")).toBe(false);
  });

  test("returns false for wrong username", () => {
    expect(verifyCredentials(config, "wrong", "hunter2")).toBe(false);
  });
});

// ---------- Admin tokens ----------

describe("admin tokens", () => {
  test("create and verify a token", async () => {
    const { id, plaintext } = await createAdminToken("test-token");
    expect(plaintext).toStartWith("lca_");
    const verified = await verifyAdminToken(plaintext);
    expect(verified).not.toBeNull();
    expect(verified!.id).toBe(id);
  });

  test("verifyAdminToken rejects unknown tokens", async () => {
    expect(await verifyAdminToken("lca_doesnotexist")).toBeNull();
  });

  test("verifyAdminToken rejects lck_ tokens (wrong prefix)", async () => {
    expect(await verifyAdminToken("lck_doesnotexist")).toBeNull();
  });

  test("revoking a token makes it invalid", async () => {
    const { id, plaintext } = await createAdminToken("revokable");
    await revokeAdminToken(id);
    expect(await verifyAdminToken(plaintext)).toBeNull();
  });

  test("listAdminTokens returns all tokens", async () => {
    await createAdminToken("first");
    await createAdminToken("second");
    const tokens = await listAdminTokens();
    expect(tokens).toHaveLength(2);
    const names = tokens.map((t) => t.name).sort();
    expect(names).toEqual(["first", "second"]);
  });
});

// ---------- Middleware ----------

function testApp(opts: { password?: string; sessionSecret?: string } = {}): Hono {
  // Set env vars for the test
  if (opts.password) process.env.ADMIN_PASSWORD = opts.password;
  if (opts.sessionSecret) process.env.SESSION_SECRET = opts.sessionSecret;

  const app = new Hono();
  app.use("*", requireAdmin());
  app.get("/admin/test", (c) => c.text("ok"));
  return app;
}

function cleanupEnv() {
  delete process.env.ADMIN_PASSWORD;
  delete process.env.SESSION_SECRET;
  delete process.env.ADMIN_USERNAME;
}

describe("requireAdmin middleware", () => {
  afterEach(cleanupEnv);

  test("passes through in dev mode (no ADMIN_PASSWORD)", async () => {
    const app = testApp();
    const res = await app.request("/admin/test");
    expect(res.status).toBe(200);
  });

  test("redirects to login when not authenticated", async () => {
    const app = testApp({ password: "secret", sessionSecret: "s3cr3t" });
    const res = await app.request("/admin/test", { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/admin/login");
  });

  test("accepts valid admin bearer token", async () => {
    const { plaintext } = await createAdminToken("test");
    const app = testApp({ password: "secret", sessionSecret: "s3cr3t" });
    const res = await app.request("/admin/test", {
      headers: { Authorization: `Bearer ${plaintext}` },
    });
    expect(res.status).toBe(200);
  });

  test("401 for invalid bearer token", async () => {
    const app = testApp({ password: "secret", sessionSecret: "s3cr3t" });
    const res = await app.request("/admin/test", {
      headers: { Authorization: "Bearer lca_invalid" },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("INVALID_ADMIN_TOKEN");
  });

  test("accepts valid session cookie", async () => {
    const config = { username: "admin", password: "secret", sessionSecret: "s3cr3t" };
    process.env.ADMIN_PASSWORD = config.password;
    process.env.SESSION_SECRET = config.sessionSecret;

    // Create a mini app to set the cookie
    const loginApp = new Hono();
    loginApp.get("/set", async (c) => {
      await createSession(c, config);
      return c.text("ok");
    });
    loginApp.use("*", requireAdmin());
    loginApp.get("/admin/test", (c) => c.text("protected"));

    // First get the cookie
    const loginRes = await loginApp.request("/set");
    const cookies = loginRes.headers.getSetCookie();
    expect(cookies.length).toBeGreaterThan(0);

    // Then use it to access protected route
    const cookieHeader = cookies.map((c) => c.split(";")[0]).join("; ");
    const res = await loginApp.request("/admin/test", {
      headers: { Cookie: cookieHeader },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("protected");
  });
});
