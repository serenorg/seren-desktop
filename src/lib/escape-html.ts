// ABOUTME: Utility function to escape HTML special characters.
// ABOUTME: Prevents XSS attacks when inserting user content into the DOM.

const HTML_ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

const ESCAPE_REGEX = /[&<>"']/g;

/**
 * Escapes HTML special characters to prevent XSS attacks.
 * Must be used for all user-provided content displayed with innerHTML.
 */
export function escapeHtml(text: string): string {
  return text.replace(ESCAPE_REGEX, (char) => HTML_ESCAPE_MAP[char]);
}
