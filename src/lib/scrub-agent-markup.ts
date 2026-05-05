// ABOUTME: Strip Claude Code CLI scaffolding tags from model output before
// ABOUTME: persistence, rendering, and Seren memory storage. #1807.

const PATTERNS: RegExp[] = [
  /<system-reminder>[\s\S]*?<\/system-reminder>/g,
  /<command-(message|name|args)>[\s\S]*?<\/command-\1>/g,
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
