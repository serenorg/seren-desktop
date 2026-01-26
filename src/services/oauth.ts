// ABOUTME: OAuth 2.1 authentication service for SerenDB API.
// ABOUTME: Implements PKCE flow with localhost callback for secure desktop auth.

import { invoke } from "@tauri-apps/api/core";
import { API_BASE } from "@/lib/config";
import { generateCodeVerifier, generateCodeChallenge, generateState } from "@/lib/pkce";
import { storeToken, isTauriRuntime } from "@/lib/tauri-bridge";
import { openExternalLink } from "@/lib/external-link";

// OAuth client configuration for seren-desktop
const OAUTH_CLIENT_ID = "seren-desktop";
const OAUTH_SCOPES = "openid profile email";
const CALLBACK_PATH = "/oauth/callback";

export interface OAuthTokens {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}

export interface UserInfo {
  id: string;
  email: string;
  name?: string;
}

export interface OAuthError {
  error: string;
  error_description?: string;
}

// Pending OAuth request state (stored in memory during auth flow)
let pendingAuth: {
  codeVerifier: string;
  state: string;
  port: number;
} | null = null;

/**
 * Start the OAuth login flow.
 * Opens browser to authorization URL and waits for callback.
 */
export async function startOAuthLogin(): Promise<OAuthTokens> {
  if (!isTauriRuntime()) {
    throw new Error("OAuth login requires Tauri runtime");
  }

  // Generate PKCE parameters
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  const state = generateState();

  // Start localhost callback server
  const port = await invoke<number>("start_oauth_callback_server");
  const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;

  // Store pending auth state
  pendingAuth = { codeVerifier, state, port };

  // Build authorization URL
  const authUrl = new URL(`${API_BASE}/oauth2/authorize`);
  authUrl.searchParams.set("client_id", OAUTH_CLIENT_ID);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", OAUTH_SCOPES);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  // Open browser to authorization URL
  await openExternalLink(authUrl.toString());

  // Wait for callback
  try {
    const callbackResult = await invoke<{ code?: string; state?: string; error?: string; error_description?: string }>(
      "wait_oauth_callback"
    );

    if (callbackResult.error) {
      throw new Error(callbackResult.error_description || callbackResult.error);
    }

    if (!callbackResult.code || !callbackResult.state) {
      throw new Error("Invalid OAuth callback: missing code or state");
    }

    // Verify state matches
    if (callbackResult.state !== pendingAuth.state) {
      throw new Error("OAuth state mismatch - possible CSRF attack");
    }

    // Exchange code for tokens
    const tokens = await exchangeCodeForTokens(
      callbackResult.code,
      redirectUri,
      codeVerifier
    );

    // Store access token securely
    await storeToken(tokens.access_token);

    return tokens;
  } finally {
    // Clean up
    pendingAuth = null;
    await invoke("stop_oauth_callback_server").catch(() => {});
  }
}

/**
 * Exchange authorization code for tokens.
 */
async function exchangeCodeForTokens(
  code: string,
  redirectUri: string,
  codeVerifier: string
): Promise<OAuthTokens> {
  const tokenUrl = `${API_BASE}/oauth2/token`;

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: OAUTH_CLIENT_ID,
    code_verifier: codeVerifier,
  });

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const error: OAuthError = await response.json().catch(() => ({
      error: "token_exchange_failed",
      error_description: "Failed to exchange authorization code for tokens",
    }));
    throw new Error(error.error_description || error.error);
  }

  return response.json();
}

/**
 * Refresh access token using refresh token.
 */
export async function refreshAccessToken(refreshToken: string): Promise<OAuthTokens> {
  const tokenUrl = `${API_BASE}/oauth2/token`;

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: OAUTH_CLIENT_ID,
  });

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const error: OAuthError = await response.json().catch(() => ({
      error: "refresh_failed",
      error_description: "Failed to refresh access token",
    }));
    throw new Error(error.error_description || error.error);
  }

  const tokens: OAuthTokens = await response.json();

  // Store new access token
  await storeToken(tokens.access_token);

  return tokens;
}

/**
 * Get current user info using access token.
 */
export async function getCurrentUser(accessToken: string): Promise<UserInfo> {
  const response = await fetch(`${API_BASE}/auth/me`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error("Failed to fetch user info");
  }

  const data = await response.json();
  return data.data;
}

/**
 * Revoke tokens (logout).
 */
export async function revokeToken(token: string): Promise<void> {
  const revokeUrl = `${API_BASE}/oauth2/revoke`;

  const body = new URLSearchParams({
    token,
    client_id: OAUTH_CLIENT_ID,
  });

  // Best effort - don't fail logout if revoke fails
  await fetch(revokeUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  }).catch(() => {});
}
