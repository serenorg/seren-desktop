// ABOUTME: Formats tool result content for human-readable display.
// ABOUTME: Parses JSON strings and pretty-prints them with proper indentation.

/**
 * Takes a string that may contain JSON and returns a formatted version.
 * If the string is valid JSON, it's pretty-printed. Otherwise returned as-is
 * with common escape sequences unescaped.
 */
export function formatToolResultText(text: string): string {
  const trimmed = text.trim();
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      const parsed = JSON.parse(trimmed);
      return JSON.stringify(parsed, null, 2);
    } catch {
      // Not valid JSON, fall through
    }
  }
  // Unescape common escape sequences from stringified JSON
  return text.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, '"');
}
