import { useCallback, useRef, useState } from "react";
import type { Chapter } from "../types";

type Props = {
  chapters: Chapter[];
  currentTime: number;
  duration: number;
  saving: boolean;
  saveError: string | null;
  onSeek: (time: number) => void;
  onAddAtPlayhead: () => void;
  onTitleChange: (id: string, title: string) => void;
  onTimeChange: (id: string, t: number) => void;
  onRemove: (id: string) => void;
};

function formatChapterTime(t: number): string {
  const total = Math.max(0, t);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total - hours * 3600 - minutes * 60;
  const ss = seconds.toFixed(1).padStart(4, "0"); // "ss.s" e.g. "05.0", "12.3"
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${ss}`;
  }
  return `${minutes}:${ss}`;
}

// Accepts "12.5", "1:23", "1:23.4", "1:02:03" and returns seconds (NaN if invalid).
function parseChapterTime(value: string): number {
  const trimmed = value.trim();
  if (!trimmed) return NaN;
  const parts = trimmed.split(":").map((p) => p.trim());
  if (parts.some((p) => p === "" || !/^-?\d+(?:\.\d+)?$/.test(p))) return NaN;
  const nums = parts.map(Number);
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return NaN;
  if (nums.length === 1) return nums[0]!;
  if (nums.length === 2) return nums[0]! * 60 + nums[1]!;
  if (nums.length === 3) return nums[0]! * 3600 + nums[1]! * 60 + nums[2]!;
  return NaN;
}

function ChapterRow({
  chapter,
  duration,
  onSeek,
  onTitleChange,
  onTimeChange,
  onRemove,
}: {
  chapter: Chapter;
  duration: number;
  onSeek: (t: number) => void;
  onTitleChange: (id: string, title: string) => void;
  onTimeChange: (id: string, t: number) => void;
  onRemove: (id: string) => void;
}) {
  const titleInputRef = useRef<HTMLInputElement>(null);
  const [timeDraft, setTimeDraft] = useState(formatChapterTime(chapter.t));
  const [timeError, setTimeError] = useState(false);

  const commitTime = useCallback(() => {
    const parsed = parseChapterTime(timeDraft);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > duration) {
      setTimeError(true);
      setTimeDraft(formatChapterTime(chapter.t));
      // Clear the error indicator after a moment so it's visible but not sticky.
      setTimeout(() => setTimeError(false), 1500);
      return;
    }
    setTimeError(false);
    if (Math.abs(parsed - chapter.t) > 0.001) {
      onTimeChange(chapter.id, parsed);
    }
    // Re-format so any user-entered weirdness (e.g. "5" → "0:05.0") snaps clean.
    setTimeDraft(formatChapterTime(parsed));
  }, [timeDraft, duration, chapter.t, chapter.id, onTimeChange]);

  return (
    <li className="editor-chapter-row">
      <button
        type="button"
        className="editor-chapter-jump"
        onClick={() => onSeek(chapter.t)}
        title="Jump to this chapter"
      >
        {formatChapterTime(chapter.t)}
      </button>
      <input
        ref={titleInputRef}
        type="text"
        className="editor-chapter-title-input"
        placeholder="Untitled chapter"
        value={chapter.title ?? ""}
        onChange={(e) => onTitleChange(chapter.id, e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") titleInputRef.current?.blur();
        }}
        maxLength={200}
      />
      <input
        type="text"
        className={`editor-chapter-time-input${timeError ? " editor-chapter-time-input--error" : ""}`}
        value={timeDraft}
        onChange={(e) => setTimeDraft(e.target.value)}
        onBlur={commitTime}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setTimeDraft(formatChapterTime(chapter.t));
            (e.target as HTMLInputElement).blur();
          }
        }}
        aria-label="Chapter time"
        title="Edit time (mm:ss.s or seconds)"
      />
      <button
        type="button"
        className="editor-chapter-remove"
        onClick={() => onRemove(chapter.id)}
        title="Remove chapter"
        aria-label="Remove chapter"
      >
        ×
      </button>
    </li>
  );
}

export function ChaptersPanel({
  chapters,
  currentTime,
  duration,
  saving,
  saveError,
  onSeek,
  onAddAtPlayhead,
  onTitleChange,
  onTimeChange,
  onRemove,
}: Props) {
  return (
    <section className="editor-chapters-panel" aria-label="Chapters">
      <header className="editor-chapters-header">
        <h2 className="editor-chapters-heading">
          Chapters
          {chapters.length > 0 && (
            <span className="editor-chapters-count"> ({chapters.length})</span>
          )}
        </h2>
        <div className="editor-chapters-status">
          {saveError ? (
            <span className="editor-chapters-error" title={saveError}>
              Save failed
            </span>
          ) : saving ? (
            <span className="editor-chapters-saving">Saving…</span>
          ) : null}
        </div>
        <button
          type="button"
          className="editor-btn editor-chapters-add"
          onClick={onAddAtPlayhead}
          title="Add a chapter at the current playhead position"
          disabled={duration <= 0}
        >
          + Add at {formatChapterTime(currentTime)}
        </button>
      </header>

      {chapters.length === 0 ? (
        <p className="editor-chapters-empty">
          No chapters yet. Drop one with the bookmark button while recording, or add one here at
          the current playhead.
        </p>
      ) : (
        <ul className="editor-chapters-list">
          {chapters.map((c) => (
            <ChapterRow
              key={c.id}
              chapter={c}
              duration={duration}
              onSeek={onSeek}
              onTitleChange={onTitleChange}
              onTimeChange={onTimeChange}
              onRemove={onRemove}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
