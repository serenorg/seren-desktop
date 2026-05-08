// ABOUTME: Strip Claude Code CLI scaffolding tags from model output before
// ABOUTME: persistence, rendering, and Seren memory storage. #1807.

const PATTERNS: RegExp[] = [
  // #1840: accept either close tag for the scaffolding families. The model
  // occasionally opens a <system-reminder> block and closes it with
  // </thinking> (or vice versa); the well-formed pair regex no-ops and raw
  // markup leaks into the rendered chat bubble.
  /<system-reminder>[\s\S]*?<\/(?:system-reminder|thinking)>/g,
  /<thinking>[\s\S]*?<\/(?:thinking|system-reminder)>/g,
  /<command-(message|name|args)>[\s\S]*?<\/command-\1>/g,
  // Sweep orphan scaffolding tags that escape paired matching (truncation,
  // partial streams, or model-emitted bare markers). These are
  // model-internal and must never reach the user.
  /<\/?(?:system-reminder|thinking)>/g,
  // #1827: post-compaction seed-ack stock pattern. The compaction seed prompt
  // ("Confirm you have this context… wait for the user's next message") plus
  // the runtime's <system-reminder> injections produce a meta-acknowledgement
  // turn. The role==="standby" event filter is the primary guard; this regex
  // is the second layer for races, refactors, and seed-prompt rewordings.
  /I(?:'ll| will) acknowledge the system reminders\.[^\n]*?standing by[.!]?/gi,
];

/**
 * Remove Claude Code scaffolding tags that the model occasionally echoes into
 * its assistant text. Persisting them poisons the JSONL transcript and Seren
 * memory, which makes the model continue extending the pattern on subsequent
 * turns. `<command-stdout>` / `<local-command-stdout>` are intentionally
 * preserved — they are legitimate captured shell output.
 */
export function scrubAgentMarkup(text: string): string {
  if (!text) return text;
  let result = text;
  for (const pattern of PATTERNS) {
    result = result.replace(pattern, "");
  }
  return result.replace(/\n{3,}/g, "\n\n").trim();
}
