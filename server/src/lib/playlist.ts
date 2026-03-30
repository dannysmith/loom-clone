import type { VideoRecord } from "./store";
import { join } from "path";

export function buildPlaylist(video: VideoRecord): string {
  const mediaSegments = video.segments.filter(
    (s) => s.filename !== "init.mp4"
  );

  // Target duration must be the rounded-up max segment duration
  const maxDuration = mediaSegments.reduce(
    (max, s) => Math.max(max, s.duration),
    4
  );
  const targetDuration = Math.ceil(maxDuration);

  let m3u8 = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:${targetDuration}
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-MAP:URI="init.mp4"
`;

  for (const seg of mediaSegments) {
    m3u8 += `\n#EXTINF:${seg.duration.toFixed(3)},\n${seg.filename}`;
  }

  if (video.status === "complete") {
    m3u8 += "\n#EXT-X-ENDLIST";
  }

  m3u8 += "\n";
  return m3u8;
}

export async function writePlaylist(
  videoId: string,
  content: string
): Promise<void> {
  const path = join("data", videoId, "stream.m3u8");
  await Bun.write(path, content);
}
