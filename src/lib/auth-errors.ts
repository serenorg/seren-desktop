// ABOUTME: Shared auth error detection for UI components.
// ABOUTME: Identifies authentication failures from error messages.

/** Patterns that indicate an authentication/session error. */
const AUTH_ERROR_PATTERNS = [
  /login required/i,
  /claude login/i,
  /not logged in/i,
  /authentication required/i,
  /authentication_error/i,
  /auth required/i,
  /oauth token has expired/i,
  /token has expired/i,
  /token expired/i,
  /session expired/i,
  /not authenticated/i,
  /please obtain a new token/i,
  /refresh your existing token/i,
  /please sign in/i,
  /does not have access/i,
  /please login again/i,
];

/**
 * Max length of a genuine auth error message. CLI tools sometimes wrap the
 * underlying error in JSON (e.g. Claude Code's "Failed to authenticate. API
 * Error: 401 {...}") which can exceed 500 chars. 2000 is still well below a
 * typical assistant response, so false-positives remain unlikely.
 */
const AUTH_ERROR_MAX_LENGTH = 2000;

/**
 * Check if an error message indicates an authentication/session failure.
 * Use for messages already known to be errors (error events, session errors).
 */
export function isAuthError(msg: string | null | undefined): boolean {
  if (!msg) return false;
  return AUTH_ERROR_PATTERNS.some((pattern) => pattern.test(msg));
}

/**
 * Stricter check for auth errors in streamed assistant content.
 * Real auth errors from CLI tools are short messages. Long assistant
 * responses that mention "token expired" in tool output or code
 * discussion should not trigger the auth error banner.
 */
export function isLikelyAuthError(msg: string | null | undefined): boolean {
  if (!msg) return false;
  if (msg.length > AUTH_ERROR_MAX_LENGTH) return false;
  return AUTH_ERROR_PATTERNS.some((pattern) => pattern.test(msg));
}
