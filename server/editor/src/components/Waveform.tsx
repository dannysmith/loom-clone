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

const CUT_COLOR = "rgba(239, 68, 68, 0.4)";
const DIMMED_COLOR = "rgba(0, 0, 0, 0.65)";
const TRIM_HANDLE_COLOR = "rgba(255, 255, 255, 0.15)";

export function Waveform({ videoId, duration, currentTime, edl, onSeek, onEditsChange }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const regionsRef = useRef<RegionsPlugin | null>(null);
  const [ready, setReady] = useState(false);
  // Use refs for edits/callbacks so we can call syncRegions from both
  // the ready handler and the effect without stale closures.
  const editsRef = useRef(edl.edits);
  editsRef.current = edl.edits;
  const onEditsChangeRef = useRef(onEditsChange);
  onEditsChangeRef.current = onEditsChange;
  const suppressRegionEvents = useRef(false);

  // Sync regions onto the waveform. Called both when edits change
  // and when wavesurfer becomes ready.
  const syncRegions = useCallback(() => {
    const regions = regionsRef.current;
    if (!regions) return;

    suppressRegionEvents.current = true;
    regions.clearRegions();

    const edits = editsRef.current;
    const trim = edits.find((e) => e.type === "trim");
    const trimStart = trim?.startTime ?? 0;
    const trimEnd = trim?.endTime ?? duration;

    // Dimmed region before trim start.
    if (trimStart > 0.01) {
      regions.addRegion({
        start: 0,
        end: trimStart,
        color: DIMMED_COLOR,
        drag: false,
        resize: false,
      });
    }

    // Dimmed region after trim end.
    if (trimEnd < duration - 0.01) {
      regions.addRegion({
        start: trimEnd,
        end: duration,
        color: DIMMED_COLOR,
        drag: false,
        resize: false,
      });
    }

    // Trim region — the active area with draggable handles.
    regions.addRegion({
      id: "trim",
      start: trimStart,
      end: trimEnd,
      color: TRIM_HANDLE_COLOR,
      drag: false,
      resize: true,
    });

    // Cut regions.
    edits
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

    // Delay clearing the suppression flag to avoid picking up
    // events from the programmatic additions above.
    requestAnimationFrame(() => {
      suppressRegionEvents.current = false;
    });
  }, [duration]);

  // Initialize wavesurfer.
  useEffect(() => {
    if (!containerRef.current || duration <= 0) return;

    const regions = RegionsPlugin.create();
    regionsRef.current = regions;

    const ws = WaveSurfer.create({
      container: containerRef.current,
      height: 80,
      waveColor: "oklch(0.65 0.12 250)",
      progressColor: "oklch(0.55 0.15 250)",
      cursorColor: "#fff",
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
        const empty = Array.from({ length: Math.floor(duration * 50) }, () => 0.1);
        ws.load("", [empty], duration);
      });

    ws.on("ready", () => {
      setReady(true);
      // Sync regions immediately when wavesurfer is ready,
      // using the latest edits from the ref.
      syncRegions();
    });

    ws.on("interaction", (time: number) => onSeek(time));

    // Handle region drag/resize → update EDL.
    regions.on("region-updated", (region: Region) => {
      if (suppressRegionEvents.current) return;

      const currentEdits = editsRef.current;
      const newEdits: Edit[] = [];

      if (region.id === "trim") {
        newEdits.push({ type: "trim", startTime: region.start, endTime: region.end });
        for (const e of currentEdits) {
          if (e.type === "cut") newEdits.push(e);
        }
      } else if (region.id?.startsWith("cut-")) {
        const trim2 = currentEdits.find((e) => e.type === "trim");
        if (trim2) newEdits.push(trim2);
        const cutIndex = parseInt(region.id.split("-")[1]!, 10);
        const cuts = currentEdits.filter((e) => e.type === "cut");
        cuts.forEach((cut, i) => {
          if (i === cutIndex) {
            newEdits.push({ type: "cut", startTime: region.start, endTime: region.end });
          } else {
            newEdits.push(cut);
          }
        });
      }

      if (newEdits.length > 0) {
        onEditsChangeRef.current(newEdits);
      }
    });

    return () => {
      ws.destroy();
      wsRef.current = null;
      regionsRef.current = null;
      setReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId, duration]);

  // Re-sync regions when edits change (after wavesurfer is ready).
  useEffect(() => {
    if (ready) {
      syncRegions();
    }
  }, [edl.edits, ready, syncRegions]);

  // Sync cursor position with video time.
  useEffect(() => {
    if (wsRef.current && ready) {
      wsRef.current.setTime(currentTime);
    }
  }, [currentTime, ready]);

  // Double-click to add a cut at the clicked position.
  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      if (!containerRef.current || duration <= 0) return;
      const rect = containerRef.current.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      const time = x * duration;
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
      {ready && edl.edits.length === 0 && (
        <div className="editor-waveform-hint">
          Use the toolbar buttons or press I / O to set trim points. Double-click the waveform to add a cut.
        </div>
      )}
    </div>
  );
}
