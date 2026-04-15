import { Hono } from "hono";
import { resolve, extname } from "path";
import videos from "./routes/videos";
import playback from "./routes/playback";
import { DATA_DIR, loadAllVideos } from "./lib/store";

const restored = await loadAllVideos();
console.log(`[store] rehydrated ${restored} video record(s) from data/`);

const app = new Hono();

// Health check — used by the desktop app to gate the Record button on
// server reachability. Cheap, no dependencies.
app.get("/api/health", (c) => c.json({ ok: true }));

// API routes
app.route("/api/videos", videos);

// Static file serving for /data. Hono's `serveStatic` doesn't honor
// HTTP Range requests, which breaks scrubbing in MP4 playback: the
// browser requests a byte range to seek, the server returns the whole
// file with 200 OK, and the player restarts from the beginning. This
// handler serves 206 Partial Content when a Range header is present
// and always advertises Accept-Ranges so the player knows seeking is
// supported.
const MIME_TYPES: Record<string, string> = {
  ".m3u8": "application/vnd.apple.mpegurl",
  ".m4s": "video/iso.segment",
  ".mp4": "video/mp4",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".json": "application/json",
};
const DATA_ROOT = resolve(DATA_DIR);
app.get("/data/*", async (c) => {
  const relPath = c.req.path.replace(/^\/data\//, "");
  // Resolve + guard against path traversal. After resolve() the path
  // must still live under DATA_ROOT, otherwise refuse.
  const absPath = resolve(DATA_ROOT, relPath);
  if (!absPath.startsWith(DATA_ROOT + "/") && absPath !== DATA_ROOT) {
    return c.text("Not found", 404);
  }
  const file = Bun.file(absPath);
  if (!(await file.exists())) return c.text("Not found", 404);
  const size = file.size;
  const contentType = MIME_TYPES[extname(absPath).toLowerCase()] ?? "application/octet-stream";

  const range = c.req.header("range");
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) {
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${size}` },
      });
    }
    const startStr = match[1];
    const endStr = match[2];
    let start: number;
    let end: number;
    if (startStr === "") {
      // Suffix range: last N bytes.
      const suffix = parseInt(endStr, 10);
      start = Math.max(0, size - suffix);
      end = size - 1;
    } else {
      start = parseInt(startStr, 10);
      end = endStr === "" ? size - 1 : parseInt(endStr, 10);
    }
    if (isNaN(start) || isNaN(end) || start > end || end >= size) {
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${size}` },
      });
    }
    // Bun.file.slice returns a BunFile whose body streams just the
    // requested bytes — no full read into memory.
    return new Response(file.slice(start, end + 1), {
      status: 206,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(end - start + 1),
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Accept-Ranges": "bytes",
      },
    });
  }

  return new Response(file, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(size),
      "Accept-Ranges": "bytes",
    },
  });
});

// Video playback pages
app.route("/", playback);

console.log("Server running at http://localhost:3000");

export default {
  port: 3000,
  fetch: app.fetch,
};
