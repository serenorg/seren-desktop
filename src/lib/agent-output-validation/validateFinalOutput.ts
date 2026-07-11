// ABOUTME: Validates final assistant text against actual run-ledger evidence.
// ABOUTME: Rewrites unsupported completion claims before render, persistence, or memory.

import { extractClaims, splitSentences } from "./claims";
import { INITIAL_FINALIZATION_RULES } from "./rules";
import type {
  ClaimKind,
  ExtractedClaim,
  FinalizationEvidence,
  FinalizationRule,
  FinalOutputValidationReport,
  ToolEvidence,
  ValidatedClaim,
  ValidateFinalOutputInput,
} from "./types";

export function validateFinalOutput({
  finalText,
  evidence,
}: ValidateFinalOutputInput): FinalOutputValidationReport {
  const displayText = finalText.trim();
  const claims = extractClaims(displayText).map((claim) =>
    validateClaim(claim, evidence),
  );
  const hasUnverified = claims.some((claim) => claim.status === "unverified");
  const safeDisplayText = hasUnverified
    ? buildSafeDisplayText(displayText, claims, evidence)
    : displayText;

  return {
    displayText,
    safeDisplayText,
    claims,
    severity: hasUnverified ? "rewrite" : "ok",
    canStoreMemory: !hasUnverified,
    blockedRuleIds: hasUnverified
      ? ["no_memory_storage_for_unverified_completion_claims"]
      : [],
  };
}

function validateClaim(
  claim: ExtractedClaim,
  evidence: FinalizationEvidence,
): ValidatedClaim {
  const rule = ruleForClaim(claim.kind);
  const matchingPending = findMatchingTools(claim.kind, evidence.tools).filter(
    isPendingTool,
  );
  if (matchingPending.length > 0) {
    return unverified(
      claim,
      rule,
      evidence,
      "Matching tool call is still pending approval or execution.",
    );
  }

  const matchingFailed = findMatchingTools(claim.kind, evidence.tools).filter(
    isFailedTool,
  );
  const evidenceIds = verifiedEvidenceIds(claim.kind, evidence);
  if (evidenceIds.length > 0) {
    return {
      ...claim,
      status: "verified",
      ruleId: rule.id,
      evidenceToolCallIds: evidenceIds,
    };
  }

  if (matchingFailed.length > 0) {
    return unverified(
      claim,
      rule,
      evidence,
      "Matching tool call failed or returned an error result.",
    );
  }

  return unverified(claim, rule, evidence, "No matching successful evidence.");
}

function verifiedEvidenceIds(
  kind: ClaimKind,
  evidence: FinalizationEvidence,
): string[] {
  switch (kind) {
    case "file_write":
    case "file_edit": {
      const diffIds = evidence.diffs
        .map((diff) => diff.toolCallId)
        .filter((id): id is string => Boolean(id));
      const fileToolIds = successfulMatchingTools(kind, evidence.tools).map(
        (tool) => tool.id,
      );
      return dedupe([...diffIds, ...fileToolIds]);
    }
    case "email_sent":
    case "draft_created":
    case "db_persisted":
    case "browser_action":
    case "tool_completed":
      return successfulMatchingTools(kind, evidence.tools).map(
        (tool) => tool.id,
      );
    case "publisher_unavailable":
      return evidence.tools
        .filter(isSuccessfulPublisherAbsenceVerification)
        .map((tool) => tool.id);
  }
}

function buildSafeDisplayText(
  displayText: string,
  claims: ValidatedClaim[],
  evidence: FinalizationEvidence,
): string {
  const sentences = splitSentences(displayText);
  const unverifiedBySentence = new Map<number, ValidatedClaim[]>();
  for (const claim of claims) {
    if (claim.status === "verified") continue;
    const existing = unverifiedBySentence.get(claim.sentenceIndex) ?? [];
    existing.push(claim);
    unverifiedBySentence.set(claim.sentenceIndex, existing);
  }

  const safeSentences = sentences.map((sentence) => {
    const unverifiedClaims = unverifiedBySentence.get(sentence.index);
    if (!unverifiedClaims || unverifiedClaims.length === 0) {
      return sentence.text;
    }
    const rewrites = [...unverifiedClaims]
      .sort((a, b) => a.sentenceOffset - b.sentenceOffset)
      .map((claim) => {
        const rule = ruleForClaim(claim.kind);
        return rule.safeRewrite(claim, evidence);
      });
    return dedupe(rewrites).join(" ");
  });

  return safeSentences.join(" ").trim();
}

function ruleForClaim(kind: ClaimKind): FinalizationRule {
  const rule = INITIAL_FINALIZATION_RULES.find(
    (candidate) => candidate.claimKind === kind,
  );
  if (!rule) {
    throw new Error(`Missing finalization rule for claim kind: ${kind}`);
  }
  return rule;
}

function unverified(
  claim: ExtractedClaim,
  rule: FinalizationRule,
  evidence: FinalizationEvidence,
  reason: string,
): ValidatedClaim {
  return {
    ...claim,
    status: "unverified",
    ruleId: rule.id,
    evidenceToolCallIds: [],
    reason,
    safeRewrite: rule.safeRewrite(claim, evidence),
  };
}

function successfulMatchingTools(
  kind: ClaimKind,
  tools: readonly ToolEvidence[],
): ToolEvidence[] {
  return findMatchingTools(kind, tools).filter(
    (tool) => !isPendingTool(tool) && !isFailedTool(tool),
  );
}

function findMatchingTools(
  kind: ClaimKind,
  tools: readonly ToolEvidence[],
): ToolEvidence[] {
  switch (kind) {
    case "file_write":
    case "file_edit":
      return tools.filter((tool) =>
        matchesTool(tool, /write_file|create_file|edit|patch|diff|file/i),
      );
    case "email_sent":
      return tools.filter((tool) =>
        matchesTool(
          tool,
          /messages?_send|post_messages_send|send_email|send-message|\bsend\b/i,
        ),
      );
    case "draft_created":
      return tools.filter((tool) =>
        matchesTool(tool, /draft|drafts|create_draft|post_drafts/i),
      );
    case "db_persisted":
      return tools.filter((tool) =>
        matchesTool(
          tool,
          /run_sql|run_sql_transaction|database|serendb|postgres|db/i,
        ),
      );
    case "publisher_unavailable":
      return tools.filter((tool) =>
        matchesTool(tool, /publisher|gateway|list_agent_publishers|mcp/i),
      );
    case "browser_action":
      return tools.filter((tool) =>
        matchesTool(
          tool,
          /playwright|browser|screenshot|click|navigate|fill|select|scrape|extract/i,
        ),
      );
    case "tool_completed":
      return [...tools];
  }
}

function matchesTool(tool: ToolEvidence, pattern: RegExp): boolean {
  return pattern.test(
    `${tool.name} ${tool.title} ${tool.kind} ${tool.result ?? ""}`,
  );
}

function isSuccessfulPublisherAbsenceVerification(tool: ToolEvidence): boolean {
  // A successful no-argument list_agent_publishers call is the live catalog
  // evidence the agent is instructed to gather; the absence determination is
  // its client-side filter over that list. The real tool returns the catalog
  // as JSON ({"publishers":[...]}), never prose like "not found", so requiring
  // absence phrasing in the result made this unsatisfiable (#2918). A failed or
  // malformed lookup is still excluded so it can never stand in for real
  // evidence (#2910).
  return !isFailedTool(tool) && matchesTool(tool, /list_agent_publishers/i);
}

function isFailedTool(tool: ToolEvidence): boolean {
  return (
    tool.isError ||
    /error|failed|failure|denied|rejected|cancelled|canceled/i.test(tool.status)
  );
}

function isPendingTool(tool: ToolEvidence): boolean {
  return /pending|running|in[_-]?progress|approval|waiting/i.test(tool.status);
}

function dedupe<T>(items: T[]): T[] {
  return [...new Set(items)];
}
