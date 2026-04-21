import { getSqlite } from "../db/client";

// Sets up the FTS5 virtual table and triggers. Idempotent — safe to call on
// every startup. The table is standalone (not content-linked) so it stores
// its own copy of the indexed text. Triggers keep it in sync with the videos
// table automatically.
export function setupFts(): void {
  const db = getSqlite();

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS videos_fts USING fts5(
      video_id UNINDEXED,
      title,
      description,
      slug
    );
  `);

  // Triggers to keep FTS in sync. Use INSERT OR IGNORE / safe patterns
  // since the FTS table may already have rows from a previous run.

  // After inserting a video, add it to the FTS index.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS videos_fts_ai AFTER INSERT ON videos BEGIN
      INSERT INTO videos_fts(video_id, title, description, slug)
      VALUES (NEW.id, NEW.title, NEW.description, NEW.slug);
    END;
  `);

  // After updating a video, delete old FTS row and insert new one.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS videos_fts_au AFTER UPDATE ON videos BEGIN
      DELETE FROM videos_fts WHERE video_id = OLD.id;
      INSERT INTO videos_fts(video_id, title, description, slug)
      VALUES (NEW.id, NEW.title, NEW.description, NEW.slug);
    END;
  `);

  // After deleting a video, remove from FTS index.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS videos_fts_ad AFTER DELETE ON videos BEGIN
      DELETE FROM videos_fts WHERE video_id = OLD.id;
    END;
  `);

  // Backfill: insert any videos that aren't in the FTS table yet.
  // This handles upgrading from a database that existed before FTS was added.
  db.exec(`
    INSERT INTO videos_fts(video_id, title, description, slug)
    SELECT id, title, description, slug FROM videos
    WHERE id NOT IN (SELECT video_id FROM videos_fts);
  `);
}

// Searches the FTS index and returns matching video IDs. The query is
// sanitized to prevent FTS5 syntax injection. Returns an empty array if
// the query is blank.
export function searchVideoIds(query: string): string[] {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const db = getSqlite();
  const ftsQuery = sanitizeFtsQuery(trimmed);
  if (!ftsQuery) return [];

  const stmt = db.prepare("SELECT video_id FROM videos_fts WHERE videos_fts MATCH ?");
  const rows = stmt.all(ftsQuery) as Array<{ video_id: string }>;
  return rows.map((r) => r.video_id);
}

// Escapes FTS5 special characters and wraps each word in quotes for exact
// prefix matching. "foo bar" becomes '"foo" * "bar" *' (each word with
// prefix matching via *). This gives intuitive search behavior: typing
// "hel" matches "hello", typing "hello wor" matches "hello world".
function sanitizeFtsQuery(raw: string): string {
  return raw
    .replace(/['"(){}[\]:^~!@#$%&|\\<>]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => `"${word}" *`)
    .join(" ");
}
