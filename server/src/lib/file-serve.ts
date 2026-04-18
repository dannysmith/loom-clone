import type { Context } from "hono";

// Range-aware static file serving. Hono's built-in `serveStatic` doesn't
// honor HTTP Range, which breaks MP4 scrubbing in the browser (player asks
// for a byte range to seek; server returns the whole file with 200; player
// restarts from the beginning).
//
// `routes/site/data.ts` has its own copy of this logic that goes away in
// Phase 6.5; the new slug-namespaced media routes use this helper.

export async function serveFileWithRange(
  c: Context,
  absPath: string,
  contentType: string,
): Promise<Response> {
  const file = Bun.file(absPath);
  if (!(await file.exists())) return c.text("Not found", 404);
  const size = file.size;

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
}

// Parses a single-range Range header against a known file size. Returns
// null for malformed ranges or ranges outside the file (caller maps to 416).
// Multi-range requests are not supported — single-range covers browser seeking.
export function parseRange(header: string, size: number): { start: number; end: number } | null {
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
