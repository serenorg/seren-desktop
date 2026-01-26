// ABOUTME: PKCE (Proof Key for Code Exchange) utilities for OAuth 2.1 security.
// ABOUTME: Generates code verifier and challenge for secure authorization code flow.

/**
 * Generate a cryptographically random code verifier for PKCE.
 * Returns a URL-safe base64 string of 43-128 characters.
 */
export function generateCodeVerifier(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return base64UrlEncode(array);
}

/**
 * Generate the code challenge from a code verifier using S256 method.
 * SHA-256 hash of the verifier, base64url encoded.
 */
export async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return base64UrlEncode(new Uint8Array(hashBuffer));
}

/**
 * Generate a cryptographically random state parameter.
 * Used to prevent CSRF attacks during OAuth flow.
 */
export function generateState(): string {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return base64UrlEncode(array);
}

/**
 * Base64url encode a Uint8Array (RFC 4648 Section 5).
 * No padding, URL-safe alphabet.
 */
function base64UrlEncode(buffer: Uint8Array): string {
  const base64 = btoa(String.fromCharCode(...buffer));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
