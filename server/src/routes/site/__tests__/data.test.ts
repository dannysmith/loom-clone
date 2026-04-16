import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "fs/promises";
import { join } from "path";
import { setupTestEnv, type TestEnv, teardownTestEnv } from "../../../test-utils";
import data, { parseRange } from "../data";

let env: TestEnv;

beforeEach(async () => {
  env = await setupTestEnv();
});

afterEach(async () => {
  await teardownTestEnv(env);
});

// Writes a file under data/<subpath> with the given contents.
async function writeDataFile(subpath: string, contents: string | Uint8Array): Promise<void> {
  const fullPath = join("data", subpath);
  await mkdir(join(fullPath, ".."), { recursive: true });
  await Bun.write(fullPath, contents);
}

describe("parseRange", () => {
  test("returns null for unparseable header", () => {
    expect(parseRange("items=0-100", 1000)).toBeNull();
    expect(parseRange("bytes=abc", 1000)).toBeNull();
  });

  test("parses a normal range", () => {
    expect(parseRange("bytes=0-99", 1000)).toEqual({ start: 0, end: 99 });
  });

  test("open-ended range goes to end of file", () => {
    expect(parseRange("bytes=500-", 1000)).toEqual({ start: 500, end: 999 });
  });

  test("suffix range returns the last N bytes", () => {
    expect(parseRange("bytes=-100", 1000)).toEqual({ start: 900, end: 999 });
  });

  test("suffix range larger than file size clamps to 0", () => {
    expect(parseRange("bytes=-5000", 1000)).toEqual({ start: 0, end: 999 });
  });

  test("returns null for start > end", () => {
    expect(parseRange("bytes=500-100", 1000)).toBeNull();
  });

  test("returns null when end >= size", () => {
    expect(parseRange("bytes=0-1000", 1000)).toBeNull();
  });
});

describe("/data/* handler", () => {
  test("returns 404 for missing file", async () => {
    const res = await data.request("/data/nope.txt");
    expect(res.status).toBe(404);
  });

  test("returns 404 for path traversal attempts", async () => {
    const res = await data.request("/data/../../../etc/passwd");
    expect(res.status).toBe(404);
  });

  test("serves file with correct MIME type for .m3u8", async () => {
    await writeDataFile("v1/stream.m3u8", "#EXTM3U\n");
    const res = await data.request("/data/v1/stream.m3u8");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/vnd.apple.mpegurl");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(await res.text()).toBe("#EXTM3U\n");
  });

  test("serves file with correct MIME type for .m4s", async () => {
    await writeDataFile("v1/seg.m4s", new Uint8Array([0, 1, 2, 3]));
    const res = await data.request("/data/v1/seg.m4s");
    expect(res.headers.get("content-type")).toBe("video/iso.segment");
  });

  test("falls back to octet-stream for unknown extension", async () => {
    await writeDataFile("v1/blob.xyz", "data");
    const res = await data.request("/data/v1/blob.xyz");
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
  });

  test("full GET returns 200 with content-length and accept-ranges", async () => {
    await writeDataFile("v1/source.mp4", "x".repeat(100));
    const res = await data.request("/data/v1/source.mp4");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("100");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
  });

  test("Range request returns 206 with correct Content-Range and body slice", async () => {
    await writeDataFile("v1/source.mp4", "0123456789");
    const res = await data.request("/data/v1/source.mp4", {
      headers: { Range: "bytes=2-5" },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(res.headers.get("content-length")).toBe("4");
    expect(await res.text()).toBe("2345");
  });

  test("suffix Range request works", async () => {
    await writeDataFile("v1/source.mp4", "0123456789");
    const res = await data.request("/data/v1/source.mp4", {
      headers: { Range: "bytes=-3" },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 7-9/10");
    expect(await res.text()).toBe("789");
  });

  test("invalid Range returns 416", async () => {
    await writeDataFile("v1/source.mp4", "0123456789");
    const res = await data.request("/data/v1/source.mp4", {
      headers: { Range: "bytes=abc" },
    });
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe("bytes */10");
  });

  test("Range exceeding file size returns 416", async () => {
    await writeDataFile("v1/source.mp4", "0123456789");
    const res = await data.request("/data/v1/source.mp4", {
      headers: { Range: "bytes=0-999" },
    });
    expect(res.status).toBe(416);
  });
});
