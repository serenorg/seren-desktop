// ABOUTME: Deterministic rule registry for Verified Agent Output.
// ABOUTME: Rules are versioned code, owned by this codebase and extended by PR.

import type {
  ExtractedClaim,
  FinalizationEvidence,
  FinalizationRule,
} from "./types";

function hasDraftEvidence(evidence: FinalizationEvidence): boolean {
  return evidence.tools.some(
    (tool) =>
      !tool.isError &&
      !isPendingStatus(tool.status) &&
      /\bdraft|drafts|create_draft|post_drafts/i.test(
        `${tool.name} ${tool.title} ${tool.kind} ${tool.result ?? ""}`,
      ),
  );
}

function isPendingStatus(status: string): boolean {
  return /pending|running|in[_-]?progress|approval|waiting/i.test(status);
}

function rewriteFileChange(): string {
  return "I could not verify that the file was changed.";
}

function rewriteEmailSent(
  _claim: ExtractedClaim,
  evidence: FinalizationEvidence,
): string {
  if (hasDraftEvidence(evidence)) {
    return "I prepared the email draft, but I could not verify that it was sent.";
  }
  return "I could not verify that the email was sent.";
}

export const INITIAL_FINALIZATION_RULES: FinalizationRule[] = [
  {
    id: "file_write_claim_requires_diff_or_successful_file_tool",
    claimKind: "file_write",
    requiredEvidence: { anyOf: ["diff", "successful_file_tool"] },
    severity: "rewrite",
    safeRewrite: rewriteFileChange,
  },
  {
    id: "file_edit_claim_requires_diff_or_successful_file_tool",
    claimKind: "file_edit",
    requiredEvidence: { anyOf: ["diff", "successful_file_tool"] },
    severity: "rewrite",
    safeRewrite: rewriteFileChange,
  },
  {
    id: "email_sent_claim_requires_successful_send_tool",
    claimKind: "email_sent",
    requiredEvidence: { anyOf: ["successful_email_send_tool"] },
    severity: "rewrite",
    safeRewrite: rewriteEmailSent,
  },
  {
    id: "draft_created_claim_requires_successful_draft_tool",
    claimKind: "draft_created",
    requiredEvidence: { anyOf: ["successful_email_draft_tool"] },
    severity: "rewrite",
    safeRewrite: () => "I could not verify that the draft was created.",
  },
  {
    id: "db_persisted_claim_requires_successful_db_tool",
    claimKind: "db_persisted",
    requiredEvidence: { anyOf: ["successful_db_write_tool"] },
    severity: "rewrite",
    safeRewrite: () =>
      "I could not verify that the data was saved to the database.",
  },
  {
    id: "publisher_unavailable_claim_requires_failed_live_verification",
    claimKind: "publisher_unavailable",
    requiredEvidence: { anyOf: ["failed_publisher_verification_tool"] },
    severity: "rewrite",
    safeRewrite: () => "I could not verify that the service is unavailable.",
  },
  {
    id: "tool_completed_claim_rejects_pending_approval",
    claimKind: "tool_completed",
    requiredEvidence: { anyOf: ["no_pending_matching_tool"] },
    severity: "rewrite",
    safeRewrite: () => "I could not verify that the action completed.",
  },
  {
    id: "tool_completed_claim_rejects_is_error_result",
    claimKind: "tool_completed",
    requiredEvidence: { anyOf: ["successful_tool_result"] },
    severity: "rewrite",
    safeRewrite: () => "I could not verify that the action completed.",
  },
  {
    id: "browser_action_claim_requires_successful_browser_tool",
    claimKind: "browser_action",
    requiredEvidence: { anyOf: ["successful_browser_tool"] },
    severity: "rewrite",
    safeRewrite: () => "I could not verify that the browser action completed.",
  },
  {
    id: "no_memory_storage_for_unverified_completion_claims",
    claimKind: "tool_completed",
    requiredEvidence: { anyOf: ["all_completion_claims_verified"] },
    severity: "block_memory",
    safeRewrite: () => "I could not verify that the action completed.",
  },
];

export function getRulesForClaim(kind: string): FinalizationRule[] {
  return INITIAL_FINALIZATION_RULES.filter((rule) => rule.claimKind === kind);
}
