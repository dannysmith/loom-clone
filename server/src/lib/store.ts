export interface SegmentRecord {
  filename: string;
  duration: number;
}

export interface VideoRecord {
  id: string;
  slug: string;
  segments: SegmentRecord[];
  status: "recording" | "complete";
  createdAt: Date;
}

const videos = new Map<string, VideoRecord>();
const slugIndex = new Map<string, string>(); // slug -> id

export function createVideo(): VideoRecord {
  const id = crypto.randomUUID();
  const slug = crypto.getRandomValues(new Uint8Array(4)).reduce(
    (s, b) => s + b.toString(16).padStart(2, "0"),
    ""
  );

  const video: VideoRecord = {
    id,
    slug,
    segments: [],
    status: "recording",
    createdAt: new Date(),
  };

  videos.set(id, video);
  slugIndex.set(slug, id);
  return video;
}

export function getVideo(id: string): VideoRecord | undefined {
  return videos.get(id);
}

export function getVideoBySlug(slug: string): VideoRecord | undefined {
  const id = slugIndex.get(slug);
  return id ? videos.get(id) : undefined;
}

export function addSegment(
  id: string,
  filename: string,
  duration: number
): void {
  const video = videos.get(id);
  if (!video) throw new Error(`Video ${id} not found`);
  video.segments.push({ filename, duration });
}

export function deleteVideo(id: string): VideoRecord | undefined {
  const video = videos.get(id);
  if (!video) return undefined;
  videos.delete(id);
  slugIndex.delete(video.slug);
  return video;
}

export function completeVideo(id: string): VideoRecord {
  const video = videos.get(id);
  if (!video) throw new Error(`Video ${id} not found`);
  video.status = "complete";
  return video;
}
