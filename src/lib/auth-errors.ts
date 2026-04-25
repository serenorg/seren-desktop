// ABOUTME: Shared auth error detection for UI components.
// ABOUTME: Identifies authentication failures from error messages.

/** Patterns that indicate an authentication/session error. */
const AUTH_ERROR_PATTERNS = [
  /login required/i,
  /claude login/i,
  /not logged in/i,
  /authentication required/i,
  /authentication_error/i,
  /failed to authenticate/i,
  /auth required/i,
  /oauth token has expired/i,
  /token has expired/i,
  /token expired/i,
  /session expired/i,
  /not authenticated/i,
  /please obtain a new token/i,
  /refresh your existing token/i,
  /no refresh token/i,
  /no access token/i,
  /please sign in/i,
  /does not have access/i,
  /please login again/i,
  /re-authenticate/i,
];

/**
 * Max length of a genuine auth error message. Real auth errors from CLI tools
 * are short (< 500 chars). Longer messages are normal assistant responses that
 * happen to contain auth-related phrases in tool output or code discussion.
 */
const AUTH_ERROR_MAX_LENGTH = 500;

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

/** Patterns that indicate a context-window overflow from the provider. */
const CONTEXT_OVERFLOW_PATTERNS = [
  /prompt is too long/i,
  /context (length|window).*exceed/i,
];

/**
 * Check if an error message indicates the provider rejected the prompt
 * because the conversation exceeded its context window. When the user is
 * also unauthenticated this is a hidden auth failure — auto-compaction
 * is gated on auth (#1641), so the overflow is the symptom, not the cause.
 * See #1652.
 */
export function isContextOverflowError(
  msg: string | null | undefined,
): boolean {
  if (!msg) return false;
  return CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(msg));
}
