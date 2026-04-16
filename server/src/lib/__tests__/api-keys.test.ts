import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { setupTestEnv, type TestEnv, teardownTestEnv } from "../../test-utils";
import { createApiKey, hashToken, listApiKeys, revokeApiKey, verifyApiKey } from "../api-keys";

let env: TestEnv;

beforeEach(async () => {
  env = await setupTestEnv();
});

afterEach(async () => {
  await teardownTestEnv(env);
});

describe("createApiKey", () => {
  test("returns a prefixed plaintext token and a uuid id", async () => {
    const { id, plaintext } = await createApiKey("macbook");
    expect(plaintext.startsWith("lck_")).toBe(true);
    // base64url body of 32 bytes is 43 chars; total = 4 + 43.
    expect(plaintext.length).toBe(47);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("never stores plaintext — only the hash", async () => {
    const { plaintext } = await createApiKey("macbook");
    const [row] = await listApiKeys();
    expect(row?.hashedToken).toBe(hashToken(plaintext));
    expect(row?.hashedToken).not.toBe(plaintext);
  });

  test("each call produces a fresh, unique token", async () => {
    const a = await createApiKey("a");
    const b = await createApiKey("b");
    expect(a.plaintext).not.toBe(b.plaintext);
  });
});

describe("verifyApiKey", () => {
  test("returns the row for a valid token", async () => {
    const { id, plaintext } = await createApiKey("macbook");
    const row = await verifyApiKey(plaintext);
    expect(row?.id).toBe(id);
  });

  test("returns null for unknown tokens", async () => {
    expect(await verifyApiKey("lck_doesnotexist")).toBeNull();
  });

  test("rejects tokens without the lck_ prefix without hitting the db", async () => {
    expect(await verifyApiKey("not-a-key")).toBeNull();
    expect(await verifyApiKey("Bearer lck_xxx")).toBeNull();
  });

  test("returns null for revoked tokens", async () => {
    const { id, plaintext } = await createApiKey("macbook");
    await revokeApiKey(id);
    expect(await verifyApiKey(plaintext)).toBeNull();
  });
});

describe("revokeApiKey", () => {
  test("returns true on first revoke, false on second", async () => {
    const { id } = await createApiKey("macbook");
    expect(await revokeApiKey(id)).toBe(true);
    expect(await revokeApiKey(id)).toBe(false);
  });

  test("returns false for unknown id", async () => {
    expect(await revokeApiKey("00000000-0000-0000-0000-000000000000")).toBe(false);
  });

  test("does not refresh revokedAt on a second call", async () => {
    const { id } = await createApiKey("macbook");
    await revokeApiKey(id);
    const [first] = await listApiKeys();
    const stamp1 = first?.revokedAt;
    await revokeApiKey(id);
    const [second] = await listApiKeys();
    expect(second?.revokedAt).toBe(stamp1 ?? null);
  });
});

describe("listApiKeys", () => {
  test("returns keys newest-first", async () => {
    await createApiKey("first");
    // Force a microsecond gap so createdAt ordering is deterministic.
    await new Promise((r) => setTimeout(r, 5));
    await createApiKey("second");
    const keys = await listApiKeys();
    expect(keys.map((k) => k.name)).toEqual(["second", "first"]);
  });
});
