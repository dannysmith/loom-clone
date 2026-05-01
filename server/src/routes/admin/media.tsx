import { Hono } from "hono";
import { join } from "path";
import { serveFileWithRange } from "../../lib/file-serve";
import { DATA_DIR } from "../../lib/store";
import { type AdminEnv, requireVideo } from "./helpers";

const media = new Hono<AdminEnv>();

const RAW_FILENAME = /^(source|\d+p)\.mp4$/;
const STREAM_FILENAME = /^(stream\.m3u8|init\.mp4|seg_\d+\.m4s)$/;

media.get("/:id/media/raw/:file", async (c) => {
  const file = c.req.param("file");
  if (!RAW_FILENAME.test(file)) return c.text("Not found", 404);
  const result = await requireVideo(c);
  if (result instanceof Response) return result;
  return serveFileWithRange(
    c,
    join(DATA_DIR, result.id, "derivatives", file),
    "video/mp4",
    "immutable",
  );
});

media.get("/:id/media/stream/:file", async (c) => {
  const file = c.req.param("file");
  if (!STREAM_FILENAME.test(file)) return c.text("Not found", 404);
  const result = await requireVideo(c);
  if (result instanceof Response) return result;
  const contentType = file.endsWith(".m3u8")
    ? "application/vnd.apple.mpegurl"
    : file.endsWith(".m4s")
      ? "video/iso.segment"
      : "video/mp4";
  const cache = file.endsWith(".m3u8") ? ("short" as const) : ("immutable" as const);
  return serveFileWithRange(c, join(DATA_DIR, result.id, file), contentType, cache);
});

media.get("/:id/media/poster.jpg", async (c) => {
  const result = await requireVideo(c);
  if (result instanceof Response) return result;
  return serveFileWithRange(
    c,
    join(DATA_DIR, result.id, "derivatives", "thumbnail.jpg"),
    "image/jpeg",
    "immutable",
  );
});

// Serve thumbnail candidate images for the admin picker.
const CANDIDATE_FILENAME = /^(auto-\d{2}|custom-\d{8}T\d{9}Z)\.jpg$/;

media.get("/:id/media/thumbnail-candidates/:file", async (c) => {
  const file = c.req.param("file");
  if (!CANDIDATE_FILENAME.test(file)) return c.text("Not found", 404);
  const result = await requireVideo(c);
  if (result instanceof Response) return result;
  return serveFileWithRange(
    c,
    join(DATA_DIR, result.id, "derivatives", "thumbnail-candidates", file),
    "image/jpeg",
    "short",
  );
});

export default media;
