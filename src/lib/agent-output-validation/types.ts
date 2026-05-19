// ABOUTME: Shared types for Verified Agent Output finalization.
// ABOUTME: Models final-answer claims, execution evidence, and validation reports.

export type ClaimKind =
  | "file_write"
  | "file_edit"
  | "email_sent"
  | "draft_created"
  | "db_persisted"
  | "publisher_unavailable"
  | "tool_completed"
  | "browser_action";

export type ClaimStatus = "verified" | "unverified";

export type RuleSeverity = "rewrite" | "warn" | "block_memory";
export type ReportSeverity = "ok" | "warn" | "rewrite";

export interface EvidenceRequirement {
  anyOf: string[];
}

export interface ExtractedClaim {
  id: string;
  kind: ClaimKind;
  text: string;
  sentence: string;
  sentenceIndex: number;
  sentenceOffset: number;
}

export interface ValidatedClaim extends ExtractedClaim {
  status: ClaimStatus;
  ruleId: string;
  evidenceToolCallIds: string[];
  reason?: string;
  safeRewrite?: string;
}

export interface ToolEvidence {
  id: string;
  name: string;
  title: string;
  kind: string;
  status: string;
  result?: string;
  isError: boolean;
}

export interface DiffEvidence {
  path: string;
  toolCallId?: string;
}

export interface FinalizationEvidence {
  tools: ToolEvidence[];
  diffs: DiffEvidence[];
}

export interface FinalizationRule {
  id: string;
  claimKind: ClaimKind;
  requiredEvidence: EvidenceRequirement;
  severity: RuleSeverity;
  safeRewrite: (
    claim: ExtractedClaim,
    evidence: FinalizationEvidence,
  ) => string;
}

export interface FinalOutputValidationReport {
  displayText: string;
  safeDisplayText: string;
  claims: ValidatedClaim[];
  severity: ReportSeverity;
  canStoreMemory: boolean;
  blockedRuleIds: string[];
}

export interface ValidateFinalOutputInput {
  finalText: string;
  evidence: FinalizationEvidence;
}
