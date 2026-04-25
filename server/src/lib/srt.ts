// Minimal SRT parser — extracts the concatenated cue text as plain text.
// Only handles the subset we need: strip sequence numbers, timestamps, and
// blank separators, returning the spoken words as a single string.

export function parseSrtToPlainText(srt: string): string {
  const lines = srt.replace(/\r\n/g, "\n").split("\n");
  const textLines: string[] = [];
  // SRT format: sequence number, timestamp line, one or more text lines, blank line.
  // We skip sequence numbers (pure digits) and timestamp lines (contain " --> ").
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^\d+$/.test(trimmed)) continue;
    if (trimmed.includes(" --> ")) continue;
    textLines.push(trimmed);
  }
  return textLines.join(" ");
}
