import { index, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Timestamps are ISO-8601 text (from `new Date().toISOString()`) rather than
// SQLite CURRENT_TIMESTAMP, because CURRENT_TIMESTAMP returns naive UTC
// ("YYYY-MM-DD HH:MM:SS" with no Z suffix) which `new Date(...)` parses as
// local time in JS — a timezone bug waiting to happen. Application-side
// ISO defaults keep the format consistent across every write path.
const nowIso = (): string => new Date().toISOString();

// Note on enums: `{ enum: [...] }` is a TypeScript-level constraint, not a
// SQL CHECK constraint. SQLite will accept any string; the store layer is
// responsible for only writing valid values. Good enough for a single-user
// personal tool.

export const videos = sqliteTable(
  "videos",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull().unique(),
    status: text("status", { enum: ["recording", "healing", "complete", "failed"] })
      .notNull()
      .default("recording"),
    visibility: text("visibility", { enum: ["public", "unlisted", "private"] })
      .notNull()
      .default("unlisted"),
    title: text("title"),
    description: text("description"),
    // Cached at completion so list views don't need to sum segment durations.
    durationSeconds: real("duration_seconds"),
    // Metadata columns populated by the post-processing pipeline (ffprobe + recording.json).
    width: integer("width"),
    height: integer("height"),
    aspectRatio: real("aspect_ratio"),
    fileBytes: integer("file_bytes"),
    cameraName: text("camera_name"),
    microphoneName: text("microphone_name"),
    recordingHealth: text("recording_health"),
    source: text("source", { enum: ["recorded", "uploaded"] })
      .notNull()
      .default("recorded"),
    createdAt: text("created_at").notNull().$defaultFn(nowIso),
    updatedAt: text("updated_at").notNull().$defaultFn(nowIso),
    // Set on first transition to `complete` and not overwritten on re-complete.
    completedAt: text("completed_at"),
    trashedAt: text("trashed_at"),
  },
  (t) => [
    index("videos_trashed_at_idx").on(t.trashedAt),
    index("videos_created_at_idx").on(t.createdAt),
  ],
);

// Replaces the old segments.json sidecar. Durations come from the client's
// x-segment-duration header on upload; on-disk presence remains the source
// of truth for whether a segment is actually playable.
export const videoSegments = sqliteTable(
  "video_segments",
  {
    videoId: text("video_id")
      .notNull()
      .references(() => videos.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    durationSeconds: real("duration_seconds").notNull(),
    uploadedAt: text("uploaded_at").notNull().$defaultFn(nowIso),
  },
  (t) => [primaryKey({ columns: [t.videoId, t.filename] })],
);

// Permanent-URL requirement: renaming a slug inserts the old slug here.
// Lookup order at the viewer route is videos.slug → slug_redirects.old_slug
// → 301 to current slug.
export const slugRedirects = sqliteTable(
  "slug_redirects",
  {
    oldSlug: text("old_slug").primaryKey(),
    videoId: text("video_id")
      .notNull()
      .references(() => videos.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull().$defaultFn(nowIso),
  },
  (t) => [index("slug_redirects_video_id_idx").on(t.videoId)],
);

// Palette names for the `color` column. Stored as readable strings (not hex)
// so they're meaningful in queries and event logs. CSS maps these to actual
// OKLCH values via custom properties. The constraint is application-side
// (same pattern as status/visibility enums).
export const TAG_COLORS = [
  "gray",
  "red",
  "orange",
  "yellow",
  "green",
  "teal",
  "blue",
  "indigo",
  "purple",
  "pink",
] as const;
export type TagColor = (typeof TAG_COLORS)[number];

export const tags = sqliteTable("tags", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  color: text("color").notNull().default("gray"),
  createdAt: text("created_at").notNull().$defaultFn(nowIso),
});

export const videoTags = sqliteTable(
  "video_tags",
  {
    videoId: text("video_id")
      .notNull()
      .references(() => videos.id, { onDelete: "cascade" }),
    tagId: integer("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.videoId, t.tagId] }),
    // The composite PK covers (video_id, tag_id) queries by prefix; this
    // index handles the reverse lookup (all videos for a given tag).
    index("video_tags_tag_id_idx").on(t.tagId),
  ],
);

// Audit log for interesting events. Per-segment uploads are deliberately
// NOT logged here — 150 events per recording would drown out the signal.
// `type` is an open string (not an enum) so we can add new event types
// without a migration. `data` is JSON text.
export const videoEvents = sqliteTable(
  "video_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    videoId: text("video_id")
      .notNull()
      .references(() => videos.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    data: text("data"),
    createdAt: text("created_at").notNull().$defaultFn(nowIso),
  },
  (t) => [index("video_events_video_id_created_at_idx").on(t.videoId, t.createdAt)],
);

// API keys — bearer tokens for the macOS app and any future programmatic
// clients. Plaintext is never stored: `hashedToken` holds sha256(token).
// `name` is a human label ("macbook M2 Pro") to make `keys:list` useful.
// The unique constraint on hashed_token doubles as the lookup index.
export const apiKeys = sqliteTable("api_keys", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  hashedToken: text("hashed_token").notNull().unique(),
  createdAt: text("created_at").notNull().$defaultFn(nowIso),
  lastUsedAt: text("last_used_at"),
  revokedAt: text("revoked_at"),
});

// Admin tokens — bearer tokens for admin API access (scripting, automation).
// Separate system from the macOS app's `lck_` recording API keys: different
// table, different prefix (`lca_`), different security boundary.
export const adminTokens = sqliteTable("admin_tokens", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  hashedToken: text("hashed_token").notNull().unique(),
  createdAt: text("created_at").notNull().$defaultFn(nowIso),
  lastUsedAt: text("last_used_at"),
  revokedAt: text("revoked_at"),
});

// Inferred types — export for use in store and routes.
export type Video = typeof videos.$inferSelect;
export type VideoInsert = typeof videos.$inferInsert;
export type VideoSegment = typeof videoSegments.$inferSelect;
export type SlugRedirect = typeof slugRedirects.$inferSelect;
export type Tag = typeof tags.$inferSelect;
export type VideoTag = typeof videoTags.$inferSelect;
export type VideoEvent = typeof videoEvents.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type AdminToken = typeof adminTokens.$inferSelect;
