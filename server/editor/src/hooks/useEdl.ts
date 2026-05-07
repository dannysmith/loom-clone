import { useCallback, useEffect, useState } from "react";
import { commitEdits, loadEdl, loadSuggestedEdits, saveEdl } from "../api";
import type { Edit, Edl } from "../types";

const EMPTY_EDL: Edl = { version: 1, source: "source.mp4", edits: [] };

function edlsEqual(a: Edl, b: Edl): boolean {
  return JSON.stringify(a.edits) === JSON.stringify(b.edits);
}

// Undo/redo snapshots both the EDL and the suggestions list together
// so that accepting a suggestion (which moves an entry from
// suggestions → edl) is a single undoable step.
type Snapshot = { edl: Edl; suggestions: Edit[] };

export function useEdl(videoId: string) {
  const [edl, setEdl] = useState<Edl>(EMPTY_EDL);
  const [suggestions, setSuggestions] = useState<Edit[]>([]);
  const [past, setPast] = useState<Snapshot[]>([]);
  const [future, setFuture] = useState<Snapshot[]>([]);
  const [savedEdl, setSavedEdl] = useState<Edl>(EMPTY_EDL);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [committing, setCommitting] = useState(false);

  useEffect(() => {
    const edlPromise = loadEdl(videoId).catch(() => EMPTY_EDL);
    const suggestionsPromise = loadSuggestedEdits(videoId).catch(() => null);

    Promise.all([edlPromise, suggestionsPromise])
      .then(([loadedEdl, loadedSuggestions]) => {
        setEdl(loadedEdl);
        setSavedEdl(loadedEdl);
        // Suppress suggestions if the video already has any user edits
        // (a returning visit to a previously-saved-but-not-committed
        // edit). Once they've started editing, the auto-suggestions
        // would be noise.
        if (loadedEdl.edits.length === 0 && loadedSuggestions) {
          setSuggestions(loadedSuggestions.edits);
        }
      })
      .finally(() => {
        setLoading(false);
      });
  }, [videoId]);

  // Push the current state onto the undo stack and apply the next
  // snapshot. Used by every mutating action so all of them are
  // uniformly undoable.
  const apply = useCallback(
    (next: Snapshot) => {
      setPast((p) => [...p, { edl, suggestions }]);
      setFuture([]);
      setEdl(next.edl);
      setSuggestions(next.suggestions);
    },
    [edl, suggestions],
  );

  const setTrim = useCallback(
    (startTime: number, endTime: number) => {
      const edits = edl.edits.filter((e) => e.type !== "trim");
      edits.unshift({ type: "trim", startTime, endTime });
      apply({ edl: { ...edl, edits }, suggestions });
    },
    [edl, suggestions, apply],
  );

  const addCut = useCallback(
    (startTime: number, endTime: number) => {
      apply({
        edl: { ...edl, edits: [...edl.edits, { type: "cut", startTime, endTime }] },
        suggestions,
      });
    },
    [edl, suggestions, apply],
  );

  const removeCut = useCallback(
    (index: number) => {
      const cuts = edl.edits.filter((e) => e.type === "cut");
      const cut = cuts[index];
      if (!cut) return;
      apply({
        edl: { ...edl, edits: edl.edits.filter((e) => e !== cut) },
        suggestions,
      });
    },
    [edl, suggestions, apply],
  );

  const updateEdit = useCallback(
    (index: number, updated: Edit) => {
      const edits = [...edl.edits];
      if (edits[index]) {
        edits[index] = updated;
        apply({ edl: { ...edl, edits }, suggestions });
      }
    },
    [edl, suggestions, apply],
  );

  const replaceEdits = useCallback(
    (edits: Edit[]) => {
      apply({ edl: { ...edl, edits }, suggestions });
    },
    [edl, suggestions, apply],
  );

  // Move a suggestion at `index` into the live EDL. A trim suggestion
  // replaces the existing trim (if any); a cut suggestion is appended.
  const acceptSuggestion = useCallback(
    (index: number) => {
      const s = suggestions[index];
      if (!s) return;
      let nextEdits: Edit[];
      if (s.type === "trim") {
        const without = edl.edits.filter((e) => e.type !== "trim");
        nextEdits = [s, ...without];
      } else {
        nextEdits = [...edl.edits, s];
      }
      const nextSuggestions = suggestions.filter((_, i) => i !== index);
      apply({ edl: { ...edl, edits: nextEdits }, suggestions: nextSuggestions });
    },
    [edl, suggestions, apply],
  );

  const dismissSuggestion = useCallback(
    (index: number) => {
      if (!suggestions[index]) return;
      apply({ edl, suggestions: suggestions.filter((_, i) => i !== index) });
    },
    [edl, suggestions, apply],
  );

  const acceptAllSuggestions = useCallback(() => {
    if (suggestions.length === 0) return;
    const trimSuggestion = suggestions.find((e) => e.type === "trim");
    const cutSuggestions = suggestions.filter((e) => e.type === "cut");
    const withoutTrim = edl.edits.filter((e) => e.type !== "trim");
    const nextEdits: Edit[] = trimSuggestion
      ? [trimSuggestion, ...withoutTrim, ...cutSuggestions]
      : [...edl.edits, ...cutSuggestions];
    apply({ edl: { ...edl, edits: nextEdits }, suggestions: [] });
  }, [edl, suggestions, apply]);

  const dismissAllSuggestions = useCallback(() => {
    if (suggestions.length === 0) return;
    apply({ edl, suggestions: [] });
  }, [edl, suggestions, apply]);

  const undo = useCallback(() => {
    if (past.length === 0) return;
    const prev = past[past.length - 1]!;
    setPast((p) => p.slice(0, -1));
    setFuture((f) => [{ edl, suggestions }, ...f]);
    setEdl(prev.edl);
    setSuggestions(prev.suggestions);
  }, [past, edl, suggestions]);

  const redo = useCallback(() => {
    if (future.length === 0) return;
    const next = future[0]!;
    setFuture((f) => f.slice(1));
    setPast((p) => [...p, { edl, suggestions }]);
    setEdl(next.edl);
    setSuggestions(next.suggestions);
  }, [future, edl, suggestions]);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      await saveEdl(videoId, edl);
      setSavedEdl(edl);
    } finally {
      setSaving(false);
    }
  }, [videoId, edl]);

  const commit = useCallback(async () => {
    setCommitting(true);
    try {
      // Save first to make sure edits.json is up to date.
      await saveEdl(videoId, edl);
      setSavedEdl(edl);
      await commitEdits(videoId);
    } finally {
      setCommitting(false);
    }
  }, [videoId, edl]);

  return {
    edl,
    suggestions,
    loading,
    saving,
    committing,
    isDirty: !edlsEqual(edl, savedEdl),
    canUndo: past.length > 0,
    canRedo: future.length > 0,
    setTrim,
    addCut,
    removeCut,
    updateEdit,
    replaceEdits,
    acceptSuggestion,
    dismissSuggestion,
    acceptAllSuggestions,
    dismissAllSuggestions,
    undo,
    redo,
    save,
    commit,
  };
}
