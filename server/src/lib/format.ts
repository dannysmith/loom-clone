// Display formatting helpers. Used by views, metadata endpoints, and store.

/** Returns the current time as an ISO-8601 string. */
export function nowIso(): string {
  return new Date().toISOString();
}

/** Formats seconds as "Xm Ys" or "Xs" for short videos. */
export function formatDuration(seconds: number | null | undefined): string | null {
  if (seconds == null || seconds <= 0) return null;
  // Round total first, then split — avoids "60s" when 59.5 rounds up.
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m === 0) return `${s}s`;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

/** Compact M:SS format for cards and compact displays. */
export function formatDurationShort(seconds: number | null | undefined): string | null {
  if (seconds == null || seconds <= 0) return null;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Formats an ISO timestamp as a human-readable date (e.g. "17 Apr 2026"). */
export function formatDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/** Formats an ISO timestamp as date + time (e.g. "17 Apr 2026, 14:30:05"). */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
