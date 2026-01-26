// ABOUTME: OAuth service for provider authentication flows.
// ABOUTME: Handles PKCE-based OAuth 2.0 for OpenAI and Google Gemini.

import type { OAuthCredentials, ProviderId } from "@/lib/providers/types";
import { PROVIDER_CONFIGS, supportsOAuth } from "@/lib/providers/types";
import { isTauriRuntime } from "@/lib/tauri-bridge";

// OAuth state storage (in-memory during auth flow)
interface OAuthState {
  providerId: ProviderId;
  codeVerifier: string;
  state: string;
  redirectUri: string;
}

let pendingOAuthState: OAuthState | null = null;

/**
 * Generate a cryptographically random string for PKCE.
 */
function generateRandomString(length: number): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const randomValues = new Uint8Array(length);
  crypto.getRandomValues(randomValues);
  return Array.from(randomValues, (v) => chars[v % chars.length]).join("");
}

/**
 * Generate PKCE code challenge from verifier.
 */
async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const hash = await crypto.subtle.digest("SHA-256", data);
  // Base64url encode the hash
  const base64 = btoa(String.fromCharCode(...new Uint8Array(hash)));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Get the OAuth redirect URI for this app.
 */
function getRedirectUri(): string {
  if (isTauriRuntime()) {
    // Tauri deep link
    return "seren://oauth/callback";
  }
  // Browser fallback (for development)
  return `${window.location.origin}/oauth/callback`;
}

/**
 * Start OAuth flow for a provider.
 * Opens the authorization URL in the user's browser.
 */
export async function startOAuthFlow(providerId: ProviderId): Promise<void> {
  if (!supportsOAuth(providerId)) {
    throw new Error(`Provider ${providerId} does not support OAuth`);
  }

  const config = PROVIDER_CONFIGS[providerId];
  const oauthConfig = config.oauth;
  if (!oauthConfig) {
    throw new Error(`OAuth configuration not found for ${providerId}`);
  }

  if (!oauthConfig.clientId) {
    throw new Error(
      `OAuth client ID not configured for ${providerId}. Please configure in settings.`,
    );
  }

  // Generate PKCE values
  const codeVerifier = generateRandomString(64);
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  const state = generateRandomString(32);
  const redirectUri = getRedirectUri();

  // Store state for callback verification
  pendingOAuthState = {
    providerId,
    codeVerifier,
    state,
    redirectUri,
  };

  // Build authorization URL
  const params = new URLSearchParams({
    response_type: "code",
    client_id: oauthConfig.clientId,
    redirect_uri: redirectUri,
    scope: oauthConfig.scopes.join(" "),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  const authUrl = `${oauthConfig.authUrl}?${params.toString()}`;

  // Open in browser
  if (isTauriRuntime()) {
    const { open } = await import("@tauri-apps/plugin-shell");
    await open(authUrl);
  } else {
    window.open(authUrl, "_blank");
  }
}

/**
 * Handle OAuth callback with authorization code.
 * Exchanges code for tokens.
 */
export async function handleOAuthCallback(
  code: string,
  state: string,
): Promise<OAuthCredentials> {
  if (!pendingOAuthState) {
    throw new Error("No pending OAuth flow. Please start the flow again.");
  }

  // Verify state
  if (state !== pendingOAuthState.state) {
    pendingOAuthState = null;
    throw new Error("OAuth state mismatch. Please try again.");
  }

  const { providerId, codeVerifier, redirectUri } = pendingOAuthState;
  const config = PROVIDER_CONFIGS[providerId];
  const oauthConfig = config.oauth;

  if (!oauthConfig) {
    pendingOAuthState = null;
    throw new Error(`OAuth configuration not found for ${providerId}`);
  }

  // Exchange code for tokens
  const tokenParams = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: oauthConfig.clientId,
    code_verifier: codeVerifier,
  });

  const response = await fetch(oauthConfig.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: tokenParams.toString(),
  });

  if (!response.ok) {
    pendingOAuthState = null;
    const error = await response.text();
    throw new Error(`Token exchange failed: ${error}`);
  }

  const tokenData = await response.json();
  pendingOAuthState = null;

  const credentials: OAuthCredentials = {
    type: "oauth",
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
    expiresAt: tokenData.expires_in
      ? Date.now() + tokenData.expires_in * 1000
      : undefined,
    tokenType: tokenData.token_type || "Bearer",
    scope: tokenData.scope,
    validatedAt: Date.now(),
  };

  return credentials;
}

/**
 * Refresh an OAuth token.
 */
export async function refreshOAuthToken(
  providerId: ProviderId,
  refreshToken: string,
): Promise<OAuthCredentials> {
  const config = PROVIDER_CONFIGS[providerId];
  const oauthConfig = config.oauth;

  if (!oauthConfig) {
    throw new Error(`OAuth configuration not found for ${providerId}`);
  }

  const tokenParams = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: oauthConfig.clientId,
  });

  const response = await fetch(oauthConfig.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: tokenParams.toString(),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Token refresh failed: ${error}`);
  }

  const tokenData = await response.json();

  return {
    type: "oauth",
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token || refreshToken,
    expiresAt: tokenData.expires_in
      ? Date.now() + tokenData.expires_in * 1000
      : undefined,
    tokenType: tokenData.token_type || "Bearer",
    scope: tokenData.scope,
    validatedAt: Date.now(),
  };
}

/**
 * Check if OAuth credentials need refresh.
 */
export function needsRefresh(credentials: OAuthCredentials): boolean {
  if (!credentials.expiresAt) {
    return false;
  }
  // Refresh if less than 5 minutes until expiry
  return credentials.expiresAt - Date.now() < 5 * 60 * 1000;
}

/**
 * Get the pending OAuth provider (if flow is in progress).
 */
export function getPendingOAuthProvider(): ProviderId | null {
  return pendingOAuthState?.providerId || null;
}

/**
 * Cancel any pending OAuth flow.
 */
export function cancelOAuthFlow(): void {
  pendingOAuthState = null;
}
