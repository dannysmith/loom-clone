// Admin CRUD for chapters. Chapters live in `data/<id>/chapters.json` with
// timestamps in the ORIGINAL recording timeline. The UI works in the viewer
// timeline (post-edits, if any), so this module remaps incoming/outgoing
// times through the EDL transparently.

import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { join } from "path";
import { z } from "zod";
import { purgeVideo } from "../../lib/cdn";
import {
  backwardMapTime,
  chaptersForViewer,
  readChapters,
  writeChapters,
} from "../../lib/chapters";
import { computeKeptSegments, type Edit } from "../../lib/edit-transcript";
import { logEvent } from "../../lib/events";
import { DATA_DIR } from "../../lib/store";
import { type AdminEnv, requireVideo } from "./helpers";

const chapters = new Hono<AdminEnv>();

type EditsFileLike = { edits?: unknown };

// Reads the EDL (if any) and computes kept segments. Returns null when no
// edits are applied — callers should treat that as "viewer timeline === source timeline".
async function loadEdlKeptSegments(
  videoId: string,
  sourceDuration: number,
): Promise<{ edits: Edit[]; keptSegments: { start: number; end: number }[] } | null> {
  const file = Bun.file(join(DATA_DIR, videoId, "derivatives", "edits.json"));
  if (!(await file.exists())) return null;
  try {
    const parsed = (await file.json()) as EditsFileLike;
    if (!Array.isArray(parsed.edits) || parsed.edits.length === 0) return null;
    const edits = parsed.edits as Edit[];
    return { edits, keptSegments: computeKeptSegments(edits, sourceDuration) };
  } catch {
    return null;
  }
}

// --- Load chapters (viewer timeline) ---
chapters.get("/:id/chapters", async (c) => {
  const result = await requireVideo(c);
  if (result instanceof Response) return result;
  const video = result;
  const data = await readChapters(video.id);
  if (!data) return c.json({ version: 1, chapters: [] });

  const sourceDuration = video.durationSeconds ?? 0;
  const edl = await loadEdlKeptSegments(video.id, sourceDuration);
  const mapped = edl
    ? chaptersForViewer(data.chapters, edl.edits, sourceDuration)
    : [...data.chapters].sort((a, b) => a.t - b.t);
  return c.json({ version: 1, chapters: mapped });
});

// --- Save chapters (bulk replace) ---
// UI sends times in the VIEWER timeline. Server reverse-maps to the
// recording timeline before persisting so `chapters.json` stays canonical.
const saveSchema = z.object({
  version: z.literal(1),
  chapters: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        title: z.string().trim().max(200).nullable(),
        t: z.number().min(0),
      }),
    )
    .max(100),
});

chapters.put(
  "/:id/chapters",
  zValidator("json", saveSchema, (result, c) => {
    if (!result.success) return c.json({ error: result.error.message }, 400);
  }),
  async (c) => {
    const result = await requireVideo(c);
    if (result instanceof Response) return result;
    const video = result;
    const body = c.req.valid("json");

    // Reject duplicate IDs — UI bugs that would otherwise produce ghost
    // chapters whose changes silently overwrite each other.
    const ids = new Set<string>();
    for (const ch of body.chapters) {
      if (ids.has(ch.id)) return c.json({ error: `Duplicate chapter id: ${ch.id}` }, 400);
      ids.add(ch.id);
    }

    const sourceDuration = video.durationSeconds ?? 0;
    const edl = await loadEdlKeptSegments(video.id, sourceDuration);

    // Preserve `createdDuringRecording` on chapters that already exist;
    // new chapters added via the UI default to false.
    const existing = await readChapters(video.id);
    const existingById = new Map(existing?.chapters.map((c) => [c.id, c]) ?? []);

    const normalised = body.chapters.map((ch) => {
      const recordingT = edl ? backwardMapTime(ch.t, edl.keptSegments) : ch.t;
      const prior = existingById.get(ch.id);
      return {
        id: ch.id,
        title: ch.title?.trim() ? ch.title.trim() : null,
        t: recordingT,
        createdDuringRecording: prior?.createdDuringRecording ?? false,
      };
    });

    await writeChapters(video.id, normalised);
    await logEvent(video.id, "chapters_updated", { count: normalised.length });
    purgeVideo(video.slug);

    return c.json({ ok: true, count: normalised.length });
  },
);

export default chapters;
