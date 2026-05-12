import { useCallback, useMemo, useState } from "react";
import { ChaptersPanel } from "./components/ChaptersPanel";
import { CommitDialog } from "./components/CommitDialog";
import { Timeline } from "./components/Timeline";
import { Toolbar } from "./components/Toolbar";
import { TranscriptOverlay } from "./components/TranscriptOverlay";
import { VideoPreview } from "./components/VideoPreview";
import { Waveform } from "./components/Waveform";
import { useChapters } from "./hooks/useChapters";
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
  const chaptersState = useChapters(videoId);
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

  const deleteCutAtPlayhead = useCallback(() => {
    const t = playback.currentTime;
    const cuts = edlState.edl.edits.filter((e) => e.type === "cut");
    const index = cuts.findIndex((c) => t >= c.startTime && t <= c.endTime);
    if (index !== -1) {
      edlState.removeCut(index);
    }
  }, [playback.currentTime, edlState]);

  const hasCutAtPlayhead = useMemo(() => {
    const t = playback.currentTime;
    return edlState.edl.edits.some(
      (e) => e.type === "cut" && t >= e.startTime && t <= e.endTime,
    );
  }, [playback.currentTime, edlState.edl.edits]);

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
      deleteCut: deleteCutAtPlayhead,
    }),
    [playback, edlState, setTrimIn, setTrimOut, addCutAtPlayhead, deleteCutAtPlayhead],
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
        suggestionCount={edlState.suggestions.length}
        onPlayPause={playback.togglePlayPause}
        onUndo={edlState.undo}
        onRedo={edlState.redo}
        onSave={edlState.save}
        onCommitClick={() => setShowCommitDialog(true)}
        onSetTrimIn={setTrimIn}
        onSetTrimOut={setTrimOut}
        onAddCut={addCutAtPlayhead}
        onDeleteCut={deleteCutAtPlayhead}
        onAcceptAllSuggestions={edlState.acceptAllSuggestions}
        onDismissAllSuggestions={edlState.dismissAllSuggestions}
        hasCutAtPlayhead={hasCutAtPlayhead}
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
          chapters={chaptersState.chapters}
          onSeek={playback.seek}
          onChapterDrop={chaptersState.updateTime}
        />

        <Waveform
          videoId={videoId}
          duration={duration}
          currentTime={playback.currentTime}
          edl={edlState.edl}
          suggestions={edlState.suggestions}
          onSeek={playback.seek}
          onEditsChange={handleEditsChange}
          onAcceptSuggestion={edlState.acceptSuggestion}
          onDismissSuggestion={edlState.dismissSuggestion}
        />

        <TranscriptOverlay
          videoId={videoId}
          currentTime={playback.currentTime}
          edits={edlState.edl.edits}
          onSeek={playback.seek}
        />

        <ChaptersPanel
          chapters={chaptersState.chapters}
          currentTime={playback.currentTime}
          duration={duration}
          saving={chaptersState.saving}
          saveError={chaptersState.saveError}
          onSeek={playback.seek}
          onAddAtPlayhead={() => chaptersState.addAtTime(playback.currentTime)}
          onTitleChange={chaptersState.updateTitle}
          onTimeChange={chaptersState.updateTime}
          onRemove={chaptersState.remove}
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
