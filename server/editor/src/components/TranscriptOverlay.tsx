import { useEffect, useMemo, useRef, useState } from "react";
import { loadWords } from "../api";
import type { Edit, Word } from "../types";

type Props = {
  videoId: string;
  currentTime: number;
  edits: Edit[];
  onSeek: (time: number) => void;
};

export function TranscriptOverlay({ videoId, currentTime, edits, onSeek }: Props) {
  const [words, setWords] = useState<Word[]>([]);
  const currentWordRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    loadWords(videoId)
      .then(setWords)
      .catch(() => {
        // No word data available.
      });
  }, [videoId]);

  const cuts = useMemo(() => edits.filter((e) => e.type === "cut"), [edits]);

  const isInCut = (word: Word): boolean => {
    return cuts.some((c) => word.start >= c.startTime && word.end <= c.endTime);
  };

  const trim = useMemo(() => edits.find((e) => e.type === "trim"), [edits]);

  const isOutsideTrim = (word: Word): boolean => {
    if (!trim) return false;
    return word.end <= trim.startTime || word.start >= trim.endTime;
  };

  // Find the current word by binary search.
  const currentWordIndex = useMemo(() => {
    let lo = 0;
    let hi = words.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const w = words[mid]!;
      if (currentTime < w.start) {
        hi = mid - 1;
      } else if (currentTime > w.end) {
        lo = mid + 1;
      } else {
        return mid;
      }
    }
    return -1;
  }, [words, currentTime]);

  // Auto-scroll to keep the current word visible.
  useEffect(() => {
    if (currentWordRef.current) {
      currentWordRef.current.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    }
  }, [currentWordIndex]);

  if (words.length === 0) return null;

  return (
    <div className="editor-transcript">
      <div className="editor-transcript-words">
        {words.map((word, i) => {
          const isCut = isInCut(word);
          const isTrimmed = isOutsideTrim(word);
          const isCurrent = i === currentWordIndex;

          return (
            <span
              key={i}
              ref={isCurrent ? currentWordRef : undefined}
              className={[
                "editor-transcript-word",
                isCurrent ? "is-current" : "",
                isCut ? "is-cut" : "",
                isTrimmed ? "is-trimmed" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              onClick={() => onSeek(word.start)}
            >
              {word.word}
            </span>
          );
        })}
      </div>
    </div>
  );
}
