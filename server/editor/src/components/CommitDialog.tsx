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
    <dialog ref={dialogRef} className="editor-dialog" onClose={onCancel}>
      <div className="editor-dialog-content">
        <h3>Commit edits?</h3>
        <p>This will re-process the video with your edits applied. The original source is preserved and edits can be changed later.</p>
        <p>Processing may take a few seconds to a couple of minutes depending on video length.</p>
        <div className="editor-dialog-actions">
          <button onClick={onCancel} disabled={isCommitting} className="editor-btn">
            Cancel
          </button>
          <button onClick={onConfirm} disabled={isCommitting} className="editor-btn editor-btn-commit">
            {isCommitting ? "Processing..." : "Commit"}
          </button>
        </div>
      </div>
    </dialog>
  );
}
