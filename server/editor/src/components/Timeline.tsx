import { useCallback, useEffect, useRef, useState } from "react";
import { editorMediaUrl } from "../api";
import type { StoryboardCue } from "../types";

type Props = {
  videoId: string;
  duration: number;
  currentTime: number;
  onSeek: (time: number) => void;
};

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

export function Timeline({ videoId, duration, currentTime, onSeek }: Props) {
  const [cues, setCues] = useState<StoryboardCue[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);
  const spriteUrl = editorMediaUrl(videoId, "editor-storyboard.jpg");

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

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      if (!containerRef.current || duration <= 0) return;
      const rect = containerRef.current.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      onSeek(x * duration);
    },
    [duration, onSeek],
  );

  if (cues.length === 0) return null;

  const playheadPct = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div className="editor-timeline" ref={containerRef} onClick={handleClick}>
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
      <div className="editor-timeline-playhead" style={{ left: `${playheadPct}%` }} />
    </div>
  );
}
