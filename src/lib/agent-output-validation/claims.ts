// ABOUTME: Deterministic claim extraction for Verified Agent Output.
// ABOUTME: Finds concrete completion claims without relying on model self-reporting.

import type { ClaimKind, ExtractedClaim } from "./types";

type ClaimMatcher = {
  kind: ClaimKind;
  pattern: RegExp;
};

const CLAIM_MATCHERS: ClaimMatcher[] = [
  {
    kind: "email_sent",
    pattern:
      /\b(sent|emailed|delivered|posted)\b[\s\S]{0,80}\b(email|e-mail|message|gmail|outlook)\b/i,
  },
  {
    kind: "draft_created",
    pattern:
      /\b(created|prepared|saved|wrote)\b[\s\S]{0,80}\b(email draft|draft email|draft|gmail draft|outlook draft)\b/i,
  },
  {
    kind: "file_write",
    pattern:
      /\b(created|wrote|saved|generated|added)\b[\s\S]{0,80}\b(file|document|readme|markdown|json|csv|ya?ml|\.([a-z0-9]{1,8}))\b/i,
  },
  {
    kind: "file_edit",
    pattern:
      /\b(edited|updated|modified|patched|changed|fixed)\b[\s\S]{0,100}\b(file|code|source|component|module|\.([a-z0-9]{1,8}))\b/i,
  },
  {
    kind: "db_persisted",
    pattern:
      /\b(saved|persisted|stored|inserted|upserted|wrote|committed)\b[\s\S]{0,100}\b(database|db|serendb|postgres|sql|table|record|row)\b/i,
  },
  {
    kind: "publisher_unavailable",
    pattern:
      /\b(unavailable|not available|not configured|could not access|can't access|cannot access|no .*integration|no .*tool|publisher .*not found)\b/i,
  },
  {
    kind: "browser_action",
    pattern:
      /\b(clicked|opened|navigated|filled|selected|screenshotted|scraped|extracted|took a screenshot)\b[\s\S]{0,100}\b(browser|website|page|form|button|screenshot|url)\b/i,
  },
  {
    kind: "tool_completed",
    pattern:
      /\b(completed|finished|ran|executed|submitted|posted|called)\b[\s\S]{0,80}\b(tool|command|script|request|job|workflow|operation)\b/i,
  },
];

export function extractClaims(finalText: string): ExtractedClaim[] {
  const sentences = splitSentences(finalText);
  const claims: ExtractedClaim[] = [];

  sentences.forEach((sentence, sentenceIndex) => {
    const sentenceClaims: ExtractedClaim[] = [];
    for (const matcher of CLAIM_MATCHERS) {
      const match = matcher.pattern.exec(sentence.text);
      if (!match) continue;
      sentenceClaims.push({
        id: `${sentenceIndex}:${matcher.kind}`,
        kind: matcher.kind,
        text: sentence.text.trim(),
        sentence: sentence.text.trim(),
        sentenceIndex,
        sentenceOffset: match.index,
      });
    }
    claims.push(...dedupeSentenceClaims(sentenceClaims));
  });

  return claims;
}

export function splitSentences(
  text: string,
): Array<{ index: number; text: string }> {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  const matches = normalized.match(/[^.!?]+[.!?]?/g);
  return (matches ?? [normalized])
    .map((part, index) => ({ index, text: part.trim() }))
    .filter((part) => part.text.length > 0);
}

function dedupeSentenceClaims(claims: ExtractedClaim[]): ExtractedClaim[] {
  const seen = new Set<ClaimKind>();
  return claims.filter((claim) => {
    if (seen.has(claim.kind)) return false;
    seen.add(claim.kind);
    return true;
  });
}
