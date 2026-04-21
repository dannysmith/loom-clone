import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { _setDbForTests, createDb } from "./db/client";
import { createApiKey } from "./lib/api-keys";

// Each test case gets its own temp directory used as the server's working
// directory. Because `DATA_DIR` is a relative path ("data"), chdir'ing into
// the temp dir redirects every filesystem read/write the store and routes do
// to an isolated sandbox. The database is a fresh in-memory SQLite instance
// so state never leaks between tests.

export interface TestEnv {
  tempDir: string;
  originalCwd: string;
}

export async function setupTestEnv(): Promise<TestEnv> {
  const tempDir = await mkdtemp(join(tmpdir(), "loom-clone-test-"));
  const originalCwd = process.cwd();
  process.chdir(tempDir);
  const { db, sqlite } = await createDb(":memory:");
  _setDbForTests(db, sqlite);
  return { tempDir, originalCwd };
}

export async function teardownTestEnv(env: TestEnv): Promise<void> {
  _setDbForTests(null, null);
  process.chdir(env.originalCwd);
  await rm(env.tempDir, { recursive: true, force: true });
}

// Convenience for integration tests that hit the full app through createApp:
// creates a key in the current test DB and returns the headers needed to
// pass the auth middleware. Pair with `app.request(path, { headers: await
// authHeaders() })`.
export async function createTestApiKey(name = "test"): Promise<{ id: string; token: string }> {
  const { id, plaintext } = await createApiKey(name);
  return { id, token: plaintext };
}

export async function authHeaders(name = "test"): Promise<Record<string, string>> {
  const { token } = await createTestApiKey(name);
  return { Authorization: `Bearer ${token}` };
}
