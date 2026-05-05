import { getSqlite } from "../db/client";

// Sets up the FTS5 virtual table and triggers. Idempotent — safe to call on
// every startup. The table is standalone (not content-linked) so it stores
// its own copy of the indexed text. Triggers keep it in sync with the videos
// table automatically.
//
// The `transcript` column is populated separately by updateFtsTranscript()
// when a transcript is uploaded — video triggers only touch the video-owned
// columns (title, description, slug).
export function setupFts(): void {
  const db = getSqlite();

  // Schema migration: if the old FTS table is missing columns, drop and
  // recreate. FTS5 virtual tables don't support ALTER TABLE ADD COLUMN.
  const cols = db.prepare("SELECT * FROM pragma_table_info('videos_fts')").all() as Array<{
    name: string;
  }>;
  if (
    cols.length > 0 &&
    (!cols.some((c) => c.name === "transcript") || !cols.some((c) => c.name === "notes"))
  ) {
    db.exec("DROP TABLE IF EXISTS videos_fts");
    // Drop old triggers that reference the old schema.
    db.exec("DROP TRIGGER IF EXISTS videos_fts_ai");
    db.exec("DROP TRIGGER IF EXISTS videos_fts_au");
    db.exec("DROP TRIGGER IF EXISTS videos_fts_ad");
  }

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS videos_fts USING fts5(
      video_id UNINDEXED,
      title,
      description,
      slug,
      transcript,
      notes
    );
  `);

  // Triggers to keep FTS in sync. Use INSERT OR IGNORE / safe patterns
  // since the FTS table may already have rows from a previous run.

  // After inserting a video, add it to the FTS index.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS videos_fts_ai AFTER INSERT ON videos BEGIN
      INSERT INTO videos_fts(video_id, title, description, slug, transcript, notes)
      VALUES (NEW.id, NEW.title, NEW.description, NEW.slug, '', COALESCE(NEW.notes, ''));
    END;
  `);

  // After updating a video, preserve the transcript column value.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS videos_fts_au AFTER UPDATE ON videos BEGIN
      DELETE FROM videos_fts WHERE video_id = OLD.id;
      INSERT INTO videos_fts(video_id, title, description, slug, transcript, notes)
      VALUES (
        NEW.id, NEW.title, NEW.description, NEW.slug,
        COALESCE((SELECT plain_text FROM video_transcripts WHERE video_id = NEW.id), ''),
        COALESCE(NEW.notes, '')
      );
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
    INSERT INTO videos_fts(video_id, title, description, slug, transcript, notes)
    SELECT v.id, v.title, v.description, v.slug,
           COALESCE(vt.plain_text, ''),
           COALESCE(v.notes, '')
    FROM videos v
    LEFT JOIN video_transcripts vt ON vt.video_id = v.id
    WHERE v.id NOT IN (SELECT video_id FROM videos_fts);
  `);
}

// Updates just the transcript column in the FTS index for a given video.
// Called when a transcript is uploaded or replaced.
export function updateFtsTranscript(videoId: string, transcript: string): void {
  const db = getSqlite();
  // Read the current FTS row, update with the new transcript text.
  const existing = db
    .prepare("SELECT title, description, slug, notes FROM videos_fts WHERE video_id = ?")
    .get(videoId) as
    | { title: string; description: string; slug: string; notes: string }
    | undefined;
  if (!existing) return;
  db.prepare("DELETE FROM videos_fts WHERE video_id = ?").run(videoId);
  db.prepare(
    "INSERT INTO videos_fts(video_id, title, description, slug, transcript, notes) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(videoId, existing.title, existing.description, existing.slug, transcript, existing.notes);
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
