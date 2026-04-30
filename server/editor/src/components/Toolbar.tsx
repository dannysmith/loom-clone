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
  onPlayPause: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onSave: () => void;
  onCommitClick: () => void;
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
  onPlayPause,
  onUndo,
  onRedo,
  onSave,
  onCommitClick,
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
