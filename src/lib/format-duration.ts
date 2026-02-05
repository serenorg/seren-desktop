// ABOUTME: Utility for formatting thinking duration in human-readable format.
// ABOUTME: Formats milliseconds into "Xm Ys" or "Xs" style strings.

/**
 * Format a duration in milliseconds to a human-readable string.
 * Examples: "1m 18s", "45s", "2m 5s"
 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}
