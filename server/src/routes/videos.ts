import { Hono } from "hono";
import { join } from "path";
import { mkdir, rm } from "fs/promises";
import {
  createVideo,
  getVideo,
  addSegment,
  completeVideo,
  deleteVideo,
} from "../lib/store";
import { buildPlaylist, writePlaylist } from "../lib/playlist";

const videos = new Hono();

// Create a new video record
videos.post("/", async (c) => {
  const video = createVideo();
  await mkdir(join("data", video.id), { recursive: true });

  console.log(`[video] created ${video.id} (slug: ${video.slug})`);
  return c.json({ id: video.id, slug: video.slug });
});

// Receive a segment
videos.put("/:id/segments/:filename", async (c) => {
  const { id, filename } = c.req.param();
  const video = getVideo(id);
  if (!video) return c.json({ error: "Video not found" }, 404);

  const body = await c.req.arrayBuffer();
  const path = join("data", id, filename);
  await Bun.write(path, new Uint8Array(body));

  const duration = parseFloat(c.req.header("x-segment-duration") ?? "4.0");
  addSegment(id, filename, duration);

  // Rebuild playlist after each media segment (skip init)
  if (filename !== "init.mp4") {
    const playlist = buildPlaylist(video);
    await writePlaylist(id, playlist);
  }

  const size = (body.byteLength / 1024).toFixed(1);
  console.log(`[segment] ${id}/${filename} (${size} KB)`);
  return c.json({ ok: true });
});

// Finalize recording
videos.post("/:id/complete", async (c) => {
  const { id } = c.req.param();
  const video = completeVideo(id);

  const playlist = buildPlaylist(video);
  await writePlaylist(id, playlist);

  const url = `/v/${video.slug}`;
  console.log(`[complete] ${video.slug} -> ${url}`);
  return c.json({ url, slug: video.slug });
});

// Cancel/delete a recording
videos.delete("/:id", async (c) => {
  const { id } = c.req.param();
  const video = deleteVideo(id);
  if (!video) return c.json({ error: "Video not found" }, 404);

  await rm(join("data", id), { recursive: true, force: true });

  console.log(`[delete] ${id} (slug: ${video.slug})`);
  return c.json({ ok: true });
});

export default videos;
