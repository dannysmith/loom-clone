import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { join } from "path";
import { z } from "zod";
import { applyEdits } from "../../lib/edit-pipeline";
import { serveFileWithRange } from "../../lib/file-serve";
import { DATA_DIR } from "../../lib/store";
import { type AdminEnv, requireVideo } from "./helpers";

const editor = new Hono<AdminEnv>();

// --- Load EDL ---
// Returns the current edit decision list, or a default empty one if no edits exist.
editor.get("/:id/editor/edl", async (c) => {
  const result = await requireVideo(c);
  if (result instanceof Response) return result;
  const edlPath = join(DATA_DIR, result.id, "derivatives", "edits.json");
  const file = Bun.file(edlPath);
  if (!(await file.exists())) {
    return c.json({ version: 1, source: "source.mp4", edits: [] });
  }
  return c.json(await file.json());
});

// --- Save EDL (without committing / processing) ---
const edlSchema = z.object({
  version: z.literal(1),
  source: z.string(),
  edits: z.array(
    z.object({
      type: z.enum(["trim", "cut"]),
      startTime: z.number().min(0),
      endTime: z.number().min(0),
    }),
  ),
});

editor.put(
  "/:id/editor/edl",
  zValidator("json", edlSchema, (result, c) => {
    if (!result.success) return c.json({ error: result.error.message }, 400);
  }),
  async (c) => {
    const result = await requireVideo(c);
    if (result instanceof Response) return result;
    const edl = c.req.valid("json");

    const derivDir = join(DATA_DIR, result.id, "derivatives");
    const { mkdir, rename: fsRename } = await import("fs/promises");
    await mkdir(derivDir, { recursive: true });
    const tmpPath = join(derivDir, "edits.json.tmp");
    const finalPath = join(derivDir, "edits.json");
    await Bun.write(tmpPath, JSON.stringify(edl, null, 2));
    await fsRename(tmpPath, finalPath);

    return c.json({ ok: true });
  },
);

// --- Commit edits (trigger processing) ---
editor.post("/:id/editor/commit", async (c) => {
  const result = await requireVideo(c);
  if (result instanceof Response) return result;

  const edlPath = join(DATA_DIR, result.id, "derivatives", "edits.json");
  const file = Bun.file(edlPath);
  if (!(await file.exists())) {
    return c.json({ error: "No edits.json found — save edits first" }, 400);
  }

  applyEdits(result.id);

  return c.json({ ok: true, status: "processing" });
});

// --- Editor media files ---
const EDITOR_FILENAME = /^(editor-storyboard\.(jpg|vtt)|peaks\.json|words\.json|edits\.json)$/;

editor.get("/:id/editor/media/:file", async (c) => {
  const file = c.req.param("file");
  if (!EDITOR_FILENAME.test(file)) return c.text("Not found", 404);
  const result = await requireVideo(c);
  if (result instanceof Response) return result;

  const contentType = file.endsWith(".jpg")
    ? "image/jpeg"
    : file.endsWith(".vtt")
      ? "text/vtt"
      : "application/json";

  return serveFileWithRange(
    c,
    join(DATA_DIR, result.id, "derivatives", file),
    contentType,
    "short",
  );
});

export default editor;
