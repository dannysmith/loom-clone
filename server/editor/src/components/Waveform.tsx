import { useCallback, useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import RegionsPlugin, { type Region } from "wavesurfer.js/dist/plugins/regions.js";
import { loadPeaks } from "../api";
import type { Edit } from "../types";

type Props = {
  videoId: string;
  duration: number;
  currentTime: number;
  edl: { edits: Edit[] };
  onSeek: (time: number) => void;
  onEditsChange: (edits: Edit[]) => void;
};

const TRIM_COLOR = "rgba(255, 255, 255, 0.08)";
const CUT_COLOR = "rgba(239, 68, 68, 0.35)";
const DIMMED_COLOR = "rgba(0, 0, 0, 0.6)";

export function Waveform({ videoId, duration, currentTime, edl, onSeek, onEditsChange }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const regionsRef = useRef<RegionsPlugin | null>(null);
  const [ready, setReady] = useState(false);
  const updatingFromRegions = useRef(false);
  const updatingFromEdl = useRef(false);

  // Initialize wavesurfer.
  useEffect(() => {
    if (!containerRef.current || duration <= 0) return;

    const regions = RegionsPlugin.create();
    regionsRef.current = regions;

    const ws = WaveSurfer.create({
      container: containerRef.current,
      height: 80,
      waveColor: "oklch(0.7 0.1 250)",
      progressColor: "oklch(0.6 0.15 250)",
      cursorColor: "oklch(0.95 0 0)",
      cursorWidth: 2,
      barWidth: 2,
      barGap: 1,
      barRadius: 1,
      interact: true,
      duration,
      plugins: [regions],
    });

    wsRef.current = ws;

    // Load peaks data.
    loadPeaks(videoId)
      .then((peaksData) => {
        ws.load("", [peaksData.data], duration);
      })
      .catch(() => {
        // No peaks available — show empty waveform.
        ws.load("", [new Float32Array(duration * 50).fill(0.1) as unknown as number[]], duration);
      });

    ws.on("ready", () => setReady(true));
    ws.on("interaction", (time: number) => onSeek(time));

    return () => {
      ws.destroy();
      wsRef.current = null;
      regionsRef.current = null;
      setReady(false);
    };
    // Only re-init when videoId or duration changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId, duration]);

  // Sync cursor position with video time.
  useEffect(() => {
    if (wsRef.current && ready) {
      wsRef.current.setTime(currentTime);
    }
  }, [currentTime, ready]);

  // Sync regions with EDL state.
  useEffect(() => {
    const regions = regionsRef.current;
    if (!regions || !ready) return;

    updatingFromEdl.current = true;

    // Clear existing regions.
    regions.clearRegions();

    const trim = edl.edits.find((e) => e.type === "trim");
    const trimStart = trim?.startTime ?? 0;
    const trimEnd = trim?.endTime ?? duration;

    // Dimmed region before trim start.
    if (trimStart > 0) {
      regions.addRegion({
        start: 0,
        end: trimStart,
        color: DIMMED_COLOR,
        drag: false,
        resize: false,
      });
    }

    // Dimmed region after trim end.
    if (trimEnd < duration) {
      regions.addRegion({
        start: trimEnd,
        end: duration,
        color: DIMMED_COLOR,
        drag: false,
        resize: false,
      });
    }

    // Trim region (the active area — draggable handles).
    regions.addRegion({
      id: "trim",
      start: trimStart,
      end: trimEnd,
      color: TRIM_COLOR,
      drag: false,
      resize: true,
    });

    // Cut regions.
    edl.edits
      .filter((e) => e.type === "cut")
      .forEach((cut, i) => {
        regions.addRegion({
          id: `cut-${i}`,
          start: cut.startTime,
          end: cut.endTime,
          color: CUT_COLOR,
          drag: true,
          resize: true,
        });
      });

    updatingFromEdl.current = false;
  }, [edl.edits, duration, ready]);

  // Handle region changes → update EDL.
  useEffect(() => {
    const regions = regionsRef.current;
    if (!regions || !ready) return;

    const handleUpdate = (region: Region) => {
      if (updatingFromEdl.current) return;
      updatingFromRegions.current = true;

      const newEdits: Edit[] = [];

      if (region.id === "trim") {
        newEdits.push({ type: "trim", startTime: region.start, endTime: region.end });
        // Preserve existing cuts.
        for (const e of edl.edits) {
          if (e.type === "cut") newEdits.push(e);
        }
      } else if (region.id?.startsWith("cut-")) {
        // Preserve trim.
        const trim = edl.edits.find((e) => e.type === "trim");
        if (trim) newEdits.push(trim);

        // Update the modified cut, preserve others.
        const cutIndex = parseInt(region.id.split("-")[1]!, 10);
        const cuts = edl.edits.filter((e) => e.type === "cut");
        cuts.forEach((cut, i) => {
          if (i === cutIndex) {
            newEdits.push({ type: "cut", startTime: region.start, endTime: region.end });
          } else {
            newEdits.push(cut);
          }
        });
      }

      if (newEdits.length > 0) {
        onEditsChange(newEdits);
      }
      updatingFromRegions.current = false;
    };

    regions.on("region-updated", handleUpdate);
    return () => {
      regions.un("region-updated", handleUpdate);
    };
  }, [edl.edits, onEditsChange, ready]);

  // Double-click to add a cut at the clicked position.
  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      if (!containerRef.current || duration <= 0) return;
      const rect = containerRef.current.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      const time = x * duration;
      // Create a 2-second cut centered on the click.
      const cutStart = Math.max(0, time - 1);
      const cutEnd = Math.min(duration, time + 1);
      const newEdits = [...edl.edits, { type: "cut" as const, startTime: cutStart, endTime: cutEnd }];
      onEditsChange(newEdits);
    },
    [duration, edl.edits, onEditsChange],
  );

  return (
    <div className="editor-waveform" onDoubleClick={handleDoubleClick}>
      <div ref={containerRef} className="editor-waveform-container" />
      {!ready && <div className="editor-waveform-loading">Loading waveform...</div>}
    </div>
  );
}
