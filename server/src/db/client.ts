import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { mkdir } from "fs/promises";
import { dirname, resolve } from "path";
import { setupFts } from "../lib/search";
import * as schema from "./schema";

export type Db = ReturnType<typeof drizzle<typeof schema>>;

// Default path (relative so tests that chdir into a temp dir get their own
// copy automatically). `:memory:` is a sentinel that bun:sqlite honours.
const DEFAULT_DB_PATH = "data/app.db";
// Migrations folder resolved absolutely so it stays valid even when callers
// chdir (e.g. tests sandboxing into a tmpdir).
const MIGRATIONS_FOLDER = resolve(import.meta.dir, "../../drizzle");

// Opens a SQLite database at `path` (or in-memory for `:memory:`), enables
// foreign-key enforcement, wraps it in a Drizzle instance, and applies any
// pending migrations. Used for both production startup and per-test setup.
export async function createDb(
  path: string = DEFAULT_DB_PATH,
): Promise<{ db: Db; sqlite: Database }> {
  if (path !== ":memory:") {
    await mkdir(dirname(path), { recursive: true });
  }
  const sqlite = new Database(path, { create: true });
  // SQLite ignores ON DELETE CASCADE unless this is set per connection.
  sqlite.exec("PRAGMA foreign_keys = ON");
  // WAL mode allows concurrent readers + writers without SQLITE_BUSY errors.
  sqlite.exec("PRAGMA journal_mode = WAL");
  const db = drizzle(sqlite, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { db, sqlite };
}

// Mutable container so tests can swap in a fresh :memory: instance per test
// without restructuring every store function to take an explicit db argument.
let current: Db | null = null;
let currentSqlite: Database | null = null;

export function getDb(): Db {
  if (!current) {
    throw new Error("db not initialised — call initDb() at startup or setDbForTests() in tests");
  }
  return current;
}

// Raw bun:sqlite Database for operations Drizzle doesn't support (e.g. FTS5).
export function getSqlite(): Database {
  if (!currentSqlite) {
    throw new Error("db not initialised — call initDb() at startup or setDbForTests() in tests");
  }
  return currentSqlite;
}

export async function initDb(path: string = DEFAULT_DB_PATH): Promise<Db> {
  const { db, sqlite } = await createDb(path);
  current = db;
  currentSqlite = sqlite;
  setupFts();
  return db;
}

// Test-only: swap the active db instance. Pair with teardown that resets it.
export function _setDbForTests(db: Db | null, sqlite: Database | null = null): void {
  current = db;
  currentSqlite = sqlite;
  if (sqlite) setupFts();
}
