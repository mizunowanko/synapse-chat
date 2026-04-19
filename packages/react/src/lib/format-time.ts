/** Format a millisecond timestamp as `HH:MM`. Returns `null` for falsy input. */
export function formatTime(ts?: number): string | null {
  if (!ts) return null;
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
