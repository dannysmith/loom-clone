// The 0015 data migration, run against a database shaped like the world before
// the presentation-master restructure.
//
// This is the one part of the migration that isn't purely additive — it rewrites
// existing ledger rows — so it gets tested against the real migration file
// rather than a reimplementation of what it should do. The backstop if it ever
// goes wrong is that the ledger is re-derivable from disk: see
// `videos:backfill-processing-steps`.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join, resolve } from "path";

const MIGRATIONS = resolve(import.meta.dir, "../../../drizzle");

function runMigration(db: Database, tag: string): void {
  const sql = readFileSync(join(MIGRATIONS, `${tag}.sql`), "utf8");
  for (const statement of sql.split("--> statement-breakpoint")) {
    const trimmed = statement.trim();
    if (trimmed) db.run(trimmed);
  }
}

// Apply every migration up to and including `through`, so the fixture is built
// by the same DDL production ran rather than by a hand-written CREATE TABLE.
function migrateThrough(db: Database, through: string): void {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS, "meta", "_journal.json"), "utf8")) as {
    entries: { tag: string }[];
  };
  for (const { tag } of journal.entries) {
    runMigration(db, tag);
    if (tag === through) return;
  }
}

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  // Everything up to the column being added, but NOT the data migration — that's
  // the state a production database is in the moment the new code deploys.
  migrateThrough(db, "0014_early_tarot");
});

afterEach(() => {
  db.close();
});

function addVideo(id: string, slug: string): void {
  db.run(
    "INSERT INTO videos (id, slug, status, visibility, created_at, updated_at, source, source_pristine) VALUES (?, ?, 'ready', 'unlisted', '2026-01-01', '2026-01-01', 'recorded', 1)",
    [id, slug],
  );
}

function addStep(videoId: string, kind: string, state: string): void {
  db.run(
    "INSERT INTO video_processing_steps (video_id, kind, state, updated_at) VALUES (?, ?, ?, '2026-01-01')",
    [videoId, kind, state],
  );
}

function applyDataMigration(): void {
  runMigration(db, "0015_presentation_master_ledger");
}

function steps(videoId: string): Record<string, string> {
  const rows = db
    .query("SELECT kind, state FROM video_processing_steps WHERE video_id = ?")
    .all(videoId) as { kind: string; state: string }[];
  return Object.fromEntries(rows.map((r) => [r.kind, r.state]));
}

function pristine(videoId: string): number {
  const row = db.query("SELECT source_pristine FROM videos WHERE id = ?").get(videoId) as {
    source_pristine: number;
  };
  return row.source_pristine;
}

describe("0015 — presentation master ledger migration", () => {
  test("a video whose audio step ran is marked non-pristine", () => {
    addVideo("v1", "processed");
    addStep("v1", "source", "ready");
    addStep("v1", "audio", "ready");

    applyDataMigration();

    // Its source.mp4 has the chain written into it, so the chain must never run
    // over that audio again.
    expect(pristine("v1")).toBe(0);
    expect(steps("v1").audio).toBeUndefined();
  });

  test("a skipped audio step leaves the source pristine", () => {
    // No audio track, or the model was missing — nothing was applied, so the
    // original is intact and a future chain can still run over it.
    addVideo("v2", "silent");
    addStep("v2", "source", "ready");
    addStep("v2", "audio", "skipped");

    applyDataMigration();

    expect(pristine("v2")).toBe(1);
    expect(steps("v2").audio).toBeUndefined();
  });

  test("a video with no audio row at all stays pristine", () => {
    addVideo("v3", "untouched");
    addStep("v3", "source", "ready");

    applyDataMigration();

    expect(pristine("v3")).toBe(1);
  });

  test("an edited video's edited_output becomes its presentation receipt", () => {
    // The {H}p.mp4 that `edited_output` produced is exactly what `presentation`
    // produces now, so the receipt carries over — the file on disk keeps serving
    // without being rebuilt.
    addVideo("v4", "edited");
    addStep("v4", "source", "ready");
    addStep("v4", "edited_output", "ready");
    addStep("v4", "audio", "ready");

    applyDataMigration();

    expect(steps("v4").presentation).toBe("ready");
    expect(steps("v4").edited_output).toBeUndefined();
    expect(pristine("v4")).toBe(0);
  });

  test("a failed edited_output carries its failure over rather than looking ready", () => {
    addVideo("v5", "broken-edit");
    addStep("v5", "edited_output", "failed");

    applyDataMigration();

    expect(steps("v5").presentation).toBe("failed");
  });

  test("videos are migrated independently", () => {
    addVideo("a", "one");
    addStep("a", "audio", "ready");
    addVideo("b", "two");
    addStep("b", "edited_output", "ready");
    addVideo("c", "three");

    applyDataMigration();

    expect(pristine("a")).toBe(0);
    expect(pristine("b")).toBe(1);
    expect(pristine("c")).toBe(1);
    expect(steps("b").presentation).toBe("ready");
  });
});
