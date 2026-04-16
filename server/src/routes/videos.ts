import { readdir, rm } from "fs/promises";
import { Hono } from "hono";
import { join, resolve } from "path";
import { DEFAULT_SEGMENT_DURATION } from "../lib/constants";
import { scheduleDerivatives } from "../lib/derivatives";
import { buildPlaylist, writePlaylist } from "../lib/playlist";
import {
  addSegment,
  createVideo,
  DATA_DIR,
  deleteVideo,
  getVideo,
  setVideoStatus,
} from "../lib/store";

// Timeline segment shape we care about — loose typing to stay tolerant of
// schema evolution. We only need the filename list for diffing.
interface TimelineSegmentLike {
  filename?: unknown;
}
interface TimelineLike {
  segments?: unknown;
}

export function expectedFilenamesFromTimeline(timeline: TimelineLike): string[] {
  const segs = Array.isArray(timeline.segments) ? timeline.segments : [];
  const names = new Set<string>();
  // init.mp4 is implicit — it's never in timeline.segments but is always
  // required for playback. Adding it here means a missing init.mp4 surfaces
  // in the `missing` list and gets healed along with the media segments.
  names.add("init.mp4");
  for (const s of segs as TimelineSegmentLike[]) {
    if (typeof s.filename === "string") names.add(s.filename);
  }
  return [...names];
}

// Conservative filename allowlist for segment uploads. init.mp4 is the HLS
// initialization segment; seg_NNN.m4s are the media segments emitted by the
// writer. Anything else is rejected so a malicious or buggy client can't
// traverse out of the video directory or overwrite metadata files.
const SEGMENT_FILENAME = /^(init\.mp4|seg_\d+\.m4s)$/;

async function onDiskFilenames(id: string): Promise<Set<string>> {
  try {
    const entries = await readdir(join(DATA_DIR, id));
    return new Set(entries);
  } catch {
    return new Set();
  }
}

const videos = new Hono();

// Create a new video record
videos.post("/", async (c) => {
  const video = await createVideo();
  console.log(`[video] created ${video.id} (slug: ${video.slug})`);
  return c.json({ id: video.id, slug: video.slug });
});

// Receive a segment. Idempotent — re-uploads overwrite cleanly and the
// playlist is rebuilt from the on-disk directory listing.
videos.put("/:id/segments/:filename", async (c) => {
  const { id, filename } = c.req.param();
  const video = getVideo(id);
  if (!video) return c.json({ error: "Video not found" }, 404);

  if (!SEGMENT_FILENAME.test(filename)) {
    return c.json({ error: "Invalid segment filename" }, 400);
  }

  // Belt-and-braces: even with the allowlist, resolve the destination and
  // confirm it stays inside the video's directory before writing.
  const videoDir = resolve(join(DATA_DIR, id));
  const path = resolve(join(videoDir, filename));
  if (!path.startsWith(`${videoDir}/`)) {
    return c.json({ error: "Invalid segment filename" }, 400);
  }

  const body = await c.req.arrayBuffer();
  await Bun.write(path, new Uint8Array(body));

  if (filename !== "init.mp4") {
    const duration = Number.parseFloat(
      c.req.header("x-segment-duration") ?? String(DEFAULT_SEGMENT_DURATION),
    );
    await addSegment(id, filename, duration);

    const playlist = await buildPlaylist(video);
    await writePlaylist(id, playlist);
  }

  const size = (body.byteLength / 1024).toFixed(1);
  console.log(`[segment] ${id}/${filename} (${size} KB)`);
  return c.json({ ok: true });
});

// Finalize recording. Idempotent — safe to call repeatedly as the client
// uploads missing segments in the background. Body SHOULD carry the
// `{ timeline: ... }` JSON; without it we can't diff, so `missing` comes
// back empty (best-effort complete).
videos.post("/:id/complete", async (c) => {
  const { id } = c.req.param();
  const existing = getVideo(id);
  if (!existing) return c.json({ error: "Video not found" }, 404);

  let timeline: TimelineLike | null = null;
  const contentType = c.req.header("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      const body = (await c.req.json()) as { timeline?: TimelineLike };
      if (body.timeline && typeof body.timeline === "object") {
        timeline = body.timeline;
        const path = join(DATA_DIR, id, "recording.json");
        await Bun.write(path, JSON.stringify(timeline, null, 2));
      }
    } catch (err) {
      console.error(`[complete] failed to parse timeline body:`, err);
    }
  }

  // Diff expected vs on-disk. Without a timeline we can't know what the
  // client emitted, so nothing is flagged missing.
  let missing: string[] = [];
  if (timeline) {
    const expected = expectedFilenamesFromTimeline(timeline);
    const present = await onDiskFilenames(id);
    missing = expected.filter((f) => !present.has(f)).sort();
  }

  const nextStatus: "healing" | "complete" = missing.length === 0 ? "complete" : "healing";
  const video = await setVideoStatus(id, nextStatus);

  const playlist = await buildPlaylist(video);
  await writePlaylist(id, playlist);

  // Kick off derivative generation (source.mp4, thumbnail.jpg) in the
  // background. Fire-and-forget — the client's stop flow never waits on
  // ffmpeg. A healed recording re-hitting /complete regenerates atomically.
  if (nextStatus === "complete") {
    scheduleDerivatives(id);
  }

  const url = `/v/${video.slug}`;
  console.log(
    `[complete] ${video.slug} -> ${url} (status=${nextStatus}, missing=${missing.length})`,
  );
  return c.json({ url, slug: video.slug, missing });
});

// Cancel/delete a recording
videos.delete("/:id", async (c) => {
  const { id } = c.req.param();
  const video = await deleteVideo(id);
  if (!video) return c.json({ error: "Video not found" }, 404);

  await rm(join(DATA_DIR, id), { recursive: true, force: true });

  console.log(`[delete] ${id} (slug: ${video.slug})`);
  return c.json({ ok: true });
});

export default videos;
