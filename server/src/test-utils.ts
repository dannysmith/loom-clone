import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { _setDbForTests, createDb } from "./db/client";

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
  const db = await createDb(":memory:");
  _setDbForTests(db);
  return { tempDir, originalCwd };
}

export async function teardownTestEnv(env: TestEnv): Promise<void> {
  _setDbForTests(null);
  process.chdir(env.originalCwd);
  await rm(env.tempDir, { recursive: true, force: true });
}
