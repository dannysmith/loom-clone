// Display formatting helpers. Used by views and metadata endpoints.

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

/** Formats an ISO timestamp as a human-readable date (e.g. "17 Apr 2026"). */
export function formatDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}
