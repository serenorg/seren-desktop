// ABOUTME: MCP OAuth2 service for authenticating with mcp.serendb.com.
// ABOUTME: Implements Dynamic Client Registration and Authorization Code flow with PKCE (S256).

import { invoke } from "@tauri-apps/api/core";
import { MCP_OAUTH_BASE } from "@/lib/config";
import { appFetch } from "@/lib/fetch";

// MCP server uses dynamic client registration
const MCP_CLIENT_NAME = "Seren Desktop";
// Use loopback redirect - webviews can intercept HTTP navigations but not custom schemes
// The MCP server allows any loopback address (127.0.0.1, localhost, [::1])
const REDIRECT_URI = "http://127.0.0.1/oauth/callback";

// Token storage keys
const MCP_TOKEN_STORE = "mcp-oauth.json";
const ACCESS_TOKEN_KEY = "mcp_access_token";
const REFRESH_TOKEN_KEY = "mcp_refresh_token";
const TOKEN_EXPIRY_KEY = "mcp_token_expiry";
const CLIENT_ID_KEY = "mcp_client_id";

/**
 * OAuth state for tracking authorization flow.
 */
interface OAuthState {
  codeVerifier: string;
  state: string;
  nonce: string;
}

/**
 * Token response from MCP OAuth server.
 */
interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}

/**
 * Client registration response from MCP OAuth server.
 */
interface ClientRegistrationResponse {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: string;
}

/**
 * OAuth discovery metadata.
 */
interface OAuthMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  response_types_supported?: string[];
  code_challenge_methods_supported?: string[];
}

// Current OAuth state (in-memory during flow)
let currentOAuthState: OAuthState | null = null;

// Cached client ID (loaded from storage on first use)
let cachedClientId: string | null = null;

/**
 * Generate a cryptographically secure random string.
 */
function generateRandomString(length: number): string {
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

/**
 * Generate PKCE code verifier (43-128 characters, URL-safe).
 */
function generateCodeVerifier(): string {
  // 32 bytes = 64 hex chars, within the 43-128 range
  return generateRandomString(32);
}

/**
 * Generate PKCE code challenge from verifier using S256.
 */
async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const hash = await crypto.subtle.digest("SHA-256", data);

  // Base64url encode (no padding)
  const base64 = btoa(String.fromCharCode(...new Uint8Array(hash)));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Get or register the OAuth client with the MCP server.
 * Uses dynamic client registration per RFC 7591.
 */
async function getOrRegisterClient(): Promise<string> {
  // Check cache first
  if (cachedClientId) {
    return cachedClientId;
  }

  // Check stored client ID
  const storedClientId = await getStoredClientId();
  if (storedClientId) {
    cachedClientId = storedClientId;
    return storedClientId;
  }

  // Register new client
  console.log("[MCP OAuth] Registering new OAuth client...");
  const response = await appFetch(`${MCP_OAUTH_BASE}/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_name: MCP_CLIENT_NAME,
      redirect_uris: [REDIRECT_URI],
      response_types: ["code"],
      grant_types: ["authorization_code", "refresh_token"],
      scope: "api",
      token_endpoint_auth_method: "none",
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Client registration failed: ${response.status} ${error}`);
  }

  const registration: ClientRegistrationResponse = await response.json();
  console.log("[MCP OAuth] Client registered:", registration.client_id);

  // Store client ID
  await storeClientId(registration.client_id);
  cachedClientId = registration.client_id;

  return registration.client_id;
}

/**
 * Fetch OAuth server metadata from well-known endpoint.
 */
export async function fetchOAuthMetadata(): Promise<OAuthMetadata> {
  const response = await appFetch(
    `${MCP_OAUTH_BASE}/.well-known/oauth-authorization-server`,
  );
  if (!response.ok) {
    throw new Error(`Failed to fetch OAuth metadata: ${response.status}`);
  }
  return response.json();
}

/**
 * Start the OAuth authorization flow.
 * Returns the authorization URL to open in the popup webview.
 */
export async function startOAuthFlow(): Promise<{
  authUrl: string;
  state: OAuthState;
}> {
  // Clear any stale client registration that might have old redirect_uri
  // This ensures we always use a client registered with the current REDIRECT_URI
  const storedClientId = await getStoredClientId();
  if (storedClientId) {
    console.log(
      "[MCP OAuth] Clearing stored client_id to ensure fresh registration with current redirect_uri",
    );
    cachedClientId = null;
    await invoke("set_setting", {
      store: MCP_TOKEN_STORE,
      key: CLIENT_ID_KEY,
      value: "",
    });
  }

  // Get or register client first
  const clientId = await getOrRegisterClient();

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  const state = generateRandomString(16);
  const nonce = generateRandomString(16);

  // Store state for callback verification
  currentOAuthState = { codeVerifier, state, nonce };

  // Build authorization URL
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope: "api",
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  const authUrl = `${MCP_OAUTH_BASE}/authorize?${params.toString()}`;

  return { authUrl, state: currentOAuthState };
}

/**
 * Handle OAuth callback from webview navigation.
 * Extracts code from URL and exchanges for tokens.
 */
export async function handleOAuthCallback(
  callbackUrl: string,
): Promise<TokenResponse> {
  const url = new URL(callbackUrl);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    const errorDescription = url.searchParams.get("error_description");
    throw new Error(`OAuth error: ${error} - ${errorDescription || ""}`);
  }

  if (!code) {
    throw new Error("No authorization code in callback");
  }

  if (!currentOAuthState) {
    throw new Error("No OAuth state - flow not started");
  }

  if (state !== currentOAuthState.state) {
    throw new Error("State mismatch - possible CSRF attack");
  }

  // Exchange code for tokens
  const tokens = await exchangeCodeForTokens(
    code,
    currentOAuthState.codeVerifier,
  );

  // Store tokens
  await storeTokens(tokens);

  // Clear OAuth state
  currentOAuthState = null;

  return tokens;
}

/**
 * Exchange authorization code for access token.
 */
async function exchangeCodeForTokens(
  code: string,
  codeVerifier: string,
): Promise<TokenResponse> {
  const clientId = await getOrRegisterClient();

  const response = await appFetch(`${MCP_OAUTH_BASE}/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: codeVerifier,
    }).toString(),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Token exchange failed: ${response.status} ${error}`);
  }

  return response.json();
}

/**
 * Refresh access token using refresh token.
 */
export async function refreshAccessToken(): Promise<TokenResponse | null> {
  const refreshToken = await getStoredRefreshToken();
  if (!refreshToken) {
    return null;
  }

  const clientId = await getOrRegisterClient();

  try {
    const response = await appFetch(`${MCP_OAUTH_BASE}/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: refreshToken,
      }).toString(),
    });

    if (!response.ok) {
      // Refresh failed - clear tokens and require re-auth
      await clearStoredTokens();
      return null;
    }

    const tokens: TokenResponse = await response.json();
    await storeTokens(tokens);
    return tokens;
  } catch {
    await clearStoredTokens();
    return null;
  }
}

/**
 * Get valid access token, refreshing if needed.
 */
export async function getValidAccessToken(): Promise<string | null> {
  const accessToken = await getStoredAccessToken();
  const expiry = await getStoredTokenExpiry();

  if (!accessToken) {
    return null;
  }

  // Check if token is expired (with 60 second buffer)
  if (expiry && Date.now() >= expiry - 60000) {
    console.log("[MCP OAuth] Token expired, refreshing...");
    const refreshed = await refreshAccessToken();
    return refreshed?.access_token || null;
  }

  return accessToken;
}

/**
 * Check if user is authenticated with MCP.
 */
export async function isMcpAuthenticated(): Promise<boolean> {
  const token = await getValidAccessToken();
  return token !== null;
}

// Token storage functions using Tauri store

async function storeTokens(tokens: TokenResponse): Promise<void> {
  const expiry = Date.now() + tokens.expires_in * 1000;

  await invoke("set_setting", {
    store: MCP_TOKEN_STORE,
    key: ACCESS_TOKEN_KEY,
    value: tokens.access_token,
  });

  await invoke("set_setting", {
    store: MCP_TOKEN_STORE,
    key: TOKEN_EXPIRY_KEY,
    value: expiry.toString(),
  });

  if (tokens.refresh_token) {
    await invoke("set_setting", {
      store: MCP_TOKEN_STORE,
      key: REFRESH_TOKEN_KEY,
      value: tokens.refresh_token,
    });
  }
}

async function storeClientId(clientId: string): Promise<void> {
  await invoke("set_setting", {
    store: MCP_TOKEN_STORE,
    key: CLIENT_ID_KEY,
    value: clientId,
  });
}

async function getStoredClientId(): Promise<string | null> {
  try {
    const result = await invoke<string | null>("get_setting", {
      store: MCP_TOKEN_STORE,
      key: CLIENT_ID_KEY,
    });
    return result && result.length > 0 ? result : null;
  } catch {
    return null;
  }
}

async function getStoredAccessToken(): Promise<string | null> {
  try {
    const result = await invoke<string | null>("get_setting", {
      store: MCP_TOKEN_STORE,
      key: ACCESS_TOKEN_KEY,
    });
    return result && result.length > 0 ? result : null;
  } catch {
    return null;
  }
}

async function getStoredRefreshToken(): Promise<string | null> {
  try {
    const result = await invoke<string | null>("get_setting", {
      store: MCP_TOKEN_STORE,
      key: REFRESH_TOKEN_KEY,
    });
    return result && result.length > 0 ? result : null;
  } catch {
    return null;
  }
}

async function getStoredTokenExpiry(): Promise<number | null> {
  try {
    const result = await invoke<string | null>("get_setting", {
      store: MCP_TOKEN_STORE,
      key: TOKEN_EXPIRY_KEY,
    });
    return result ? Number.parseInt(result, 10) : null;
  } catch {
    return null;
  }
}

export async function clearStoredTokens(): Promise<void> {
  try {
    await invoke("set_setting", {
      store: MCP_TOKEN_STORE,
      key: ACCESS_TOKEN_KEY,
      value: "",
    });
    await invoke("set_setting", {
      store: MCP_TOKEN_STORE,
      key: REFRESH_TOKEN_KEY,
      value: "",
    });
    await invoke("set_setting", {
      store: MCP_TOKEN_STORE,
      key: TOKEN_EXPIRY_KEY,
      value: "",
    });
  } catch (error) {
    console.error("[MCP OAuth] Failed to clear tokens:", error);
  }
}

/**
 * Clear all stored OAuth data including client registration.
 * Use this when redirect URI changes or for complete reset.
 */
export async function clearAllOAuthData(): Promise<void> {
  // Clear in-memory cache
  cachedClientId = null;
  currentOAuthState = null;

  try {
    await invoke("set_setting", {
      store: MCP_TOKEN_STORE,
      key: CLIENT_ID_KEY,
      value: "",
    });
    await clearStoredTokens();
    console.log("[MCP OAuth] All OAuth data cleared");
  } catch (error) {
    console.error("[MCP OAuth] Failed to clear OAuth data:", error);
  }
}

/**
 * Check if a URL is the OAuth callback URL.
 * Matches loopback addresses (127.0.0.1, localhost, [::1]) on any port with /oauth/callback path.
 */
export function isOAuthCallback(url: string): boolean {
  try {
    const parsed = new URL(url);
    const isLoopback =
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "localhost" ||
      parsed.hostname === "[::1]";
    const isCallbackPath = parsed.pathname === "/oauth/callback";
    return isLoopback && isCallbackPath;
  } catch {
    return false;
  }
}

/**
 * Get the current OAuth state (for verification).
 */
export function getCurrentOAuthState(): OAuthState | null {
  return currentOAuthState;
}

/**
 * Clear current OAuth state (e.g., on cancel).
 */
export function clearOAuthState(): void {
  currentOAuthState = null;
}

/**
 * Result from the Rust OAuth browser flow.
 */
interface OAuthCallbackResult {
  code: string;
  state: string;
}

/**
 * Start OAuth flow using the default browser with a loopback server.
 * This is more reliable than webview-based OAuth as it handles all navigation properly.
 *
 * The Rust backend:
 * 1. Starts a local HTTP server on a random port
 * 2. Opens the OAuth URL in the default browser
 * 3. Waits for the callback
 * 4. Returns the authorization code and state
 */
export async function startOAuthBrowserFlow(): Promise<TokenResponse> {
  // Clear any stale client registration
  const storedClientId = await getStoredClientId();
  if (storedClientId) {
    console.log("[MCP OAuth] Clearing stored client_id for fresh registration");
    cachedClientId = null;
    await invoke("set_setting", {
      store: MCP_TOKEN_STORE,
      key: CLIENT_ID_KEY,
      value: "",
    });
  }

  // Get a port from the Rust backend first so we know the redirect URI
  const port = await invoke<number>("get_oauth_callback_port");
  const redirectUri = `http://127.0.0.1:${port}/oauth/callback`;

  console.log("[MCP OAuth] Browser flow - redirect URI:", redirectUri);

  // Register client with the actual redirect URI we'll use
  console.log("[MCP OAuth] Registering OAuth client...");
  const registerResponse = await appFetch(`${MCP_OAUTH_BASE}/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_name: MCP_CLIENT_NAME,
      redirect_uris: [redirectUri],
      response_types: ["code"],
      grant_types: ["authorization_code", "refresh_token"],
      scope: "api",
      token_endpoint_auth_method: "none",
    }),
  });

  if (!registerResponse.ok) {
    const error = await registerResponse.text();
    throw new Error(
      `Client registration failed: ${registerResponse.status} ${error}`,
    );
  }

  const registration: ClientRegistrationResponse =
    await registerResponse.json();
  console.log("[MCP OAuth] Client registered:", registration.client_id);

  // Generate PKCE values
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  const state = generateRandomString(16);
  const nonce = generateRandomString(16);

  // Store state for verification
  currentOAuthState = { codeVerifier, state, nonce };

  // Build authorization URL (without redirect_uri - Rust will add it)
  const params = new URLSearchParams({
    response_type: "code",
    client_id: registration.client_id,
    redirect_uri: redirectUri,
    scope: "api",
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  const authUrl = `${MCP_OAUTH_BASE}/authorize?${params.toString()}`;
  console.log("[MCP OAuth] Starting browser flow...");

  // Call Rust backend to open browser and wait for callback
  const callbackResult = await invoke<OAuthCallbackResult>(
    "start_oauth_browser_flow",
    {
      authUrl,
      timeoutSecs: 300, // 5 minute timeout
    },
  );

  console.log("[MCP OAuth] Callback received, state:", callbackResult.state);

  // Verify state
  if (callbackResult.state !== state) {
    throw new Error("State mismatch - possible CSRF attack");
  }

  // Exchange code for tokens
  console.log("[MCP OAuth] Exchanging code for tokens...");
  const tokenResponse = await appFetch(`${MCP_OAUTH_BASE}/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: registration.client_id,
      code: callbackResult.code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }).toString(),
  });

  if (!tokenResponse.ok) {
    const error = await tokenResponse.text();
    throw new Error(`Token exchange failed: ${tokenResponse.status} ${error}`);
  }

  const tokens: TokenResponse = await tokenResponse.json();
  console.log("[MCP OAuth] Tokens received successfully");

  // Store tokens and client ID
  await storeTokens(tokens);
  await storeClientId(registration.client_id);
  cachedClientId = registration.client_id;

  // Clear OAuth state
  currentOAuthState = null;

  return tokens;
}
