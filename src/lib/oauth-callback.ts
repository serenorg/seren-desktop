// ABOUTME: Parses publisher OAuth deep-link callback URLs (seren://oauth/callback or loopback).
// ABOUTME: Extracts a user-facing error message, preferring the Gateway's error_description.

/**
 * Inspect an OAuth callback URL and return a user-facing error message when the
 * Gateway reported a failure, or null when the callback is a success (or cannot
 * be parsed).
 *
 * The Gateway's `GET /oauth/{provider}/callback` redirects back with `error`
 * plus a human-readable `error_description` on failure. We prefer the
 * description so the user learns *why* the connection failed (e.g. "OAuth
 * provider did not return a stable account identifier") instead of an opaque
 * `callback_failed` code.
 */
export function describeOAuthCallbackError(url: string): string | null {
  let params: URLSearchParams;
  try {
    params = new URL(url).searchParams;
  } catch {
    return null;
  }
  const error = params.get("error");
  if (!error) return null;
  const description = params.get("error_description")?.trim();
  return description
    ? `Connection failed: ${description}`
    : `OAuth error: ${error}`;
}
