// ABOUTME: Shared formatting helpers for recording artifact summaries.
// ABOUTME: Keeps size/date rendering consistent across recording surfaces.

export function formatRecordingSize(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function formatRecordingTimestamp(
  startedAtMs: number | null | undefined,
): string {
  if (!startedAtMs || startedAtMs <= 0) return "";
  try {
    return new Date(startedAtMs).toLocaleString([], {
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch {
    return "";
  }
}
