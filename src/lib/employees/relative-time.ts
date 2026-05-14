// ABOUTME: Pure helper that formats an ISO timestamp as a relative phrase.
// ABOUTME: Mirrors the wording used in the approval inbox so operator surfaces stay consistent.

export function formatRelativeTime(
  iso: string,
  now: number = Date.now(),
): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "moments ago";
  const diffSec = Math.max(0, Math.round((now - then) / 1000));
  if (diffSec < 60) return diffSec <= 1 ? "just now" : `${diffSec} seconds ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) {
    return diffMin === 1 ? "1 minute ago" : `${diffMin} minutes ago`;
  }
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return diffHr === 1 ? "1 hour ago" : `${diffHr} hours ago`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 7) return diffDay === 1 ? "1 day ago" : `${diffDay} days ago`;
  return new Date(iso).toLocaleDateString();
}
