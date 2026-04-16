import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "fs/promises";
import { join } from "path";
import { setupTestEnv, type TestEnv, teardownTestEnv } from "../../test-utils";
import { buildPlaylist, writePlaylist } from "../playlist";
import { addSegment, createVideo, DATA_DIR, setVideoStatus } from "../store";

let env: TestEnv;

beforeEach(async () => {
  env = await setupTestEnv();
});

afterEach(async () => {
  await teardownTestEnv(env);
});

// Helper: write empty placeholder segment files so readdir picks them up.
async function writeEmptySegment(videoId: string, filename: string): Promise<void> {
  await mkdir(join(DATA_DIR, videoId), { recursive: true });
  await Bun.write(join(DATA_DIR, videoId, filename), new Uint8Array(0));
}

describe("buildPlaylist", () => {
  test("empty directory yields header-only playlist with no segments", async () => {
    const video = await createVideo();
    const m3u8 = await buildPlaylist(video);
    expect(m3u8).toContain("#EXTM3U");
    expect(m3u8).toContain("#EXT-X-VERSION:7");
    expect(m3u8).toContain("#EXT-X-PLAYLIST-TYPE:VOD");
    expect(m3u8).toContain('#EXT-X-MAP:URI="init.mp4"');
    expect(m3u8).not.toContain("#EXTINF");
    expect(m3u8).not.toContain("#EXT-X-ENDLIST");
  });

  test("single segment with known duration produces correct EXTINF line", async () => {
    const video = await createVideo();
    await writeEmptySegment(video.id, "seg_000.m4s");
    await addSegment(video.id, "seg_000.m4s", 3.75);

    const m3u8 = await buildPlaylist(video);
    expect(m3u8).toContain("#EXTINF:3.750,\nseg_000.m4s");
  });

  test("multiple segments are sorted by filename", async () => {
    const video = await createVideo();
    await writeEmptySegment(video.id, "seg_002.m4s");
    await writeEmptySegment(video.id, "seg_000.m4s");
    await writeEmptySegment(video.id, "seg_001.m4s");
    await addSegment(video.id, "seg_000.m4s", 4);
    await addSegment(video.id, "seg_001.m4s", 4);
    await addSegment(video.id, "seg_002.m4s", 4);

    const m3u8 = await buildPlaylist(video);
    const pos0 = m3u8.indexOf("seg_000.m4s");
    const pos1 = m3u8.indexOf("seg_001.m4s");
    const pos2 = m3u8.indexOf("seg_002.m4s");
    expect(pos0).toBeLessThan(pos1);
    expect(pos1).toBeLessThan(pos2);
  });

  test("missing duration falls back to default (4s)", async () => {
    const video = await createVideo();
    await writeEmptySegment(video.id, "seg_000.m4s");
    // Note: no addSegment call — duration sidecar is empty.

    const m3u8 = await buildPlaylist(video);
    expect(m3u8).toContain("#EXTINF:4.000,\nseg_000.m4s");
  });

  test("TARGETDURATION is the ceiling of the longest segment", async () => {
    const video = await createVideo();
    await writeEmptySegment(video.id, "seg_000.m4s");
    await writeEmptySegment(video.id, "seg_001.m4s");
    await addSegment(video.id, "seg_000.m4s", 4.0);
    await addSegment(video.id, "seg_001.m4s", 6.3);

    const m3u8 = await buildPlaylist(video);
    expect(m3u8).toContain("#EXT-X-TARGETDURATION:7");
  });

  test("status=complete appends EXT-X-ENDLIST", async () => {
    const video = await createVideo();
    await writeEmptySegment(video.id, "seg_000.m4s");
    await addSegment(video.id, "seg_000.m4s", 4);
    const completed = await setVideoStatus(video.id, "complete");

    const m3u8 = await buildPlaylist(completed);
    expect(m3u8).toContain("#EXT-X-ENDLIST");
  });

  test("status=healing does NOT append EXT-X-ENDLIST", async () => {
    const video = await createVideo();
    const healing = await setVideoStatus(video.id, "healing");
    const m3u8 = await buildPlaylist(healing);
    expect(m3u8).not.toContain("#EXT-X-ENDLIST");
  });

  test("non-m4s files in directory are ignored", async () => {
    const video = await createVideo();
    await writeEmptySegment(video.id, "seg_000.m4s");
    await writeEmptySegment(video.id, "init.mp4");
    await writeEmptySegment(video.id, "notes.txt");
    await addSegment(video.id, "seg_000.m4s", 4);

    const m3u8 = await buildPlaylist(video);
    expect(m3u8).toContain("seg_000.m4s");
    // init.mp4 appears in EXT-X-MAP but not as an EXTINF entry
    expect(m3u8).not.toContain("#EXTINF:.*\ninit.mp4");
    expect(m3u8).not.toContain("notes.txt");
  });
});

describe("writePlaylist", () => {
  test("writes to data/<id>/stream.m3u8", async () => {
    const video = await createVideo();
    await writePlaylist(video.id, "#EXTM3U\n");
    const contents = await Bun.file(join(DATA_DIR, video.id, "stream.m3u8")).text();
    expect(contents).toBe("#EXTM3U\n");
  });
});
