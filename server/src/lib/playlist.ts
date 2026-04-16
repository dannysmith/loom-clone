import { readdir } from "fs/promises";
import { join } from "path";
import { DEFAULT_SEGMENT_DURATION } from "./constants";
import { DATA_DIR, getSegmentDurations, type VideoRecord } from "./store";

// Build the playlist from the filesystem: directory listing sorted by filename
// is the source of truth for order, durations come from the in-memory sidecar.
// Safe against out-of-order uploads, duplicates, and late re-uploads.
export async function buildPlaylist(video: VideoRecord): Promise<string> {
  const dir = join(DATA_DIR, video.id);
  let files: string[] = [];
  try {
    files = await readdir(dir);
  } catch {
    // No directory yet — empty playlist.
  }

  const mediaSegments = files.filter((f) => f.endsWith(".m4s")).sort();

  const durations = await getSegmentDurations(video.id);

  const maxDuration = mediaSegments.reduce(
    (max, f) => Math.max(max, durations.get(f) ?? DEFAULT_SEGMENT_DURATION),
    DEFAULT_SEGMENT_DURATION,
  );
  const targetDuration = Math.ceil(maxDuration);

  let m3u8 = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:${targetDuration}
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-MAP:URI="init.mp4"
`;

  for (const filename of mediaSegments) {
    const duration = durations.get(filename) ?? DEFAULT_SEGMENT_DURATION;
    m3u8 += `\n#EXTINF:${duration.toFixed(3)},\n${filename}`;
  }

  if (video.status === "complete") {
    m3u8 += "\n#EXT-X-ENDLIST";
  }

  m3u8 += "\n";
  return m3u8;
}

export async function writePlaylist(videoId: string, content: string): Promise<void> {
  const path = join(DATA_DIR, videoId, "stream.m3u8");
  await Bun.write(path, content);
}
