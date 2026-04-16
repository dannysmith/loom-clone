import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { _resetForTests } from "./lib/store";

// Each test case gets its own temp directory used as the server's working
// directory. Because `DATA_DIR` is a relative path ("data"), chdir'ing into
// the temp dir redirects every filesystem read/write the store and routes do
// to an isolated sandbox. No mocks, no fixtures shared across tests.

export interface TestEnv {
  tempDir: string;
  originalCwd: string;
}

export async function setupTestEnv(): Promise<TestEnv> {
  const tempDir = await mkdtemp(join(tmpdir(), "loom-clone-test-"));
  const originalCwd = process.cwd();
  process.chdir(tempDir);
  _resetForTests();
  return { tempDir, originalCwd };
}

export async function teardownTestEnv(env: TestEnv): Promise<void> {
  process.chdir(env.originalCwd);
  await rm(env.tempDir, { recursive: true, force: true });
  _resetForTests();
}
