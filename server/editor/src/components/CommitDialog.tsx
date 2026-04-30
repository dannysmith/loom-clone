import { useEffect, useRef } from "react";

type Props = {
  open: boolean;
  isCommitting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

export function CommitDialog({ open, isCommitting, onConfirm, onCancel }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      className="editor-dialog"
      onClose={onCancel}
      onClick={(e) => {
        // Close when clicking the backdrop (the dialog element itself, not its content).
        if (e.target === dialogRef.current) onCancel();
      }}
    >
      <div className="editor-dialog-content">
        {isCommitting ? (
          <div className="editor-dialog-processing">
            <div className="editor-spinner" />
            <p>Processing video...</p>
            <p className="editor-dialog-subtext">
              This may take a few seconds to a couple of minutes depending on video length.
            </p>
          </div>
        ) : (
          <>
            <h3>Commit edits?</h3>
            <p>
              This will re-process the video with your edits applied. The original source is preserved
              and edits can be changed later.
            </p>
            <div className="editor-dialog-actions">
              <button onClick={onCancel} className="editor-btn">
                Cancel
              </button>
              <button onClick={onConfirm} className="editor-btn editor-btn-commit">
                Commit
              </button>
            </div>
          </>
        )}
      </div>
    </dialog>
  );
}
