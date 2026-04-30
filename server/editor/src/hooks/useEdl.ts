import { useCallback, useEffect, useRef, useState } from "react";
import { loadEdl, saveEdl, commitEdits } from "../api";
import type { Edl, Edit } from "../types";

const EMPTY_EDL: Edl = { version: 1, source: "source.mp4", edits: [] };

function edlsEqual(a: Edl, b: Edl): boolean {
  return JSON.stringify(a.edits) === JSON.stringify(b.edits);
}

export function useEdl(videoId: string) {
  const [edl, setEdl] = useState<Edl>(EMPTY_EDL);
  const [past, setPast] = useState<Edl[]>([]);
  const [future, setFuture] = useState<Edl[]>([]);
  const [savedEdl, setSavedEdl] = useState<Edl>(EMPTY_EDL);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [committing, setCommitting] = useState(false);
  const initialLoad = useRef(true);

  useEffect(() => {
    loadEdl(videoId)
      .then((loaded) => {
        setEdl(loaded);
        setSavedEdl(loaded);
      })
      .catch(() => {
        // No EDL yet — start fresh.
      })
      .finally(() => {
        setLoading(false);
        initialLoad.current = false;
      });
  }, [videoId]);

  const pushEdit = useCallback(
    (next: Edl) => {
      setPast((p) => [...p, edl]);
      setFuture([]);
      setEdl(next);
    },
    [edl],
  );

  const setTrim = useCallback(
    (startTime: number, endTime: number) => {
      const edits = edl.edits.filter((e) => e.type !== "trim");
      edits.unshift({ type: "trim", startTime, endTime });
      pushEdit({ ...edl, edits });
    },
    [edl, pushEdit],
  );

  const addCut = useCallback(
    (startTime: number, endTime: number) => {
      pushEdit({ ...edl, edits: [...edl.edits, { type: "cut", startTime, endTime }] });
    },
    [edl, pushEdit],
  );

  const removeCut = useCallback(
    (index: number) => {
      const cuts = edl.edits.filter((e) => e.type === "cut");
      const cut = cuts[index];
      if (!cut) return;
      pushEdit({ ...edl, edits: edl.edits.filter((e) => e !== cut) });
    },
    [edl, pushEdit],
  );

  const updateEdit = useCallback(
    (index: number, updated: Edit) => {
      const edits = [...edl.edits];
      if (edits[index]) {
        edits[index] = updated;
        pushEdit({ ...edl, edits });
      }
    },
    [edl, pushEdit],
  );

  const replaceEdits = useCallback(
    (edits: Edit[]) => {
      pushEdit({ ...edl, edits });
    },
    [edl, pushEdit],
  );

  const undo = useCallback(() => {
    if (past.length === 0) return;
    const prev = past[past.length - 1]!;
    setPast((p) => p.slice(0, -1));
    setFuture((f) => [edl, ...f]);
    setEdl(prev);
  }, [past, edl]);

  const redo = useCallback(() => {
    if (future.length === 0) return;
    const next = future[0]!;
    setFuture((f) => f.slice(1));
    setPast((p) => [...p, edl]);
    setEdl(next);
  }, [future, edl]);

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
    undo,
    redo,
    save,
    commit,
  };
}
