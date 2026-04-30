// Derives edited transcripts by applying an EDL (edit decision list) to
// word-level timestamp data. Drops words that fall within removed regions
// and shifts timestamps for everything after each cut. Pure data
// transformation — no AI or audio processing needed.

export type Word = {
  word: string;
  start: number;
  end: number;
};

export type Edit = {
  type: "trim" | "cut";
  startTime: number;
  endTime: number;
};

export type Segment = { start: number; end: number };

// Computes the kept segments from a list of edits applied to a video of
// the given duration. Returns time ranges that survive the edits, in order.
export function computeKeptSegments(edits: Edit[], duration: number): Segment[] {
  // Start with full video range.
  let kept: Segment[] = [{ start: 0, end: duration }];

  // Apply trim (adjusts the overall range).
  const trim = edits.find((e) => e.type === "trim");
  if (trim) {
    kept = [{ start: trim.startTime, end: trim.endTime }];
  }

  // Apply cuts (remove sections from kept range), sorted by start time.
  const cuts = edits.filter((e) => e.type === "cut").sort((a, b) => a.startTime - b.startTime);

  for (const cut of cuts) {
    const newKept: Segment[] = [];
    for (const seg of kept) {
      if (cut.endTime <= seg.start || cut.startTime >= seg.end) {
        // Cut doesn't overlap this segment.
        newKept.push(seg);
      } else {
        // Cut overlaps — split into before and after.
        if (cut.startTime > seg.start) {
          newKept.push({ start: seg.start, end: cut.startTime });
        }
        if (cut.endTime < seg.end) {
          newKept.push({ start: cut.endTime, end: seg.end });
        }
      }
    }
    kept = newKept;
  }

  // Filter out tiny segments (< 1ms) that are effectively empty.
  return kept.filter((s) => s.end - s.start > 0.001);
}

export type EditedTranscriptResult = {
  words: Word[];
  plainText: string;
  srt: string;
};

// Takes the original word-level data and a list of kept segments (from
// computeKeptSegments), returns words with adjusted timestamps, plain text,
// and a regenerated SRT.
export function deriveEditedTranscript(
  originalWords: Word[],
  keptSegments: Segment[],
): EditedTranscriptResult {
  const editedWords: Word[] = [];
  let cumulativeDuration = 0;

  for (const seg of keptSegments) {
    const shift = seg.start - cumulativeDuration;
    // Find words that fall within this kept segment.
    const segWords = originalWords.filter((w) => w.start >= seg.start && w.end <= seg.end);
    for (const w of segWords) {
      editedWords.push({
        word: w.word,
        start: round3(w.start - shift),
        end: round3(w.end - shift),
      });
    }
    cumulativeDuration += seg.end - seg.start;
  }

  const plainText = editedWords.map((w) => w.word).join(" ");
  const srt = wordsToSrt(editedWords);

  return { words: editedWords, plainText, srt };
}

// Groups words into ~3-second SRT cues.
function wordsToSrt(words: Word[]): string {
  if (words.length === 0) return "";

  const CUE_DURATION = 3;
  const lines: string[] = [];
  let cueIndex = 1;
  let cueStart = words[0]!.start;
  let cueWords: string[] = [];
  let lastEnd = cueStart;

  for (const w of words) {
    if (w.start - cueStart >= CUE_DURATION && cueWords.length > 0) {
      lines.push(String(cueIndex));
      lines.push(`${formatSrtTime(cueStart)} --> ${formatSrtTime(lastEnd)}`);
      lines.push(cueWords.join(" "));
      lines.push("");
      cueIndex++;
      cueStart = w.start;
      cueWords = [];
    }
    cueWords.push(w.word);
    lastEnd = w.end;
  }

  // Emit final cue.
  if (cueWords.length > 0) {
    lines.push(String(cueIndex));
    lines.push(`${formatSrtTime(cueStart)} --> ${formatSrtTime(lastEnd)}`);
    lines.push(cueWords.join(" "));
    lines.push("");
  }

  return lines.join("\n");
}

function formatSrtTime(seconds: number): string {
  const totalMs = Math.round(seconds * 1000);
  const ms = totalMs % 1000;
  const totalSecs = Math.floor(totalMs / 1000);
  const s = totalSecs % 60;
  const m = Math.floor(totalSecs / 60) % 60;
  const h = Math.floor(totalSecs / 3600);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
