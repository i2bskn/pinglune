// Formats UNIX time in milliseconds. timeZone defaults to the browser's.
export function formatDateTime(ms: number, timeZone?: string): string {
  return new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short", timeZone }).format(ms);
}

// Formats a size in bytes, e.g. "512 B", "1.5 KB", "25 MB" (1 KB = 1,024 bytes).
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`;
}
