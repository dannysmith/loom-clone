type Props = {
  videoTitle: string;
  videoId: string;
  isPlaying: boolean;
  canUndo: boolean;
  canRedo: boolean;
  isDirty: boolean;
  saving: boolean;
  currentTime: number;
  duration: number;
  hasCutAtPlayhead: boolean;
  onPlayPause: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onSave: () => void;
  onCommitClick: () => void;
  onSetTrimIn: () => void;
  onSetTrimOut: () => void;
  onAddCut: () => void;
  onDeleteCut: () => void;
};

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function Toolbar({
  videoTitle,
  videoId,
  isPlaying,
  canUndo,
  canRedo,
  isDirty,
  saving,
  currentTime,
  duration,
  hasCutAtPlayhead,
  onPlayPause,
  onUndo,
  onRedo,
  onSave,
  onCommitClick,
  onSetTrimIn,
  onSetTrimOut,
  onAddCut,
  onDeleteCut,
}: Props) {
  return (
    <div className="editor-toolbar">
      <div className="editor-toolbar-left">
        <a href={`/admin/videos/${videoId}`} className="editor-back-link">
          &larr; Back
        </a>
        <span className="editor-toolbar-title">{videoTitle}</span>
      </div>

      <div className="editor-toolbar-center">
        <button onClick={onPlayPause} className="editor-btn editor-btn-play" title="Play/Pause (Space)">
          {isPlaying ? "Pause" : "Play"}
        </button>
        <span className="editor-time">
          {formatTime(currentTime)} / {formatTime(duration)}
        </span>

        <span className="editor-toolbar-divider" />

        <button onClick={onSetTrimIn} className="editor-btn" title="Set trim start at playhead">
          Trim start <kbd>I</kbd>
        </button>
        <button onClick={onSetTrimOut} className="editor-btn" title="Set trim end at playhead">
          Trim end <kbd>O</kbd>
        </button>
        <button onClick={onAddCut} className="editor-btn editor-btn-cut" title="Add a cut at the playhead">
          Add cut <kbd>X</kbd>
        </button>
        {hasCutAtPlayhead && (
          <button onClick={onDeleteCut} className="editor-btn editor-btn-delete-cut" title="Delete the cut under the playhead">
            Delete cut <kbd>D</kbd>
          </button>
        )}
      </div>

      <div className="editor-toolbar-right">
        <button onClick={onUndo} disabled={!canUndo} className="editor-btn" title="Undo (Cmd+Z)">
          Undo
        </button>
        <button onClick={onRedo} disabled={!canRedo} className="editor-btn" title="Redo (Cmd+Shift+Z)">
          Redo
        </button>
        <button onClick={onSave} disabled={!isDirty && !saving} className="editor-btn" title="Save (Cmd+S)">
          {saving ? "Saving..." : isDirty ? "Save" : "Saved"}
        </button>
        <button onClick={onCommitClick} className="editor-btn editor-btn-commit" title="Apply edits to video">
          Commit
        </button>
      </div>
    </div>
  );
}
