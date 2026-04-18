import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "path";
import {
  DATA_DIR,
  getSegmentDurations,
  getVideo,
  setVideoStatus,
  trashVideo,
} from "../../../lib/store";
import { setupTestEnv, type TestEnv, teardownTestEnv } from "../../../test-utils";
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

describe("GET /", () => {
  test("returns empty items when no videos exist", async () => {
    const res = await videos.request("/");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toEqual([]);
    expect(body.nextCursor).toBeNull();
  });

  test("returns videos with urls bundle", async () => {
    const a = await createVideoViaApi();
    const b = await createVideoViaApi();
    const res = await videos.request("/");
    const body = await res.json();
    expect(body.items.length).toBe(2);
    const ids = body.items.map((v: { id: string }) => v.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
    expect(body.items[0].urls.page).toBeTruthy();
    expect(body.items[0].url).toMatch(/^https?:\/\//);
  });

  test("excludes trashed videos by default", async () => {
    const v = await createVideoViaApi();
    await trashVideo(v.id);
    const res = await videos.request("/");
    const body = await res.json();
    expect(body.items.length).toBe(0);
  });

  test("includes trashed when includeTrashed=1", async () => {
    const v = await createVideoViaApi();
    await trashVideo(v.id);
    const res = await videos.request("/?includeTrashed=1");
    const body = await res.json();
    expect(body.items.length).toBe(1);
    expect(body.items[0].id).toBe(v.id);
  });

  test("paginates with cursor", async () => {
    // Create 3 videos; request limit=2, then use cursor for the rest.
    await createVideoViaApi();
    await createVideoViaApi();
    await createVideoViaApi();

    const res1 = await videos.request("/?limit=2");
    const page1 = await res1.json();
    expect(page1.items.length).toBe(2);
    expect(page1.nextCursor).toBeTruthy();

    const res2 = await videos.request(`/?limit=2&cursor=${page1.nextCursor}`);
    const page2 = await res2.json();
    expect(page2.items.length).toBe(1);
    expect(page2.nextCursor).toBeNull();

    // All 3 ids are distinct across both pages
    const allIds = [...page1.items, ...page2.items].map((v: { id: string }) => v.id);
    expect(new Set(allIds).size).toBe(3);
  });
});

describe("GET /:id", () => {
  test("returns video JSON with urls bundle", async () => {
    const { id, slug } = await createVideoViaApi();
    const res = await videos.request(`/${id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(id);
    expect(body.slug).toBe(slug);
    expect(body.status).toBe("recording");
    expect(body.urls.page).toBe(`/${slug}`);
    expect(body.urls.raw).toBe(`/${slug}/raw/source.mp4`);
    expect(body.urls.hls).toBe(`/${slug}/stream/stream.m3u8`);
    expect(body.urls.poster).toBe(`/${slug}/poster.jpg`);
    expect(body.url).toMatch(/^https?:\/\//);
  });

  test("returns 404 for unknown id", async () => {
    const res = await videos.request("/nonexistent-id");
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("VIDEO_NOT_FOUND");
  });

  test("returns 404 for trashed video", async () => {
    const { id } = await createVideoViaApi();
    await trashVideo(id);
    const res = await videos.request(`/${id}`);
    expect(res.status).toBe(404);
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

  test("returns 404 with VIDEO_NOT_FOUND for unknown video id", async () => {
    const res = await videos.request(`/nope/segments/seg_000.m4s`, {
      method: "PUT",
      body: new Uint8Array([1]),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("VIDEO_NOT_FOUND");
  });

  test("rejects invalid filenames with INVALID_SEGMENT_FILENAME", async () => {
    const { id } = await createVideoViaApi();
    // Hono normalizes the path before routing, so we go straight to the handler.
    const res = await videos.request(`/${id}/segments/..%2F..%2Fetc%2Fpasswd`, {
      method: "PUT",
      body: new Uint8Array([1]),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("INVALID_SEGMENT_FILENAME");
  });

  test("rejects filenames that don't match the allowlist", async () => {
    const { id } = await createVideoViaApi();
    const res = await videos.request(`/${id}/segments/video.json`, {
      method: "PUT",
      body: new Uint8Array([1]),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("INVALID_SEGMENT_FILENAME");
    // Ensure no file was written to the video directory under that name.
    expect(await Bun.file(join(DATA_DIR, id, "video.json")).exists()).toBe(false);
  });

  test("init.mp4 upload does not add a segment or rebuild playlist", async () => {
    const { id } = await createVideoViaApi();
    const res = await videos.request(`/${id}/segments/init.mp4`, {
      method: "PUT",
      body: new Uint8Array([0]),
    });
    expect(res.status).toBe(200);
    // No segment row created, no playlist built yet.
    const durations = await getSegmentDurations(id);
    expect(durations.size).toBe(0);
    expect(await Bun.file(join(DATA_DIR, id, "stream.m3u8")).exists()).toBe(false);
  });

  test("media segment upload records duration and writes playlist", async () => {
    const { id } = await createVideoViaApi();
    await videos.request(`/${id}/segments/seg_000.m4s`, {
      method: "PUT",
      headers: { "x-segment-duration": "3.5" },
      body: new Uint8Array([0]),
    });
    const durations = await getSegmentDurations(id);
    expect(durations.get("seg_000.m4s")).toBe(3.5);

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
    const durations = await getSegmentDurations(id);
    expect(durations.get("seg_000.m4s")).toBe(4);
  });

  test("unparseable x-segment-duration falls back to default (no NaN in DB)", async () => {
    const { id } = await createVideoViaApi();
    await videos.request(`/${id}/segments/seg_000.m4s`, {
      method: "PUT",
      headers: { "x-segment-duration": "not-a-number" },
      body: new Uint8Array([0]),
    });
    const durations = await getSegmentDurations(id);
    expect(durations.get("seg_000.m4s")).toBe(4);
  });

  test("negative or zero x-segment-duration falls back to default", async () => {
    const { id } = await createVideoViaApi();
    await videos.request(`/${id}/segments/seg_000.m4s`, {
      method: "PUT",
      headers: { "x-segment-duration": "-1.5" },
      body: new Uint8Array([0]),
    });
    const durations = await getSegmentDurations(id);
    expect(durations.get("seg_000.m4s")).toBe(4);
  });
});

describe("POST /:id/complete", () => {
  test("returns 404 with VIDEO_NOT_FOUND for unknown video id", async () => {
    const res = await videos.request(`/nope/complete`, { method: "POST" });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("VIDEO_NOT_FOUND");
  });

  test("without timeline body: status complete, empty missing, returns path + url", async () => {
    const { id, slug } = await createVideoViaApi();
    const res = await videos.request(`/${id}/complete`, { method: "POST" });
    const body = await res.json();
    expect(body.slug).toBe(slug);
    expect(body.path).toBe(`/${slug}`);
    expect(body.url).toContain(`/${slug}`);
    expect(body.url).toMatch(/^https?:\/\//);
    expect(body.missing).toEqual([]);
    expect((await getVideo(id))?.status).toBe("complete");
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
    expect((await getVideo(id))?.status).toBe("complete");
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
    expect((await getVideo(id))?.status).toBe("healing");
  });
});

describe("PATCH /:id", () => {
  test("updates title and returns updated video", async () => {
    const { id, slug } = await createVideoViaApi();
    const res = await videos.request(`/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "My Recording" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.title).toBe("My Recording");
    expect(body.slug).toBe(slug);
    expect(body.urls).toBeTruthy();
  });

  test("updates visibility", async () => {
    const { id } = await createVideoViaApi();
    const res = await videos.request(`/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ visibility: "public" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).visibility).toBe("public");
  });

  test("clears title with null", async () => {
    const { id } = await createVideoViaApi();
    await videos.request(`/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Temp" }),
    });
    const res = await videos.request(`/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: null }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).title).toBeNull();
  });

  test("returns 404 for unknown id", async () => {
    const res = await videos.request("/nonexistent", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "x" }),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("VIDEO_NOT_FOUND");
  });

  test("rejects invalid visibility with 400 VALIDATION_ERROR", async () => {
    const { id } = await createVideoViaApi();
    const res = await videos.request(`/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ visibility: "secret" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("VALIDATION_ERROR");
  });

  test("rejects non-string title with 400", async () => {
    const { id } = await createVideoViaApi();
    const res = await videos.request(`/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: 42 }),
    });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /:id", () => {
  test("removes non-complete video and data directory", async () => {
    const { id } = await createVideoViaApi();
    expect(await getVideo(id)).toBeTruthy();

    const res = await videos.request(`/${id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await getVideo(id)).toBeUndefined();
  });

  test("allows deleting a recording-status video", async () => {
    const { id } = await createVideoViaApi();
    const res = await videos.request(`/${id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
  });

  test("allows deleting a healing-status video", async () => {
    const { id } = await createVideoViaApi();
    await setVideoStatus(id, "healing");
    const res = await videos.request(`/${id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
  });

  test("returns 409 VIDEO_ALREADY_COMPLETE for complete videos", async () => {
    const { id } = await createVideoViaApi();
    await setVideoStatus(id, "complete");
    const res = await videos.request(`/${id}`, { method: "DELETE" });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("VIDEO_ALREADY_COMPLETE");
    // Video still exists
    expect(await getVideo(id)).toBeTruthy();
  });

  test("returns 404 with VIDEO_NOT_FOUND for unknown id", async () => {
    const res = await videos.request(`/nope`, { method: "DELETE" });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("VIDEO_NOT_FOUND");
  });
});

describe("trashed video handling", () => {
  test("segment upload to trashed video returns 404", async () => {
    const { id } = await createVideoViaApi();
    await trashVideo(id);

    const res = await videos.request(`/${id}/segments/seg_000.m4s`, {
      method: "PUT",
      headers: { "x-segment-duration": "4.0" },
      body: new Uint8Array([0, 1, 2]),
    });
    expect(res.status).toBe(404);
  });

  test("/complete on a trashed video returns 404", async () => {
    const { id } = await createVideoViaApi();
    await trashVideo(id);

    const res = await videos.request(`/${id}/complete`, { method: "POST" });
    expect(res.status).toBe(404);
  });
});
