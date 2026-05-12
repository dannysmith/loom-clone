import { useCallback, useEffect, useRef, useState } from "react";
import { loadChapters, saveChapters } from "../api";
import type { Chapter } from "../types";

// Browser-native UUID generator. The Mac side emits these for markers
// dropped during recording; this generates them for markers added in
// the admin UI. Returns lowercase, hyphenated 36-char strings.
function generateId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback for very old environments (won't be hit in practice — Vidstack
  // already requires modern Chrome/Safari/Firefox).
  return `ch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const SAVE_DEBOUNCE_MS = 600;

export function useChapters(videoId: string) {
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Tracks the most recently-loaded server state for dirty detection.
  const lastSavedRef = useRef<string>("");
  // Tracks scheduled debounced save so a follow-up edit can reset the
  // timer instead of stacking up writes.
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Mirror of the latest `chapters` state, kept in a ref so the unmount
  // cleanup below can read the current value without re-binding the effect
  // on every change (which would clear pending save timers prematurely).
  const latestChaptersRef = useRef<Chapter[]>([]);
  useEffect(() => {
    latestChaptersRef.current = chapters;
  }, [chapters]);

  useEffect(() => {
    loadChapters(videoId)
      .then((data) => {
        setChapters(data.chapters);
        lastSavedRef.current = JSON.stringify(data.chapters);
      })
      .catch(() => {
        // No chapters / load error — fall back to empty list.
      })
      .finally(() => {
        setLoading(false);
      });
  }, [videoId]);

  // Force a save now. Called on add/delete and on blur after rename.
  const flushSave = useCallback(
    async (next: Chapter[]) => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      const serialised = JSON.stringify(next);
      if (serialised === lastSavedRef.current) return;
      setSaving(true);
      setSaveError(null);
      try {
        await saveChapters(videoId, next);
        lastSavedRef.current = serialised;
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : "Save failed");
      } finally {
        setSaving(false);
      }
    },
    [videoId],
  );

  // Schedule a debounced save (used for typing in the title input).
  const scheduleSave = useCallback(
    (next: Chapter[]) => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        flushSave(next);
      }, SAVE_DEBOUNCE_MS);
    },
    [flushSave],
  );

  const addAtTime = useCallback(
    (t: number) => {
      const next = [...chapters, { id: generateId(), title: null, t }].sort((a, b) => a.t - b.t);
      setChapters(next);
      flushSave(next);
    },
    [chapters, flushSave],
  );

  const updateTitle = useCallback(
    (id: string, title: string) => {
      const next = chapters.map((c) =>
        c.id === id ? { ...c, title: title.trim() ? title : null } : c,
      );
      setChapters(next);
      scheduleSave(next);
    },
    [chapters, scheduleSave],
  );

  const updateTime = useCallback(
    (id: string, t: number) => {
      const next = chapters
        .map((c) => (c.id === id ? { ...c, t } : c))
        .sort((a, b) => a.t - b.t);
      setChapters(next);
      flushSave(next);
    },
    [chapters, flushSave],
  );

  const remove = useCallback(
    (id: string) => {
      const next = chapters.filter((c) => c.id !== id);
      setChapters(next);
      flushSave(next);
    },
    [chapters, flushSave],
  );

  // Flush any pending debounce on unmount so a half-typed title isn't lost.
  // Reads the latest chapters from a ref because depending on `chapters`
  // directly would clear pending timers prematurely on every keystroke.
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        const current = latestChaptersRef.current;
        const pending = JSON.stringify(current);
        if (pending !== lastSavedRef.current) {
          // Fire-and-forget — the user is leaving the page anyway.
          saveChapters(videoId, current).catch(() => {
            /* ignore — page is going away */
          });
        }
      }
    };
  }, [videoId]);

  return {
    chapters,
    loading,
    saving,
    saveError,
    addAtTime,
    updateTitle,
    updateTime,
    remove,
  };
}
