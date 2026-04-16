import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "path";
import { DATA_DIR, getVideo } from "../../lib/store";
import { setupTestEnv, type TestEnv, teardownTestEnv } from "../../test-utils";
import videos, { expectedFilenamesFromTimeline } from "../videos";

let env: TestEnv;

beforeEach(async () => {
  env = await setupTestEnv();
});

afterEach(async () => {
  await teardownTestEnv(env);
});

async function createVideoViaApi(): Promise<{ id: string; slug: string }> {
  const res = await videos.request("/", { method: "POST" });
  expect(res.status).toBe(200);
  return res.json();
}

describe("expectedFilenamesFromTimeline", () => {
  test("empty timeline still includes init.mp4", () => {
    expect(expectedFilenamesFromTimeline({})).toEqual(["init.mp4"]);
  });

  test("extracts segment filenames and keeps init.mp4 first", () => {
    const result = expectedFilenamesFromTimeline({
      segments: [{ filename: "seg_000.m4s" }, { filename: "seg_001.m4s" }],
    });
    expect(result).toContain("init.mp4");
    expect(result).toContain("seg_000.m4s");
    expect(result).toContain("seg_001.m4s");
    expect(result.length).toBe(3);
  });

  test("ignores segments with missing or non-string filename", () => {
    const result = expectedFilenamesFromTimeline({
      segments: [{ filename: "seg_000.m4s" }, { filename: 42 }, {}],
    });
    expect(result).toEqual(["init.mp4", "seg_000.m4s"]);
  });

  test("handles non-array segments gracefully", () => {
    expect(expectedFilenamesFromTimeline({ segments: "nope" })).toEqual(["init.mp4"]);
  });
});

describe("POST /", () => {
  test("creates a video and returns id + slug", async () => {
    const body = await createVideoViaApi();
    expect(body.id).toBeTruthy();
    expect(body.slug).toMatch(/^[0-9a-f]{8}$/);
    expect(getVideo(body.id)).toBeTruthy();
  });
});

describe("PUT /:id/segments/:filename", () => {
  test("writes segment bytes for a valid video", async () => {
    const { id } = await createVideoViaApi();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const res = await videos.request(`/${id}/segments/seg_000.m4s`, {
      method: "PUT",
      headers: { "x-segment-duration": "4.0" },
      body: bytes,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const written = await Bun.file(join(DATA_DIR, id, "seg_000.m4s")).bytes();
    expect(written).toEqual(bytes);
  });

  test("returns 404 for unknown video id", async () => {
    const res = await videos.request(`/nope/segments/seg_000.m4s`, {
      method: "PUT",
      body: new Uint8Array([1]),
    });
    expect(res.status).toBe(404);
  });

  test("rejects invalid filenames (path traversal)", async () => {
    const { id } = await createVideoViaApi();
    // Hono normalizes the path before routing, so we go straight to the handler.
    const res = await videos.request(`/${id}/segments/..%2F..%2Fetc%2Fpasswd`, {
      method: "PUT",
      body: new Uint8Array([1]),
    });
    expect(res.status).toBe(400);
  });

  test("rejects filenames that don't match the allowlist", async () => {
    const { id } = await createVideoViaApi();
    const res = await videos.request(`/${id}/segments/video.json`, {
      method: "PUT",
      body: new Uint8Array([1]),
    });
    expect(res.status).toBe(400);
    // Ensure video.json wasn't overwritten.
    const onDisk = await Bun.file(join(DATA_DIR, id, "video.json")).json();
    expect(onDisk.id).toBe(id);
  });

  test("init.mp4 upload does not add a segment or rebuild playlist", async () => {
    const { id } = await createVideoViaApi();
    const res = await videos.request(`/${id}/segments/init.mp4`, {
      method: "PUT",
      body: new Uint8Array([0]),
    });
    expect(res.status).toBe(200);
    // No segments.json or stream.m3u8 should exist yet.
    expect(await Bun.file(join(DATA_DIR, id, "segments.json")).exists()).toBe(false);
    expect(await Bun.file(join(DATA_DIR, id, "stream.m3u8")).exists()).toBe(false);
  });

  test("media segment upload writes sidecar and playlist", async () => {
    const { id } = await createVideoViaApi();
    await videos.request(`/${id}/segments/seg_000.m4s`, {
      method: "PUT",
      headers: { "x-segment-duration": "3.5" },
      body: new Uint8Array([0]),
    });
    const sidecar = await Bun.file(join(DATA_DIR, id, "segments.json")).json();
    expect(sidecar["seg_000.m4s"]).toBe(3.5);

    const playlist = await Bun.file(join(DATA_DIR, id, "stream.m3u8")).text();
    expect(playlist).toContain("seg_000.m4s");
    expect(playlist).toContain("#EXTINF:3.500");
  });

  test("missing x-segment-duration header falls back to default", async () => {
    const { id } = await createVideoViaApi();
    await videos.request(`/${id}/segments/seg_000.m4s`, {
      method: "PUT",
      body: new Uint8Array([0]),
    });
    const sidecar = await Bun.file(join(DATA_DIR, id, "segments.json")).json();
    expect(sidecar["seg_000.m4s"]).toBe(4);
  });
});

describe("POST /:id/complete", () => {
  test("returns 404 for unknown video id", async () => {
    const res = await videos.request(`/nope/complete`, { method: "POST" });
    expect(res.status).toBe(404);
  });

  test("without timeline body: status complete, empty missing", async () => {
    const { id, slug } = await createVideoViaApi();
    const res = await videos.request(`/${id}/complete`, { method: "POST" });
    const body = await res.json();
    expect(body.slug).toBe(slug);
    expect(body.url).toBe(`/v/${slug}`);
    expect(body.missing).toEqual([]);
    expect(getVideo(id)?.status).toBe("complete");
  });

  test("with timeline body and all segments present: status complete", async () => {
    const { id } = await createVideoViaApi();
    // Pretend init.mp4 and seg_000.m4s were uploaded.
    await Bun.write(join(DATA_DIR, id, "init.mp4"), new Uint8Array([0]));
    await Bun.write(join(DATA_DIR, id, "seg_000.m4s"), new Uint8Array([0]));

    const res = await videos.request(`/${id}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ timeline: { segments: [{ filename: "seg_000.m4s" }] } }),
    });
    const body = await res.json();
    expect(body.missing).toEqual([]);
    expect(getVideo(id)?.status).toBe("complete");
    // recording.json is persisted
    expect(await Bun.file(join(DATA_DIR, id, "recording.json")).exists()).toBe(true);
  });

  test("with timeline body and missing segments: status healing", async () => {
    const { id } = await createVideoViaApi();
    // Only init.mp4 present; seg_000.m4s and seg_001.m4s are expected but missing.
    await Bun.write(join(DATA_DIR, id, "init.mp4"), new Uint8Array([0]));

    const res = await videos.request(`/${id}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        timeline: {
          segments: [{ filename: "seg_000.m4s" }, { filename: "seg_001.m4s" }],
        },
      }),
    });
    const body = await res.json();
    expect(body.missing.sort()).toEqual(["seg_000.m4s", "seg_001.m4s"]);
    expect(getVideo(id)?.status).toBe("healing");
  });
});

describe("DELETE /:id", () => {
  test("removes video record and data directory", async () => {
    const { id } = await createVideoViaApi();
    expect(getVideo(id)).toBeTruthy();

    const res = await videos.request(`/${id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(getVideo(id)).toBeUndefined();
    // Directory is gone too.
    expect(await Bun.file(join(DATA_DIR, id, "video.json")).exists()).toBe(false);
  });

  test("returns 404 for unknown id", async () => {
    const res = await videos.request(`/nope`, { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});
