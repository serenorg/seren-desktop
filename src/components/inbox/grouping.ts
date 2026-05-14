// ABOUTME: Pure helpers for the approval-inbox UI - grouping by kind and decision gate.
// ABOUTME: Kept out of the TSX file so the visibility contract can be unit-tested without a DOM renderer.

import type {
  ApprovalInboxBlockedEgressEntry,
  ApprovalInboxEntry,
  ApprovalInboxToolCallEntry,
} from "@/services/approval-inbox";

export interface GroupedInboxEntries {
  toolCalls: ApprovalInboxToolCallEntry[];
  blockedEgress: ApprovalInboxBlockedEgressEntry[];
  other: ApprovalInboxEntry[];
}

/**
 * Split inbox entries into the visual groups the UI renders. Pure so the
 * grouping contract can be unit-tested without a DOM renderer.
 */
export function groupInboxEntries(
  entries: readonly ApprovalInboxEntry[],
): GroupedInboxEntries {
  const toolCalls: ApprovalInboxToolCallEntry[] = [];
  const blockedEgress: ApprovalInboxBlockedEgressEntry[] = [];
  const other: ApprovalInboxEntry[] = [];
  for (const entry of entries) {
    if (entry.kind === "tool_call") toolCalls.push(entry);
    else if (entry.kind === "blocked_egress") blockedEgress.push(entry);
    else other.push(entry);
  }
  return { toolCalls, blockedEgress, other };
}

/**
 * True when the entry should expose Approve/Deny buttons. Mirrors the
 * `<Show when={!isTerminal}>` gate in InboxList's EntryRow.
 */
export function entryAllowsDecision(entry: ApprovalInboxEntry): boolean {
  return entry.decision_state === "pending";
}
