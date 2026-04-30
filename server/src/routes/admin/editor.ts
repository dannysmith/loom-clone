import { zValidator } from "@hono/zod-validator";
import { readFileSync } from "fs";
import { Hono } from "hono";
import { raw } from "hono/html";
import { join } from "path";
import { z } from "zod";
import { applyEdits } from "../../lib/edit-pipeline";
import { serveFileWithRange } from "../../lib/file-serve";
import { PUBLIC_ROOT } from "../../lib/static-assets";
import { DATA_DIR } from "../../lib/store";
import { type AdminEnv, requireVideo } from "./helpers";

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

const editor = new Hono<AdminEnv>();

// --- Editor page (serves the React shell) ---
editor.get("/:id/editor", async (c) => {
  const result = await requireVideo(c);
  if (result instanceof Response) return result;
  const video = result;

  let scripts: string;
  const manifestPath = join(PUBLIC_ROOT, "editor", ".vite", "manifest.json");
  const manifestExists = await Bun.file(manifestPath).exists();

  if (manifestExists) {
    // Production: load built assets from the Vite manifest.
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as Record<
      string,
      { file: string; css?: string[] }
    >;
    const entry = manifest["index.html"];
    const css = (entry?.css ?? [])
      .map((f: string) => `<link rel="stylesheet" href="/static/editor/${f}">`)
      .join("\n    ");
    scripts = `${css}\n    <script type="module" src="/static/editor/${entry?.file}"></script>`;
  } else {
    // Dev: load from Vite dev server for HMR.
    scripts = [
      '<script type="module" src="http://localhost:5173/static/editor/@vite/client"></script>',
      '<script type="module" src="http://localhost:5173/static/editor/src/main.tsx"></script>',
    ].join("\n    ");
  }

  const title = escapeAttr(video.title || video.slug);

  return c.html(
    raw(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Editor &middot; ${title}</title>
  <link rel="stylesheet" href="/static/styles/app.css">
  ${scripts}
</head>
<body>
  <div id="editor-root"
    data-video-id="${video.id}"
    data-video-slug="${escapeAttr(video.slug)}"
    data-video-duration="${video.durationSeconds ?? 0}"
    data-video-title="${title}"
    data-video-height="${video.height ?? 0}"
  ></div>
</body>
</html>`),
  );
});

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
