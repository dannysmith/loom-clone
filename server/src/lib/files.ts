import { readdir, stat } from "fs/promises";
import { join, relative } from "path";
import { DATA_DIR } from "./store";

export interface FileEntry {
  path: string; // relative to the video's data dir
  name: string;
  size: number;
  isDirectory: boolean;
}

// Lists all files in a video's data directory, recursively. Returns a flat
// list sorted by path. Directories are included as markers for the UI.
export async function listVideoFiles(videoId: string): Promise<FileEntry[]> {
  const root = join(DATA_DIR, videoId);
  const entries: FileEntry[] = [];

  async function walk(dir: string): Promise<void> {
    let items: string[];
    try {
      items = await readdir(dir);
    } catch {
      return; // Directory doesn't exist or is unreadable
    }

    for (const name of items.sort()) {
      const full = join(dir, name);
      try {
        const s = await stat(full);
        const rel = relative(root, full);
        if (s.isDirectory()) {
          entries.push({ path: rel, name, size: 0, isDirectory: true });
          await walk(full);
        } else {
          entries.push({ path: rel, name, size: s.size, isDirectory: false });
        }
      } catch {
        // Skip files we can't stat
      }
    }
  }

  await walk(root);
  return entries;
}

// Returns total bytes of all files in a video's data directory.
// Lightweight alternative to listVideoFiles — just sums sizes without
// building the full FileEntry array. Returns 0 if the directory doesn't exist.
export async function getVideoDirSize(videoId: string): Promise<number> {
  const root = join(DATA_DIR, videoId);
  let total = 0;

  async function walk(dir: string): Promise<void> {
    let items: string[];
    try {
      items = await readdir(dir);
    } catch {
      return;
    }
    for (const name of items) {
      const full = join(dir, name);
      try {
        const s = await stat(full);
        if (s.isDirectory()) {
          await walk(full);
        } else {
          total += s.size;
        }
      } catch {
        // Skip files we can't stat
      }
    }
  }

  await walk(root);
  return total;
}

// Computes disk sizes for multiple videos in parallel.
export async function getVideosDirSizes(videoIds: string[]): Promise<Record<string, number>> {
  const entries = await Promise.all(
    videoIds.map(async (id) => [id, await getVideoDirSize(id)] as const),
  );
  return Object.fromEntries(entries);
}

export function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** i;
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}
