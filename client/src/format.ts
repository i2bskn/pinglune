// Formats UNIX time in milliseconds. timeZone defaults to the browser's.
export function formatDateTime(ms: number, timeZone?: string): string {
  // Two-digit hours, so that times line up in lists ("08:12", not "8:12").
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
  }).format(ms);
}

// Keeps a number with the word after it on one line ("30 秒", "4 分", "214 件"): the space becomes a no-break space.
export function keepNumbersWithUnits(text: string): string {
  return text.replace(/(\d)[ \t](?=[^\s\d])/g, "$1\u00a0");
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
