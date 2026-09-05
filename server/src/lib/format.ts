// Display formatting helpers. Used by views, metadata endpoints, and store.

/** Returns the current time as an ISO-8601 string. */
export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Formats seconds as "HH:MM:SS.mmm" for WebVTT cues (chapters, storyboards).
 * Carries a millisecond round-up cleanly (e.g. 59.9996 → "00:01:00.000",
 * never the invalid "00:00:59.1000").
 */
export function formatVttTimestamp(t: number): string {
  const clamped = Math.max(0, t);
  const hours = Math.floor(clamped / 3600);
  const minutes = Math.floor((clamped % 3600) / 60);
  const seconds = clamped - hours * 3600 - minutes * 60;
  const wholeSeconds = Math.floor(seconds);
  const ms = Math.round((seconds - wholeSeconds) * 1000);
  let s = wholeSeconds;
  let m = minutes;
  let h = hours;
  let mms = ms;
  if (mms === 1000) {
    mms = 0;
    s += 1;
    if (s === 60) {
      s = 0;
      m += 1;
      if (m === 60) {
        m = 0;
        h += 1;
      }
    }
  }
  const hh = String(h).padStart(2, "0");
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  const msStr = String(mms).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${msStr}`;
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

/** ISO 8601 duration (e.g. "PT1M30S") for structured data / JSON-LD. */
export function formatDurationIso(seconds: number | null | undefined): string | null {
  if (seconds == null || seconds <= 0) return null;
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  let out = "PT";
  if (h) out += `${h}H`;
  if (m) out += `${m}M`;
  if (s || (!h && !m)) out += `${s}S`;
  return out;
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
