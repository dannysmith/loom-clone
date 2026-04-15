import { Hono } from "hono";
import { join } from "path";
import { rm } from "fs/promises";
import {
  createVideo,
  getVideo,
  addSegment,
  completeVideo,
  deleteVideo,
  DATA_DIR,
} from "../lib/store";
import { buildPlaylist, writePlaylist } from "../lib/playlist";

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

  const body = await c.req.arrayBuffer();
  const path = join(DATA_DIR, id, filename);
  await Bun.write(path, new Uint8Array(body));

  if (filename !== "init.mp4") {
    const duration = parseFloat(c.req.header("x-segment-duration") ?? "4.0");
    await addSegment(id, filename, duration);

    const playlist = await buildPlaylist(video);
    await writePlaylist(id, playlist);
  }

  const size = (body.byteLength / 1024).toFixed(1);
  console.log(`[segment] ${id}/${filename} (${size} KB)`);
  return c.json({ ok: true });
});

// Finalize recording
videos.post("/:id/complete", async (c) => {
  const { id } = c.req.param();
  const video = await completeVideo(id);

  const playlist = await buildPlaylist(video);
  await writePlaylist(id, playlist);

  const contentType = c.req.header("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      const body = (await c.req.json()) as { timeline?: unknown };
      if (body.timeline) {
        const path = join(DATA_DIR, id, "recording.json");
        await Bun.write(path, JSON.stringify(body.timeline, null, 2));
        console.log(`[complete] timeline saved: ${id}/recording.json`);
      }
    } catch (err) {
      console.error(`[complete] failed to parse timeline body:`, err);
    }
  }

  const url = `/v/${video.slug}`;
  console.log(`[complete] ${video.slug} -> ${url}`);
  return c.json({ url, slug: video.slug });
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
