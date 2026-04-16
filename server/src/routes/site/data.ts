import { Hono } from "hono";
import { extname, resolve } from "path";
import { DATA_DIR } from "../../lib/store";

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

const data = new Hono();

data.get("/data/*", async (c) => {
  const relPath = c.req.path.replace(/^\/data\//, "");
  // Resolve + guard against path traversal. After resolve() the path
  // must still live under DATA_ROOT, otherwise refuse. Resolved lazily
  // so that tests (which chdir into a temp dir) get the right root.
  const dataRoot = resolve(DATA_DIR);
  const absPath = resolve(dataRoot, relPath);
  if (!absPath.startsWith(`${dataRoot}/`) && absPath !== dataRoot) {
    return c.text("Not found", 404);
  }
  const file = Bun.file(absPath);
  if (!(await file.exists())) return c.text("Not found", 404);
  const size = file.size;
  const contentType = MIME_TYPES[extname(absPath).toLowerCase()] ?? "application/octet-stream";

  const range = c.req.header("range");
  if (range) {
    const parsed = parseRange(range, size);
    if (!parsed) {
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${size}` },
      });
    }
    const { start, end } = parsed;
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

// Parses a single-range Range header against a known file size. Returns
// null for malformed ranges or ranges outside the file, which map to a 416.
// Multi-range requests are not supported — single-range covers browser seeking.
function parseRange(header: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match) return null;
  const [, startStr = "", endStr = ""] = match;

  let start: number;
  let end: number;
  if (startStr === "") {
    // Suffix range: last N bytes.
    const suffix = Number.parseInt(endStr, 10);
    if (Number.isNaN(suffix)) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number.parseInt(startStr, 10);
    end = endStr === "" ? size - 1 : Number.parseInt(endStr, 10);
  }
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= size) {
    return null;
  }
  return { start, end };
}

export default data;
export { parseRange };
