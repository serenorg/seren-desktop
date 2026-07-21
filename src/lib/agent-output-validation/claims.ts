// ABOUTME: Deterministic claim extraction for Verified Agent Output.
// ABOUTME: Finds concrete completion claims without relying on model self-reporting.

import type { ClaimKind, ExtractedClaim, SentenceSpan } from "./types";

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

// Sentence spans carry offsets into the untouched source so callers can splice
// a rewrite in place instead of rebuilding the message. Two bounds keep a
// rewrite from destroying markdown (#3105): a sentence never crosses a line
// break, because ordered-list markers and dotted filenames otherwise open a
// "sentence" that swallows blank lines and whole blocks before the next
// terminator; and fenced code is skipped entirely, so prose rules can never
// overwrite a line of code.
export function splitSentences(text: string): SentenceSpan[] {
  const spans: SentenceSpan[] = [];
  let lineStart = 0;
  let inFence = false;

  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
    } else if (!inFence) {
      for (const match of line.matchAll(/[^.!?]+[.!?]?/g)) {
        const raw = match[0];
        const trimmed = raw.trim();
        if (!trimmed) continue;
        const start =
          lineStart + match.index + (raw.length - raw.trimStart().length);
        spans.push({
          index: spans.length,
          text: trimmed.replace(/\s+/g, " "),
          start,
          end: start + trimmed.length,
        });
      }
    }
    lineStart += line.length + 1;
  }

  return spans;
}

function dedupeSentenceClaims(claims: ExtractedClaim[]): ExtractedClaim[] {
  const seen = new Set<ClaimKind>();
  return claims.filter((claim) => {
    if (seen.has(claim.kind)) return false;
    seen.add(claim.kind);
    return true;
  });
}
