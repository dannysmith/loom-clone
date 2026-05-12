import { useCallback, useEffect, useRef, useState } from "react";
import { editorMediaUrl } from "../api";
import type { Chapter, StoryboardCue } from "../types";

type Props = {
  videoId: string;
  duration: number;
  currentTime: number;
  chapters: Chapter[];
  onSeek: (time: number) => void;
  onChapterDrop: (id: string, t: number) => void;
};

// Pixels the pointer must move before a press becomes a drag. Below this
// threshold, the press is treated as a click (seek to chapter).
const DRAG_THRESHOLD_PX = 3;

function parseVtt(text: string): StoryboardCue[] {
  const cues: StoryboardCue[] = [];
  const lines = text.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.includes(" --> ")) continue;

    const [startStr, endStr] = line.split(" --> ");
    const start = parseVttTime(startStr!);
    const end = parseVttTime(endStr!);

    const nextLine = lines[i + 1];
    if (!nextLine) continue;

    const match = nextLine.match(/#xywh=(\d+),(\d+),(\d+),(\d+)/);
    if (match) {
      cues.push({
        start,
        end,
        x: parseInt(match[1]!, 10),
        y: parseInt(match[2]!, 10),
        w: parseInt(match[3]!, 10),
        h: parseInt(match[4]!, 10),
      });
    }
  }

  return cues;
}

function parseVttTime(str: string): number {
  const parts = str.trim().split(":");
  if (parts.length === 3) {
    const h = parseFloat(parts[0]!);
    const m = parseFloat(parts[1]!);
    const s = parseFloat(parts[2]!);
    return h * 3600 + m * 60 + s;
  }
  return 0;
}

export function Timeline({
  videoId,
  duration,
  currentTime,
  chapters,
  onSeek,
  onChapterDrop,
}: Props) {
  const [cues, setCues] = useState<StoryboardCue[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);
  const spriteUrl = editorMediaUrl(videoId, "editor-storyboard.jpg");

  // Per-chapter live drag state. Holds the in-flight time during a drag so
  // the flag visually follows the cursor; cleared on drop. The "moved" flag
  // is what distinguishes a click (seek) from a drag (commit time).
  const [dragState, setDragState] = useState<{
    id: string;
    t: number;
    moved: boolean;
  } | null>(null);

  // Pointer-down coordinates kept in a ref so move/up handlers don't need to
  // re-bind on each render.
  const dragStartRef = useRef<{ clientX: number; originalT: number } | null>(null);

  useEffect(() => {
    fetch(editorMediaUrl(videoId, "editor-storyboard.vtt"))
      .then((r) => {
        if (!r.ok) throw new Error("No storyboard VTT");
        return r.text();
      })
      .then((text) => setCues(parseVtt(text)))
      .catch(() => {
        // No storyboard available.
      });
  }, [videoId]);

  const seekFromPointer = useCallback(
    (clientX: number) => {
      if (!containerRef.current || duration <= 0) return;
      const rect = containerRef.current.getBoundingClientRect();
      const x = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      onSeek(x * duration);
    },
    [duration, onSeek],
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      isDragging.current = true;
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      seekFromPointer(e.clientX);
    },
    [seekFromPointer],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!isDragging.current) return;
      seekFromPointer(e.clientX);
    },
    [seekFromPointer],
  );

  const handlePointerUp = useCallback(() => {
    isDragging.current = false;
  }, []);

  // --- Chapter drag handlers ---

  const handleChapterPointerDown = useCallback(
    (e: React.PointerEvent, chapter: Chapter) => {
      e.stopPropagation();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      dragStartRef.current = { clientX: e.clientX, originalT: chapter.t };
      setDragState({ id: chapter.id, t: chapter.t, moved: false });
    },
    [],
  );

  const handleChapterPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const start = dragStartRef.current;
      if (!start || !dragState) return;
      const dx = e.clientX - start.clientX;
      const moved = dragState.moved || Math.abs(dx) >= DRAG_THRESHOLD_PX;
      if (!moved) return;
      if (!containerRef.current || duration <= 0) return;
      const rect = containerRef.current.getBoundingClientRect();
      // Use absolute position so the flag follows the cursor even if the
      // user keeps moving past the original press point.
      const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const t = x * duration;
      setDragState({ id: dragState.id, t, moved: true });
    },
    [dragState, duration],
  );

  const handleChapterPointerUp = useCallback(
    (e: React.PointerEvent, chapter: Chapter) => {
      e.stopPropagation();
      const start = dragStartRef.current;
      dragStartRef.current = null;
      if (!dragState) return;
      if (dragState.moved) {
        // Commit the drag — clamp to [0, duration).
        const finalT = Math.max(0, Math.min(dragState.t, Math.max(0, duration - 0.01)));
        if (Math.abs(finalT - (start?.originalT ?? chapter.t)) > 0.001) {
          onChapterDrop(chapter.id, finalT);
        }
      } else {
        // Treat as a click — seek to the chapter.
        onSeek(chapter.t);
      }
      setDragState(null);
    },
    [dragState, duration, onChapterDrop, onSeek],
  );

  const handleChapterPointerCancel = useCallback(() => {
    dragStartRef.current = null;
    setDragState(null);
  }, []);

  if (cues.length === 0) return null;

  const playheadPct = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div
      className="editor-timeline"
      ref={containerRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    >
      <div className="editor-timeline-strip">
        {cues.map((cue, i) => (
          <div
            key={i}
            className="editor-timeline-thumb"
            style={{
              backgroundImage: `url(${spriteUrl})`,
              backgroundPosition: `-${cue.x}px -${cue.y}px`,
              width: cue.w,
              height: cue.h,
            }}
          />
        ))}
      </div>
      {duration > 0 &&
        chapters.map((ch) => {
          const isActive = dragState?.id === ch.id;
          const visibleT = isActive ? dragState.t : ch.t;
          const dragging = isActive && dragState.moved;
          return (
            <button
              key={ch.id}
              type="button"
              className={`editor-timeline-chapter${dragging ? " editor-timeline-chapter--dragging" : ""}`}
              style={{ left: `${(visibleT / duration) * 100}%` }}
              title={ch.title ?? "Untitled chapter"}
              aria-label={`Chapter at ${visibleT.toFixed(1)}s — drag to move`}
              onPointerDown={(e) => handleChapterPointerDown(e, ch)}
              onPointerMove={handleChapterPointerMove}
              onPointerUp={(e) => handleChapterPointerUp(e, ch)}
              onPointerCancel={handleChapterPointerCancel}
            >
              <span className="editor-timeline-chapter-flag" aria-hidden="true" />
              {dragging && (
                <span className="editor-timeline-chapter-time">{visibleT.toFixed(1)}s</span>
              )}
            </button>
          );
        })}
      <div className="editor-timeline-playhead" style={{ left: `${playheadPct}%` }} />
    </div>
  );
}
