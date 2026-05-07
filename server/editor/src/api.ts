import type { Edl, PeaksData, SuggestedEdits, Word } from "./types";

const base = (videoId: string) => `/admin/videos/${videoId}`;

export async function loadEdl(videoId: string): Promise<Edl> {
  const res = await fetch(`${base(videoId)}/editor/edl`);
  if (!res.ok) throw new Error(`Failed to load EDL: ${res.status}`);
  return res.json();
}

export async function saveEdl(videoId: string, edl: Edl): Promise<void> {
  const res = await fetch(`${base(videoId)}/editor/edl`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(edl),
  });
  if (!res.ok) throw new Error(`Failed to save EDL: ${res.status}`);
}

export async function commitEdits(videoId: string): Promise<void> {
  const res = await fetch(`${base(videoId)}/editor/commit`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(`Failed to commit edits: ${res.status}`);
}

export async function loadPeaks(videoId: string): Promise<PeaksData> {
  const res = await fetch(editorMediaUrl(videoId, "peaks.json"));
  if (!res.ok) throw new Error(`Failed to load peaks: ${res.status}`);
  return res.json();
}

export async function loadWords(videoId: string): Promise<Word[]> {
  const res = await fetch(editorMediaUrl(videoId, "words.json"));
  if (!res.ok) throw new Error(`Failed to load words: ${res.status}`);
  return res.json();
}

// Returns null when no suggestions exist (e.g. an edited video, or an
// older video that was processed before silence detection landed). Any
// other failure is surfaced so the editor can show a load error.
export async function loadSuggestedEdits(videoId: string): Promise<SuggestedEdits | null> {
  const res = await fetch(editorMediaUrl(videoId, "suggested-edits.json"));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Failed to load suggested edits: ${res.status}`);
  return res.json();
}

export function editorMediaUrl(videoId: string, file: string): string {
  return `${base(videoId)}/editor/media/${file}`;
}

export function videoSrcUrl(videoId: string): string {
  return `${base(videoId)}/media/raw/source.mp4`;
}
