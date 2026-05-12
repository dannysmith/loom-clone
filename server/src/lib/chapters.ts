// Chapters live in `data/<id>/chapters.json`. They are user-driven session
// metadata, not a derivative — initially extracted from `recording.json`
// after /complete, then mutable forever via the admin editor (rename, add,
// remove, reorder).
//
// Chapter `t` is ALWAYS in the original recording timeline (seconds from
// the start of source.mp4). When the video has edits applied, chapters
// are remapped to the viewer timeline at read time — never rewritten on
// disk. This means un-cutting a region brings back any chapters that
// briefly fell into a cut.

import { mkdir, rename } from "fs/promises";
import { join } from "path";
import { computeKeptSegments, type Edit, type Segment } from "./edit-transcript";
import { DATA_DIR } from "./store";

export type Chapter = {
  id: string;
  title: string | null;
  t: number;
  createdDuringRecording: boolean;
};

export type ChaptersFile = {
  version: 1;
  chapters: Chapter[];
};

const CHAPTERS_FILENAME = "chapters.json";

function chaptersPath(videoId: string): string {
  return join(DATA_DIR, videoId, CHAPTERS_FILENAME);
}

// --- Read / write ---

export async function readChapters(videoId: string): Promise<ChaptersFile | null> {
  const file = Bun.file(chaptersPath(videoId));
  if (!(await file.exists())) return null;
  try {
    const parsed = (await file.json()) as ChaptersFile;
    if (parsed?.version !== 1 || !Array.isArray(parsed.chapters)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function writeChapters(videoId: string, chapters: Chapter[]): Promise<void> {
  const payload: ChaptersFile = {
    version: 1,
    chapters: [...chapters].sort((a, b) => a.t - b.t),
  };
  const dir = join(DATA_DIR, videoId);
  await mkdir(dir, { recursive: true });
  const final = chaptersPath(videoId);
  const tmp = `${final}.tmp`;
  await Bun.write(tmp, JSON.stringify(payload, null, 2));
  await rename(tmp, final);
}

export async function chaptersExist(videoId: string): Promise<boolean> {
  const data = await readChapters(videoId);
  return !!data && data.chapters.length > 0;
}

// --- Extraction from recording.json ---

// Loose typing so timeline schema evolution doesn't break us — we only
// look at the events array and the two fields we care about.
type TimelineEventLike = {
  kind?: unknown;
  t?: unknown;
  data?: { id?: unknown } | null;
};

export function extractChaptersFromTimeline(timeline: { events?: unknown }): Chapter[] {
  const events = Array.isArray(timeline.events) ? (timeline.events as TimelineEventLike[]) : [];
  const chapters: Chapter[] = [];
  for (const e of events) {
    if (e?.kind !== "chapter.marker") continue;
    const t = typeof e.t === "number" ? e.t : NaN;
    if (!Number.isFinite(t) || t < 0) continue;
    const id = typeof e.data?.id === "string" ? e.data.id : null;
    if (!id) continue;
    chapters.push({ id, title: null, t, createdDuringRecording: true });
  }
  return chapters.sort((a, b) => a.t - b.t);
}

// --- Timeline mapping (recording <-> viewer) ---

// Maps a recording-timeline t to the viewer timeline by walking the EDL's
// kept segments. Returns null if the time falls inside a cut.
export function forwardMapTime(recordingT: number, keptSegments: Segment[]): number | null {
  let cumulative = 0;
  for (const seg of keptSegments) {
    if (recordingT >= seg.start && recordingT <= seg.end) {
      return cumulative + (recordingT - seg.start);
    }
    cumulative += seg.end - seg.start;
  }
  return null;
}

// Maps a viewer-timeline t back to the recording timeline. Used when the
// admin UI sends a new chapter time picked from the edited player. Clamps
// to the end of the last kept segment if the value exceeds the edited
// duration.
export function backwardMapTime(viewerT: number, keptSegments: Segment[]): number {
  if (keptSegments.length === 0) return Math.max(0, viewerT);
  let cumulative = 0;
  for (const seg of keptSegments) {
    const len = seg.end - seg.start;
    if (viewerT <= cumulative + len) {
      const offset = Math.max(0, viewerT - cumulative);
      return seg.start + offset;
    }
    cumulative += len;
  }
  const last = keptSegments[keptSegments.length - 1]!;
  return last.end;
}

// Given a video's chapters (recording timeline), edits, and the original
// source duration, returns chapters mapped to the viewer timeline. Chapters
// that fall inside cuts are dropped from the result but remain in
// chapters.json — un-cutting brings them back.
export function chaptersForViewer(
  chapters: Chapter[],
  edits: Edit[] | undefined,
  sourceDuration: number,
): Chapter[] {
  if (!edits || edits.length === 0) {
    return [...chapters].sort((a, b) => a.t - b.t);
  }
  const kept = computeKeptSegments(edits, sourceDuration);
  const out: Chapter[] = [];
  for (const ch of chapters) {
    const mapped = forwardMapTime(ch.t, kept);
    if (mapped === null) continue;
    out.push({ ...ch, t: mapped });
  }
  return out.sort((a, b) => a.t - b.t);
}

// --- VTT generation ---

function formatVttTimestamp(t: number): string {
  const clamped = Math.max(0, t);
  const hours = Math.floor(clamped / 3600);
  const minutes = Math.floor((clamped % 3600) / 60);
  const seconds = clamped - hours * 3600 - minutes * 60;
  const wholeSeconds = Math.floor(seconds);
  const ms = Math.round((seconds - wholeSeconds) * 1000);
  // Carry milliseconds rounding up cleanly (e.g. 999.6 -> next second).
  let s = wholeSeconds;
  let m = minutes;
  let h = hours;
  let mms = ms;
  if (mms === 1000) {
    mms = 0;
    s += 1;
    if (s === 60) {
      s = 0;
      m += 1;
      if (m === 60) {
        m = 0;
        h += 1;
      }
    }
  }
  const hh = String(h).padStart(2, "0");
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  const msStr = String(mms).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${msStr}`;
}

// Generates a WebVTT chapters track. Each cue spans from a chapter's start
// to the next chapter's start (or the video end for the last one).
// Chapters with `title === null` get a fallback label ("Chapter N", numbered
// in playback order).
export function generateChaptersVTT(chapters: Chapter[], videoDuration: number): string {
  const sorted = [...chapters].sort((a, b) => a.t - b.t);
  if (sorted.length === 0) return "WEBVTT\n";

  const lines: string[] = ["WEBVTT", ""];
  for (let i = 0; i < sorted.length; i++) {
    const ch = sorted[i]!;
    const start = Math.max(0, ch.t);
    const nextStart = i + 1 < sorted.length ? sorted[i + 1]!.t : videoDuration;
    const end = Math.max(start + 0.001, Math.min(nextStart, videoDuration));
    const label = ch.title?.trim() || `Chapter ${i + 1}`;
    lines.push(`${formatVttTimestamp(start)} --> ${formatVttTimestamp(end)}`);
    lines.push(label);
    lines.push("");
  }
  return lines.join("\n");
}
