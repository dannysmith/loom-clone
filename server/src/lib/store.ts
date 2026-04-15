import { readdir, mkdir } from "fs/promises";
import { join } from "path";

export const DATA_DIR = "data";

export interface VideoRecord {
  id: string;
  slug: string;
  // "healing" means complete() was called but the server was still missing
  // some segments. Viewers can play the partial playlist; a background client
  // task is uploading the gap and will re-call complete() to transition.
  status: "recording" | "healing" | "complete";
  createdAt: string;
}

const videos = new Map<string, VideoRecord>();
const slugIndex = new Map<string, string>();
// id -> (filename -> duration seconds). Mirrors data/<id>/segments.json.
const durations = new Map<string, Map<string, number>>();

function videoJsonPath(id: string): string {
  return join(DATA_DIR, id, "video.json");
}

function segmentsJsonPath(id: string): string {
  return join(DATA_DIR, id, "segments.json");
}

async function persistVideo(record: VideoRecord): Promise<void> {
  await mkdir(join(DATA_DIR, record.id), { recursive: true });
  await Bun.write(videoJsonPath(record.id), JSON.stringify(record, null, 2));
}

async function persistDurations(id: string): Promise<void> {
  const map = durations.get(id);
  if (!map) return;
  const obj: Record<string, number> = {};
  for (const [k, v] of map) obj[k] = v;
  await Bun.write(segmentsJsonPath(id), JSON.stringify(obj, null, 2));
}

export async function createVideo(): Promise<VideoRecord> {
  const id = crypto.randomUUID();
  const slug = crypto.getRandomValues(new Uint8Array(4)).reduce(
    (s, b) => s + b.toString(16).padStart(2, "0"),
    ""
  );

  const video: VideoRecord = {
    id,
    slug,
    status: "recording",
    createdAt: new Date().toISOString(),
  };

  videos.set(id, video);
  slugIndex.set(slug, id);
  durations.set(id, new Map());
  await persistVideo(video);
  return video;
}

export function getVideo(id: string): VideoRecord | undefined {
  return videos.get(id);
}

export function getVideoBySlug(slug: string): VideoRecord | undefined {
  const id = slugIndex.get(slug);
  return id ? videos.get(id) : undefined;
}

// Idempotent: same filename overwrites its duration, sidecar rewritten atomically.
export async function addSegment(
  id: string,
  filename: string,
  duration: number
): Promise<void> {
  if (!videos.has(id)) throw new Error(`Video ${id} not found`);
  let map = durations.get(id);
  if (!map) {
    map = new Map();
    durations.set(id, map);
  }
  map.set(filename, duration);
  await persistDurations(id);
}

export function getSegmentDurations(id: string): Map<string, number> {
  return durations.get(id) ?? new Map();
}

export async function setVideoStatus(
  id: string,
  status: VideoRecord["status"]
): Promise<VideoRecord> {
  const video = videos.get(id);
  if (!video) throw new Error(`Video ${id} not found`);
  video.status = status;
  await persistVideo(video);
  return video;
}

// Back-compat shim — most callers just want "this is done".
export async function completeVideo(id: string): Promise<VideoRecord> {
  return setVideoStatus(id, "complete");
}

export async function deleteVideo(id: string): Promise<VideoRecord | undefined> {
  const video = videos.get(id);
  if (!video) return undefined;
  videos.delete(id);
  slugIndex.delete(video.slug);
  durations.delete(id);
  return video;
}

// Scan data/*/video.json at startup and rehydrate in-memory state.
// Missing or malformed records are logged and skipped.
export async function loadAllVideos(): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(DATA_DIR);
  } catch {
    return 0;
  }

  let count = 0;
  for (const entry of entries) {
    const recordFile = Bun.file(videoJsonPath(entry));
    if (!(await recordFile.exists())) continue;

    try {
      const record = (await recordFile.json()) as VideoRecord;
      videos.set(record.id, record);
      slugIndex.set(record.slug, record.id);

      const sidecar = Bun.file(segmentsJsonPath(record.id));
      const map = new Map<string, number>();
      if (await sidecar.exists()) {
        const obj = (await sidecar.json()) as Record<string, number>;
        for (const [k, v] of Object.entries(obj)) map.set(k, v);
      }
      durations.set(record.id, map);
      count++;
    } catch (err) {
      console.error(`[store] failed to load ${entry}/video.json:`, err);
    }
  }
  return count;
}
