import { useEffect } from "react";

type KeyboardActions = {
  togglePlayPause: () => void;
  stepForward: (s: number) => void;
  stepBackward: (s: number) => void;
  undo: () => void;
  redo: () => void;
  save: () => void;
  setTrimIn: () => void;
  setTrimOut: () => void;
  addCut: () => void;
};

export function useKeyboard(actions: KeyboardActions) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't capture shortcuts when typing in inputs.
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      const mod = e.metaKey || e.ctrlKey;

      switch (e.key) {
        case " ":
          e.preventDefault();
          actions.togglePlayPause();
          break;

        case "ArrowLeft":
          e.preventDefault();
          actions.stepBackward(e.shiftKey ? 5 : 1);
          break;

        case "ArrowRight":
          e.preventDefault();
          actions.stepForward(e.shiftKey ? 5 : 1);
          break;

        case "z":
          if (mod && !e.shiftKey) {
            e.preventDefault();
            actions.undo();
          } else if (mod && e.shiftKey) {
            e.preventDefault();
            actions.redo();
          }
          break;

        case "Z":
          if (mod) {
            e.preventDefault();
            actions.redo();
          }
          break;

        case "s":
          if (mod) {
            e.preventDefault();
            actions.save();
          }
          break;

        case "i":
          if (!mod) {
            e.preventDefault();
            actions.setTrimIn();
          }
          break;

        case "o":
          if (!mod) {
            e.preventDefault();
            actions.setTrimOut();
          }
          break;

        case "x":
          if (!mod) {
            e.preventDefault();
            actions.addCut();
          }
          break;
      }
    };

    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [actions]);
}
