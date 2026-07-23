// ABOUTME: Shared presentation helpers for the per-conversation Privileged Matter Mode.
// ABOUTME: Keeps the user-visible stamp identical across chat, agent, and export surfaces.

export const PRIVILEGED_MATTER_STAMP =
  "Privileged & Confidential — Prepared in Anticipation of Litigation";

export function formatPrivilegedMatterStamp(
  counselDirection?: string | null,
): string {
  const direction = counselDirection?.trim();
  return direction
    ? `${PRIVILEGED_MATTER_STAMP}\nCounsel direction: ${direction}`
    : PRIVILEGED_MATTER_STAMP;
}

/** Prefix allowed local exports so the work-product designation travels with them. */
export function prependPrivilegedMatterStamp(
  content: string,
  counselDirection?: string | null,
): string {
  return `${formatPrivilegedMatterStamp(counselDirection)}\n\n---\n\n${content}`;
}
