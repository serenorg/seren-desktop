// ABOUTME: Authentication service for login, logout, and token management.
// ABOUTME: Uses OAuth 2.1 with PKCE for secure authentication with SerenDB API.

import { getToken, clearToken, isTauriRuntime } from "@/lib/tauri-bridge";
import { startOAuthLogin, getCurrentUser, revokeToken, type UserInfo, type OAuthTokens } from "@/services/oauth";

export interface LoginResponse {
  tokens: OAuthTokens;
  user: UserInfo;
}

export interface AuthError {
  message: string;
  code?: string;
}

/**
 * Login using OAuth 2.1 with PKCE.
 * Opens browser to SerenDB authorization page.
 * @throws Error on authentication failure
 */
export async function login(): Promise<LoginResponse> {
  if (!isTauriRuntime()) {
    throw new Error("Login requires Tauri runtime");
  }

  // Start OAuth flow
  const tokens = await startOAuthLogin();

  // Fetch user info
  const user = await getCurrentUser(tokens.access_token);

  return { tokens, user };
}

/**
 * Logout and clear stored token.
 * Optionally revokes the token on the server.
 */
export async function logout(): Promise<void> {
  const token = await getToken();

  // Revoke token on server (best effort)
  if (token) {
    await revokeToken(token);
  }

  // Clear local token
  await clearToken();
}

/**
 * Check if user is logged in (has stored token).
 */
export async function isLoggedIn(): Promise<boolean> {
  const token = await getToken();
  return token !== null;
}

/**
 * Get stored authentication token.
 * Returns null if not logged in.
 */
export { getToken };
