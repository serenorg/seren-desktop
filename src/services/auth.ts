// ABOUTME: Authentication service for login, logout, and token management.
// ABOUTME: Wraps the generated seren-core SDK with token storage and rate-limit policy.

import {
  createDefaultOrgApiKey,
  getCurrentUser,
  type LoginResult,
  login as loginSdk,
  refreshToken as refreshTokenSdk,
} from "@/api";
import {
  clearDefaultOrganizationId,
  clearRefreshToken,
  clearToken,
  getRefreshToken,
  getToken,
  storeDefaultOrganizationId,
  storeRefreshToken,
  storeToken,
} from "@/lib/tauri-bridge";
import { clearAuthState, requestSignInModal } from "@/stores/auth.store";

export type { LoginResult };

export interface AuthError {
  message: string;
  code?: string;
}

// Client-side login rate limiting (exponential backoff)
const loginRateLimit = {
  attempts: 0,
  lastAttemptTime: 0,
  backoffMs: 1_000,
};
const MAX_LOGIN_ATTEMPTS = 5;
const BACKOFF_MULTIPLIER = 2;
const MAX_BACKOFF_MS = 30_000;

function checkLoginRateLimit(): void {
  const now = Date.now();
  const elapsed = now - loginRateLimit.lastAttemptTime;

  if (
    loginRateLimit.attempts >= MAX_LOGIN_ATTEMPTS &&
    elapsed < loginRateLimit.backoffMs
  ) {
    const waitSeconds = Math.ceil((loginRateLimit.backoffMs - elapsed) / 1000);
    throw new Error(
      `Too many login attempts. Please wait ${waitSeconds} seconds.`,
    );
  }

  // Reset after sufficient cooldown
  if (elapsed > loginRateLimit.backoffMs * 2) {
    loginRateLimit.attempts = 0;
    loginRateLimit.backoffMs = 1_000;
  }
}

function recordLoginAttempt(success: boolean): void {
  loginRateLimit.attempts++;
  loginRateLimit.lastAttemptTime = Date.now();

  if (success) {
    loginRateLimit.attempts = 0;
    loginRateLimit.backoffMs = 1_000;
  } else {
    loginRateLimit.backoffMs = Math.min(
      loginRateLimit.backoffMs * BACKOFF_MULTIPLIER,
      MAX_BACKOFF_MS,
    );
  }
}

/**
 * Login with email and password.
 * Stores token securely on success.
 * @throws Error on authentication failure or rate limiting
 */
export async function login(
  email: string,
  password: string,
): Promise<LoginResult> {
  checkLoginRateLimit();

  const { data, error, response } = await loginSdk({
    body: { email, password },
    throwOnError: false,
  });

  if (error || !data?.data) {
    recordLoginAttempt(false);
    if (response?.status === 401) {
      throw new Error("Invalid email or password");
    }
    let message = "Authentication failed";
    try {
      const parsed = (await response?.clone().json()) as Partial<AuthError>;
      if (typeof parsed?.message === "string") {
        message = parsed.message;
      }
    } catch {
      // Non-JSON body — fall back to default message.
    }
    throw new Error(message);
  }

  recordLoginAttempt(true);
  await storeToken(data.data.access_token);
  await storeRefreshToken(data.data.refresh_token);
  await storeDefaultOrganizationId(data.data.default_organization_id);
  return data.data;
}

/**
 * Logout and clear stored tokens.
 */
export async function logout(): Promise<void> {
  await clearToken();
  await clearRefreshToken();
  await clearDefaultOrganizationId();
}

/**
 * Refresh the access token using the stored refresh token.
 * @returns true if refresh succeeded, false if refresh token is missing or invalid
 */
export async function refreshAccessToken(): Promise<boolean> {
  const refreshToken = await getRefreshToken();
  if (!refreshToken) {
    clearAuthState();
    requestSignInModal();
    return false;
  }

  try {
    const { data, error, response } = await refreshTokenSdk({
      body: { refresh_token: refreshToken },
      throwOnError: false,
    });

    if (error || !data?.data) {
      // 401: refresh token is invalid, expired, or reused.
      if (response?.status === 401) {
        await clearToken();
        await clearRefreshToken();
        clearAuthState();
        requestSignInModal();
      }
      return false;
    }

    await storeToken(data.data.access_token);
    if (data.data.refresh_token) {
      await storeRefreshToken(data.data.refresh_token);
    }
    return true;
  } catch {
    // Network error - don't clear tokens, don't prompt login
    return false;
  }
}

/**
 * Check if user is logged in (has stored token).
 * Only checks local storage, does not validate with server.
 */
export async function hasStoredToken(): Promise<boolean> {
  const token = await getToken();
  return token !== null;
}

/**
 * Validate token with the server by calling /auth/me.
 * Clears token if invalid/expired.
 * @returns true if token is valid, false otherwise
 */
export async function isLoggedIn(): Promise<boolean> {
  const token = await getToken();
  if (!token) {
    return false;
  }

  try {
    const { data, error } = await getCurrentUser({ throwOnError: false });

    if (data?.data) {
      return true;
    }

    if (error) {
      await clearToken();
    }
    return false;
  } catch {
    // Network error - assume token might still be valid (offline usage).
    return true;
  }
}

/**
 * Get stored authentication token.
 * Returns null if not logged in.
 */
export { getToken };

const DESKTOP_API_KEY_NAME = "Seren Desktop";

/**
 * Create a new API key for MCP authentication.
 * Uses POST /organizations/default/api-keys, which resolves "default" to
 * the user's first organization.
 * @returns API key (seren_xxx_yyy format)
 * @throws Error if not authenticated or request fails
 */
export async function createApiKey(): Promise<string> {
  const { data, error, response } = await createDefaultOrgApiKey({
    body: { name: DESKTOP_API_KEY_NAME },
    throwOnError: false,
  });

  if (error || !data?.data) {
    let message = "Failed to create API key";
    try {
      const parsed = (await response?.clone().json()) as Partial<AuthError>;
      if (typeof parsed?.message === "string") {
        message = parsed.message;
      }
    } catch {
      // Non-JSON body — fall back to default message.
    }
    throw new Error(message);
  }

  return data.data.api_key;
}
