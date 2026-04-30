import { useCallback, useMemo, useState } from "react";
import { CommitDialog } from "./components/CommitDialog";
import { Timeline } from "./components/Timeline";
import { Toolbar } from "./components/Toolbar";
import { TranscriptOverlay } from "./components/TranscriptOverlay";
import { VideoPreview } from "./components/VideoPreview";
import { Waveform } from "./components/Waveform";
import { useEdl } from "./hooks/useEdl";
import { useKeyboard } from "./hooks/useKeyboard";
import { useVideoPlayback } from "./hooks/useVideoPlayback";
import type { Edit } from "./types";

type Props = {
  videoId: string;
  videoTitle: string;
  videoDuration: number;
};

export function App({ videoId, videoTitle, videoDuration }: Props) {
  const edlState = useEdl(videoId);
  const playback = useVideoPlayback(edlState.edl.edits);
  const [showCommitDialog, setShowCommitDialog] = useState(false);

  const duration = playback.duration || videoDuration;

  const handleEditsChange = useCallback(
    (edits: Edit[]) => {
      edlState.replaceEdits(edits);
    },
    [edlState],
  );

  const handleCommitConfirm = useCallback(async () => {
    await edlState.commit();
    // Navigate back to the video detail page after successful commit.
    window.location.href = `/admin/videos/${videoId}`;
  }, [edlState, videoId]);

  const setTrimIn = useCallback(() => {
    const trim = edlState.edl.edits.find((e) => e.type === "trim");
    edlState.setTrim(playback.currentTime, trim?.endTime ?? duration);
  }, [edlState, playback.currentTime, duration]);

  const setTrimOut = useCallback(() => {
    const trim = edlState.edl.edits.find((e) => e.type === "trim");
    edlState.setTrim(trim?.startTime ?? 0, playback.currentTime);
  }, [edlState, playback.currentTime]);

  const addCutAtPlayhead = useCallback(() => {
    const t = playback.currentTime;
    const cutStart = Math.max(0, t - 1);
    const cutEnd = Math.min(duration, t + 1);
    edlState.addCut(cutStart, cutEnd);
  }, [playback.currentTime, duration, edlState]);

  const keyboardActions = useMemo(
    () => ({
      togglePlayPause: playback.togglePlayPause,
      stepForward: playback.stepForward,
      stepBackward: playback.stepBackward,
      undo: edlState.undo,
      redo: edlState.redo,
      save: edlState.save,
      setTrimIn,
      setTrimOut,
      addCut: addCutAtPlayhead,
    }),
    [playback, edlState, setTrimIn, setTrimOut, addCutAtPlayhead],
  );

  useKeyboard(keyboardActions);

  if (edlState.loading) {
    return <div className="editor-loading">Loading editor...</div>;
  }

  return (
    <div className="editor-layout">
      <Toolbar
        videoTitle={videoTitle}
        videoId={videoId}
        isPlaying={playback.isPlaying}
        canUndo={edlState.canUndo}
        canRedo={edlState.canRedo}
        isDirty={edlState.isDirty}
        saving={edlState.saving}
        currentTime={playback.currentTime}
        duration={duration}
        onPlayPause={playback.togglePlayPause}
        onUndo={edlState.undo}
        onRedo={edlState.redo}
        onSave={edlState.save}
        onCommitClick={() => setShowCommitDialog(true)}
        onSetTrimIn={setTrimIn}
        onSetTrimOut={setTrimOut}
        onAddCut={addCutAtPlayhead}
      />

      <VideoPreview
        videoId={videoId}
        videoRef={playback.videoRef}
        onLoadedMetadata={playback.onLoadedMetadata}
        onPlay={playback.onPlay}
        onPause={playback.onPause}
      />

      <div className="editor-bottom-panel">
        <Timeline
          videoId={videoId}
          duration={duration}
          currentTime={playback.currentTime}
          onSeek={playback.seek}
        />

        <Waveform
          videoId={videoId}
          duration={duration}
          currentTime={playback.currentTime}
          edl={edlState.edl}
          onSeek={playback.seek}
          onEditsChange={handleEditsChange}
        />

        <TranscriptOverlay
          videoId={videoId}
          currentTime={playback.currentTime}
          edits={edlState.edl.edits}
          onSeek={playback.seek}
        />
      </div>

      <CommitDialog
        open={showCommitDialog}
        isCommitting={edlState.committing}
        onConfirm={handleCommitConfirm}
        onCancel={() => setShowCommitDialog(false)}
      />
    </div>
  );
}
