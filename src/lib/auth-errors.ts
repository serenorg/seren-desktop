// ABOUTME: Shared auth error detection for UI components.
// ABOUTME: Identifies authentication failures from error messages.

/** Patterns that indicate an authentication/session error. */
const AUTH_ERROR_PATTERNS = [
  /401/i,
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
];

/**
 * Check if an error message indicates an authentication/session failure.
 * Used by both ChatContent and AgentChat to detect auth errors
 * and show appropriate recovery UI (re-login prompts).
 */
export function isAuthError(msg: string | null | undefined): boolean {
  if (!msg) return false;
  return AUTH_ERROR_PATTERNS.some((pattern) => pattern.test(msg));
}
