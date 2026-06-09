// ABOUTME: Classifies gateway publisher OAuth failures for reconnect and connect UX.
// ABOUTME: Covers refresh failures, missing first connections, and Google scope 403s.

export type OAuthConnectActionReason =
  | "connection_required"
  | "scope_insufficient";

export interface OAuthConnectAction {
  publisherSlug: string;
  reason: OAuthConnectActionReason;
}

const OAUTH_REFRESH_ERROR_MARKERS = [
  "oauth token refresh failed",
  "token refresh failed",
  "provider error during token refresh",
  "invalid_grant",
  "refresh token expired",
];

const OAUTH_CONNECTION_REQUIRED_MARKERS = [
  "oauth authentication required",
  "oauth connection required",
  "requires oauth",
  "requires user oauth",
  "user oauth required",
  "missing oauth connection",
  "no oauth connection",
  "not connected to oauth",
  "connect your account",
];

const OAUTH_SCOPE_ERROR_MARKERS = [
  "access_token_scope_insufficient",
  "insufficient authentication scopes",
  "insufficient oauth scopes",
  "insufficient_scope",
  "missing required scope",
  "missing oauth scope",
];

function normalizeMessage(message: string): string {
  return message.toLowerCase();
}

function includesAny(message: string, markers: readonly string[]): boolean {
  const lowerMessage = normalizeMessage(message);
  return markers.some((marker) => lowerMessage.includes(marker));
}

export function isOAuthScopeError(message: string): boolean {
  return includesAny(message, OAUTH_SCOPE_ERROR_MARKERS);
}

export function isOAuthConnectionRequiredError(message: string): boolean {
  return includesAny(message, OAUTH_CONNECTION_REQUIRED_MARKERS);
}

/**
 * Check if an error message indicates an OAuth token issue.
 * These errors mean the user's OAuth connection needs to be refreshed.
 */
export function isOAuthTokenError(message: string): boolean {
  return (
    includesAny(message, OAUTH_REFRESH_ERROR_MARKERS) ||
    isOAuthConnectionRequiredError(message) ||
    isOAuthScopeError(message)
  );
}

export function parseGatewayPublisherSlug(
  toolName: string | null | undefined,
): string | null {
  if (!toolName?.startsWith("gateway__")) return null;
  const rest = toolName.slice("gateway__".length);
  const separatorIndex = rest.indexOf("__");
  if (separatorIndex === -1) return null;
  return rest.slice(0, separatorIndex) || null;
}

export function getOAuthConnectActionForToolError(
  toolName: string | null | undefined,
  errorMessage: string | null | undefined,
): OAuthConnectAction | null {
  if (!errorMessage) return null;
  const publisherSlug = parseGatewayPublisherSlug(toolName);
  if (!publisherSlug) return null;

  if (isOAuthConnectionRequiredError(errorMessage)) {
    return { publisherSlug, reason: "connection_required" };
  }
  if (isOAuthScopeError(errorMessage)) {
    return { publisherSlug, reason: "scope_insufficient" };
  }
  return null;
}
