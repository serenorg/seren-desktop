// ABOUTME: Shared presentation helpers for the per-conversation Privileged Matter Mode.
// ABOUTME: Keeps the user-visible stamp identical across chat, agent, and export surfaces.

export const PRIVILEGED_MATTER_STAMP =
  "Privileged & Confidential. Prepared at the Direction of Counsel.";

export function formatPrivilegedMatterStamp(): string {
  return PRIVILEGED_MATTER_STAMP;
}

/** Prefix allowed local exports so the work-product designation travels with them. */
export function prependPrivilegedMatterStamp(content: string): string {
  return `${PRIVILEGED_MATTER_STAMP}\n\n---\n\n${content}`;
}
